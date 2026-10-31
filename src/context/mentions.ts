/**
 * Parses and resolves @file / @symbol mentions into pinned context blocks.
 */
export interface Mention {
  kind: 'file' | 'symbol';
  value: string;
}
