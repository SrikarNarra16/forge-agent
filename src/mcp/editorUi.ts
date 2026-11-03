/** Read-only UI actions the extras server may trigger in the editor. */
export interface EditorUi {
  /** Reveals a file (and line) in the editor without changing it. */
  reveal(path: string, line?: number): Promise<void>;
}
