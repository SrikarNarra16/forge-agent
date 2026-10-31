import { EventEmitter } from "node:events";

/**
 * vscode-free event bus for the MCP tools. The UI subscribes later (context panel); tools only emit.
 * `context:read` fires for every successful read_file call.
 */
export interface ContextReadEvent {
  path: string;
  start: number;
  end: number;
  /** The agent's one-sentence reason for reading. */
  why: string;
  /** Estimated tokens of the text returned to the agent. */
  tokens: number;
}

interface McpEventMap {
  "context:read": [ContextReadEvent];
}

export class McpEvents extends EventEmitter<McpEventMap> {
  /** Subscribe to read_file events; returns an unsubscribe function. */
  onContextRead(listener: (event: ContextReadEvent) => void): () => void {
    this.on("context:read", listener);
    return () => {
      this.off("context:read", listener);
    };
  }
}
