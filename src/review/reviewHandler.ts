import type { ApprovalDecision, ApprovalHandler, PendingToolCall } from "../trueforge/agentController";
import type { DecisionStore, EditDecision } from "../mcp/decisions";
import { HostError } from "../mcp/host";
import { explainHostError, resolveWorkspacePath } from "../mcp/tools/common";
import { keyForCall, parseEditArgs, type EditToolName } from "../mcp/tools/editTools";
import { ConflictError, type ApplyRequest } from "./applyCore";
import { hashText } from "./hash";
import { ReviewTooLargeError, applyEdits, hunkEdits, hunkSummary } from "./hunks";
import { ReviewSession } from "./session";
import type { ReviewTracker } from "./tracker";

/**
 * ReviewApprovalHandler: the ApprovalHandler for propose_edit / create_file. For each gated call it builds
 * a proposal against the CURRENT buffer text, lets the user review it hunk by hunk, applies the accepted
 * hunks itself (the tools never write), records a decision for the tool to report, and answers TrueForge
 * with allow (something was applied) or deny + a reason the agent can act on.
 *
 * Several calls are decided concurrently: proposals for different files are all reviewable at once;
 * proposals for the SAME path are serialised, and the later one is computed after the earlier one has been
 * applied (against the new text). Pure and vscode-free; the editor and the diff UI are injected.
 */

export interface ReviewEditor {
  rootPath(): Promise<string>;
  /** Current text of an existing file (open buffer, else disk). Throws HostError (ENOENT, EISDIR, ...). */
  readText(path: string): Promise<string>;
  /** Writes the accepted result. Throws ConflictError when the file no longer matches the review's base. */
  apply(request: ApplyRequest): Promise<void>;
}

export interface ReviewHandle {
  close(): void;
}

export interface ReviewPresenter {
  /** Shows the review for a session (diff, lenses...). `autoOpen` is true for the first review in the queue. */
  present(session: ReviewSession, options: { autoOpen: boolean }): ReviewHandle;
}

export class ReviewCancelled extends Error {
  constructor() {
    super("Review cancelled");
    this.name = "ReviewCancelled";
  }
}

/** Serialises work per key; waiters can be abandoned through an AbortSignal. */
export class PathLocks {
  private readonly held = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  acquire(path: string, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new ReviewCancelled());
        return;
      }
      const grant = (): void => {
        this.held.add(path);
        resolve(() => this.release(path));
      };
      if (!this.held.has(path)) {
        grant();
        return;
      }
      const queue = this.waiters.get(path) ?? [];
      const entry = (): void => {
        signal.removeEventListener("abort", onAbort);
        grant();
      };
      const onAbort = (): void => {
        const at = queue.indexOf(entry);
        if (at !== -1) queue.splice(at, 1);
        reject(new ReviewCancelled());
      };
      queue.push(entry);
      this.waiters.set(path, queue);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(path: string): void {
    const next = this.waiters.get(path)?.shift();
    if (next) {
      next(); // hands the lock straight to the next waiter
      return;
    }
    this.held.delete(path);
    this.waiters.delete(path);
  }
}

export interface ReviewDeps {
  editor: ReviewEditor;
  presenter: ReviewPresenter;
  decisions: DecisionStore;
  tracker: ReviewTracker;
  /** Id of the current run (one user request), for checkpoints. */
  getRunId: () => string;
  log?: (message: string) => void;
}

