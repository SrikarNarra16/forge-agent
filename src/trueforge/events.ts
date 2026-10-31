/**
 * Typed view over TrueForge stream events (model.message, tool.approval_required, turn.done, ...) used by the controller and the webview.
 */
export type TurnStatus = 'done' | 'cancelled' | 'error' | 'paused';
