/**
 * BM25 ranking over identifier-tokenised chunks (snake/camel split).
 */
export interface ScoredChunk {
  chunkIndex: number;
  score: number;
}
