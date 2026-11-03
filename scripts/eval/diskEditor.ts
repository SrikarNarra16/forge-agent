import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HostError } from "../../src/mcp/host";
import { applyAccepted, type ApplyIo } from "../../src/review/applyCore";
import type { CheckpointStore } from "../../src/review/checkpoints";
import { applyRangedEdits } from "../../src/review/hunks";
import type { ReviewEditor, ReviewHandle, ReviewPresenter } from "../../src/review/reviewHandler";
import type { ReviewSession } from "../../src/review/session";

/**
 * Eval-only writers. src/ keeps its write-isolation rule (only the VS Code applier writes); the harness applies
 * accepted hunks to a TEMP COPY of Flask on disk, through the same applyAccepted ordering rules as the product.
 */
export function diskIo(root: string): ApplyIo {
  return {
    async readLive(path) {
      try {
        return await readFile(join(root, path), "utf8");
      } catch {
        return undefined;
      }
    },
    async write(req) {
      const full = join(root, req.path);
      if (req.kind === "create") {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, req.newText, "utf8");
      } else {
        await writeFile(full, applyRangedEdits(await readFile(full, "utf8"), req.edits), "utf8");
      }
    },
  };
}

export function diskReviewEditor(root: string, checkpoints: CheckpointStore): ReviewEditor {
  const io = diskIo(root);
  return {
    rootPath: () => Promise.resolve(root),
    async readText(p) {
      const text = await io.readLive(p);
      if (text === undefined) throw new HostError("ENOENT", p);
      return text;
    },
    apply: (req) => applyAccepted(io, checkpoints, req),
  };
}

export type AcceptMode = "all" | "first-only";

/** Decides a review the way a user would: accept every hunk, or only the first hunk of each file and reject the rest. */
export function decide(session: ReviewSession, mode: AcceptMode): void {
  if (mode === "all" || session.hunks.length <= 1) {
    session.acceptAll();
  } else {
    session.hunks.forEach((h, i) => (i === 0 ? session.accept(h.id) : session.reject(h.id)));
  }
  session.apply();
}

export function autoPresenter(mode: AcceptMode, onPresent?: (session: ReviewSession) => void): ReviewPresenter {
  return {
    present(session): ReviewHandle {
      onPresent?.(session);
      const timer = setTimeout(() => decide(session, mode), 10);
      return { close: () => clearTimeout(timer) };
    },
  };
}
