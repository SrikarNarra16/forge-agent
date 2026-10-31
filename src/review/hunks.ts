/**
 * Hunk model built from jsdiff structuredPatch; accept/reject state and composing the final text.
 */
export interface Hunk {
  id: number;
  accepted: boolean;
}
