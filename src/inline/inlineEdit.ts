/**
 * Inline edit flow: selection + instruction -> agent turn -> diff review.
 */
export interface InlineEditRequest {
  uri: string;
  selection: { startLine: number; endLine: number };
  instruction: string;
}
