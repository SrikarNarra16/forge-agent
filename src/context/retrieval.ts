/**
 * Automatic retrieval before each user turn: query -> top-k chunks -> Relevant locations within the budget.
 */
export interface RetrievedItem {
  path: string;
  reason: string;
  tokens: number;
}