const deny = (reason: string): ApprovalDecision => ({ status: "deny", reason });
const ALLOW: ApprovalDecision = { status: "allow" };

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export class ReviewApprovalHandler implements ApprovalHandler {
  private readonly locks = new PathLocks();
  private open = 0;

  constructor(private readonly deps: ReviewDeps) {}

  async decide(call: PendingToolCall, signal: AbortSignal): Promise<ApprovalDecision> {
    const { editor, tracker } = this.deps;
    if (call.name !== "propose_edit" && call.name !== "create_file") return deny(`Forge cannot review calls to ${call.name}.`);
    const tool: EditToolName = call.name;

    const parsed = parseEditArgs(tool, call.args);
    if (!parsed.ok) return deny(parsed.error);

    const root = await editor.rootPath();
    const target = resolveWorkspacePath(root, parsed.args.path, { allowRoot: false });
    if (!target.ok) return deny(target.message);
    const rel = target.rel;

    const summary = parsed.args.summary.trim();
    tracker.add({ callId: call.id, path: rel, kind: tool === "create_file" ? "create" : "edit", summary, state: "queued" });
    const fail = (message: string): ApprovalDecision => {
      tracker.update(call.id, { state: "failed", detail: message });
      return deny(message);
    };

    let release: () => void;
    try {
      release = await this.locks.acquire(rel, signal);
    } catch (err) {
      tracker.update(call.id, { state: "cancelled" });
      throw err;
    }
    try {
      return await this.review(call, tool, parsed, rel, summary, signal, fail);
    } finally {
      release();
    }
  }

  private async review(
    call: PendingToolCall,
    tool: EditToolName,
    parsed: Extract<ReturnType<typeof parseEditArgs>, { ok: true }>,
    rel: string,
    summary: string,
    signal: AbortSignal,
    fail: (message: string) => ApprovalDecision,
  ): Promise<ApprovalDecision> {
    const { editor, presenter, decisions, tracker } = this.deps;

    // 1. the proposal, computed against the CURRENT text (after any earlier review of the same file was applied)
    let original = "";
    let proposed: string;
    if (parsed.tool === "create_file") {
      try {
        await editor.readText(rel);
        return fail(`${rel} already exists. create_file only makes new files; use propose_edit to change an existing file.`);
      } catch (err) {
        if (!(err instanceof HostError && err.code === "ENOENT")) {
          const teaching = explainHostError(err, rel);
          return fail(teaching ?? `Could not check ${rel}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (parsed.args.content === "") return fail("create_file needs non-empty `content`.");
      proposed = parsed.args.content;
    } else {
      try {
        original = await editor.readText(rel);
      } catch (err) {
        if (err instanceof HostError && err.code === "ENOENT") {
          return fail(`File not found: ${rel}. propose_edit only changes existing files; use create_file for a new file, or list_dir / search_code (kind=path) to find the right path.`);
        }
        return fail(explainHostError(err, rel) ?? `Could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const applied = applyEdits(original, parsed.args.edits, rel);
      if (!applied.ok) return fail(applied.error);
      proposed = applied.text;
    }

    let session: ReviewSession;
    try {
      session = new ReviewSession({ callId: call.id, path: rel, kind: tool === "create_file" ? "create" : "edit", summary, original, proposed });
    } catch (err) {
      return fail(err instanceof ReviewTooLargeError ? err.message : `Could not prepare the review: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. the review
    if (signal.aborted) {
      tracker.update(call.id, { state: "cancelled" });
      throw new ReviewCancelled();
    }
    tracker.update(call.id, { state: "reviewing", hunks: session.hunks.length });
    const onAbort = (): void => session.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    let handle: { close(): void } | undefined;
    try {
      handle = presenter.present(session, { autoOpen: this.open === 0 });
    } catch (err) {
      signal.removeEventListener("abort", onAbort);
      return fail(`Could not open the review: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.open++;
    let result;
    try {
      result = await session.done;
    } finally {
      this.open--;
      signal.removeEventListener("abort", onAbort);
      handle.close();
    }

    if (result.kind === "cancelled") {
      tracker.update(call.id, { state: "cancelled" });
      this.deps.log?.(`review of ${rel} cancelled`);
      throw new ReviewCancelled();
    }
    if (result.kind === "rejected-all") {
      tracker.update(call.id, { state: "rejected", applied: 0, detail: "rejected" });
      this.deps.log?.(`review of ${rel}: rejected`);
      return deny(`User rejected all changes to ${rel}`);
    }

    // 3. apply the accepted hunks (the only write), then record what happened for the tool to report
    const stats = session.acceptedStats();
    const request: ApplyRequest = {
      runId: this.deps.getRunId(),
      path: rel,
      kind: tool === "create_file" ? "create" : "edit",
      ...(tool === "create_file" ? {} : { baseHash: hashText(original) }),
      newText: session.composed(),
      edits: hunkEdits(session.hunks, result.accepted),
    };
    try {
      await editor.apply(request);
    } catch (err) {
      if (err instanceof ConflictError) {
        return fail(`${rel} changed while you were reviewing, so nothing was written. Re-read it with read_file and propose the change again.`);
      }
      return fail(`Could not write the change to ${rel}: ${err instanceof Error ? err.message : String(err)}. Nothing was applied.`);
    }

    const accepted = new Set(result.accepted);
    const decision: EditDecision = {
      path: rel,
      kind: tool === "create_file" ? "create" : "edit",
      applied: result.accepted.length,
      total: session.hunks.length,
      added: tool === "create_file" ? lineCount(proposed) : stats.added,
      removed: stats.removed,
      rejected: session.hunks.filter((h) => !accepted.has(h.id)).map((h) => `${hunkSummary(h)}${session.decisionList[h.id] === "pending" ? " (undecided)" : ""}`),
    };
    const key = keyForCall(tool, call.args);
    if (key) decisions.put(key, decision);
    tracker.update(call.id, { state: "applied", applied: decision.applied, hunks: decision.total });
    this.deps.log?.(`review of ${rel}: applied ${decision.applied} of ${decision.total}`);
    return ALLOW;
  }
}
