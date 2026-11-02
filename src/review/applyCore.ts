import { hashText } from "./hash";
import type { CheckpointStore } from "./checkpoints";
import type { RangedEdit } from "./hunks";

/**
 * The ordering rules of an apply, free of the VS Code API so they can be tested:
 *   1. read the LIVE text and verify it is still the text the review was computed on (else ConflictError),
 *   2. snapshot a checkpoint BEFORE writing,
 *   3. write (the vscode applier does this in ONE WorkspaceEdit, a single undo step, then saves),
 *   4. record the hash of what was written (so Undo can warn if the user changed the file since).
 */
export interface ApplyRequest {
  runId: string;
  path: string;
  kind: "edit" | "create";
  /** Hash of the text the review was computed on (edits only). */
  baseHash?: string;
  /** The text the file will have afterwards. */
  newText: string;
  /** Per-hunk edits in original line coordinates (edits only). */
  edits: RangedEdit[];
}

export interface ApplyIo {
  /** Live text (open buffer, else disk), or undefined when the file does not exist. */
  readLive(path: string): Promise<string | undefined>;
  /** Writes the request and saves. The only place that changes files. */
  write(request: ApplyRequest): Promise<void>;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export async function applyAccepted(io: ApplyIo, checkpoints: CheckpointStore, request: ApplyRequest): Promise<void> {
  const live = await io.readLive(request.path);
  if (request.kind === "edit") {
    if (live === undefined) throw new ConflictError(`${request.path} no longer exists`);
    if (request.baseHash === undefined || hashText(live) !== request.baseHash) throw new ConflictError(`${request.path} changed while it was being reviewed`);
  } else if (live !== undefined) {
    throw new ConflictError(`${request.path} now exists`);
  }
  checkpoints.snapshot(request.runId, request.path, live === undefined ? { existed: false } : { existed: true, text: live });
  await io.write(request);
  checkpoints.recordApplied(request.runId, request.path, hashText(request.newText));
}
