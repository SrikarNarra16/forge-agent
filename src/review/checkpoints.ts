/**
 * Checkpoints: before the first write to a file during a run (one user request), remember what it looked
 * like (its text, or "did not exist"). `rollbackRun` puts everything back; files the run created are deleted.
 * Callable from P09's cancel logic. Pure: the actual restoring is done by an injected FileRestorer.
 */
export type Snapshot = { existed: false } | { existed: true; text: string };

export interface FileRestorer {
  /**
   * Put `text` back. `expectedCurrentHash` is the hash of the text Forge last wrote, so the restorer can
   * warn when the user changed the file since.
   */
  restoreText(path: string, text: string, expectedCurrentHash: string | undefined): Promise<void>;
  /** Delete a file the run created. `expectedCurrentHash` lets the restorer warn if the user edited it since. */
  deleteFile(path: string, expectedCurrentHash: string | undefined): Promise<void>;
}

export interface RollbackResult {
  /** Paths that were restored (or deleted, for files the run created). */
  restored: string[];
  failed: Array<{ path: string; error: string }>;
}

interface Entry {
  snapshot: Snapshot;
  /** Hash of the text Forge wrote last, if any. */
  appliedHash?: string;
}

export class CheckpointStore {
  private readonly runs = new Map<string, Map<string, Entry>>();
  private readonly listeners = new Set<() => void>();

  /** First write wins: later snapshots of the same path in the same run are ignored. */
  snapshot(runId: string, path: string, snapshot: Snapshot): void {
    const run = this.runs.get(runId) ?? new Map<string, Entry>();
    if (!run.has(path)) run.set(path, { snapshot });
    this.runs.set(runId, run);
    this.emit();
  }

  recordApplied(runId: string, path: string, appliedHash: string): void {
    const entry = this.runs.get(runId)?.get(path);
    if (entry) entry.appliedHash = appliedHash;
  }

  has(runId: string): boolean {
    return (this.runs.get(runId)?.size ?? 0) > 0;
  }

  filesOf(runId: string): string[] {
    return [...(this.runs.get(runId)?.keys() ?? [])];
  }

  snapshotOf(runId: string, path: string): Snapshot | undefined {
    return this.runs.get(runId)?.get(path)?.snapshot;
  }

  /** The most recent run that changed something and has not been rolled back. */
  lastRunId(): string | undefined {
    const ids = [...this.runs.keys()].filter((id) => this.has(id));
    return ids[ids.length - 1];
  }

  get canUndo(): boolean {
    return this.lastRunId() !== undefined;
  }

  /**
   * Restores every file touched by the run (newest change first). A file that cannot be restored is
   * reported in `failed` and stays in the checkpoint so the user can retry; the others are not blocked.
   */
  async rollbackRun(runId: string, restorer: FileRestorer): Promise<RollbackResult> {
    const run = this.runs.get(runId);
    const result: RollbackResult = { restored: [], failed: [] };
    if (!run) return result;
    for (const [path, entry] of [...run.entries()].reverse()) {
      try {
        if (entry.snapshot.existed) await restorer.restoreText(path, entry.snapshot.text, entry.appliedHash);
        else await restorer.deleteFile(path, entry.appliedHash);
        run.delete(path);
        result.restored.push(path);
      } catch (err) {
        result.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (run.size === 0) this.runs.delete(runId);
    this.emit();
    return result;
  }

  clear(): void {
    this.runs.clear();
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
