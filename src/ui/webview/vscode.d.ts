/** The VS Code webview API object injected into the page. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
