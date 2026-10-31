/**
 * Applies accepted hunks atomically via WorkspaceEdit (single undo step) and saves.
 */
export interface ApplyResult {
  applied: number;
  rejected: number;
}
