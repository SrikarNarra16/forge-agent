/**
 * Per-run snapshots of original file contents for Undo last agent run and rollback on cancel.
 */
export interface Checkpoint {
  runId: string;
  files: ReadonlyMap<string, string>;
}
