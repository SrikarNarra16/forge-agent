/**
 * Async, cancellable, .gitignore-aware workspace indexer producing symbol chunks.
 */
export interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}
