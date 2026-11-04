import { ConflictError } from "./applyCore";
import { hashText } from "./hash";
import type { RangedEdit } from "./hunks";

/**
 * The decision logic of an edit to an existing file, free of the VS Code API so it can be tested. The document
 * operations are injected as a port; the VS Code implementation (src/review/applier.ts, the only file that touches
 * the editor's write APIs) opens the document INSIDE each port call and never keeps a reference across an await.
 *
 * Why it exists (found by the e2e suite, reproduced 10 of 10 without a model): the diff editor of the review is
 * closed while the apply runs. When it was the last editor showing the file, VS Code disposes the document during
 * `applyEdit`, so the following `save()` on the old object fails with "Document has been closed" and, worse, the new
 * text stays behind as an unsaved buffer. So a closed-document error means "the edit may or may not have landed":
 * re-open, look at the live text, and decide:
 *   live text == the text we expected before the edit -> retry the edit once;
 *   live text == the new text                        -> the edit landed, only save it;
 *   anything else                                    -> the file changed meanwhile: abort (ConflictError), write nothing.
 * If the retry fails too, the base text is put back, so a failed apply leaves nothing half-applied.
 */
export interface EditPort {
  /** Opens the document now and returns its live text. */
  readText(): Promise<string>;
  /** Opens the document now and applies the edits to it as ONE edit (one undo step). false = VS Code refused. */
  replaceRanges(edits: RangedEdit[]): Promise<boolean>;
  /** Opens the document now and replaces its whole text (only used to put the base text back). */
  replaceAll(text: string): Promise<boolean>;
  /** Opens the document now and saves it. false = not saved. */
  persist(): Promise<boolean>;
}

export interface EditRequest {
  path: string;
  baseHash: string;
  newText: string;
  edits: RangedEdit[];
}

/** The error VS Code raises when a document object was disposed under us. */
export function isClosedDocumentError(err: unknown): boolean {
  return /document has been closed|document is closed|has been disposed|document was closed/i.test(err instanceof Error ? err.message : String(err));
}

export async function applyExistingFile(port: EditPort, request: EditRequest, log: (message: string) => void = () => undefined): Promise<void> {
  const newHash = hashText(request.newText);
  let baseText: string | undefined;
  let failure: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) {
        // Re-verify after re-opening: what is in the document now decides what is safe to do.
        const live = await port.readText();
        const liveHash = hashText(live);
        if (liveHash === newHash) {
          log(`apply of ${request.path}: the edit had already landed in the document; saving it`);
          await persist(port, request.path);
          return;
        }
        if (liveHash !== request.baseHash) throw new ConflictError(`${request.path} changed while it was being reviewed`);
        baseText = live;
      } else {
        baseText = await port.readText(); // kept (a string, not a document) to be able to put it back
      }
      if (!(await port.replaceRanges(request.edits))) throw new Error(`VS Code rejected the edit to ${request.path}`);
      await persist(port, request.path);
      return;
    } catch (err) {
      if (err instanceof ConflictError) throw err; // the file changed: nothing was applied by us, nothing to put back
      if (attempt === 1 && isClosedDocumentError(err)) {
        log(`apply of ${request.path}: the document was closed during the edit (${err instanceof Error ? err.message : String(err)}); re-opening and retrying once`);
        continue;
      }
      failure = err;
      break;
    }
  }

  // Failed for good. Whatever landed in the document is taken back, so the file and the buffer match what they were.
  await putBaseBack(port, request, baseText, log);
  throw failure instanceof Error ? failure : new Error(String(failure));
}

async function persist(port: EditPort, path: string): Promise<void> {
  if (!(await port.persist())) throw new Error(`${path} was changed but could not be saved`);
}

async function putBaseBack(port: EditPort, request: EditRequest, baseText: string | undefined, log: (message: string) => void): Promise<void> {
  if (baseText === undefined) return;
  try {
    const live = await port.readText();
    if (hashText(live) === request.baseHash) return; // untouched
    if (hashText(live) !== hashText(request.newText)) return; // someone else's text: never overwrite it
    log(`apply of ${request.path} failed after the edit landed in the document: putting the original text back`);
    if (await port.replaceAll(baseText)) await port.persist();
  } catch (err) {
    log(`could not put the original text of ${request.path} back: ${err instanceof Error ? err.message : String(err)}`);
  }
}
