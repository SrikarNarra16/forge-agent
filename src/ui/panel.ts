import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/**
 * Webview view provider for the Forge agent panel (forge.agentView).
 * Serves a CSP-locked page (nonce'd script, external stylesheet) that loads dist/webview.js.
 */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "forge.agentView";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = this.renderHtml(view.webview, distUri);
  }

  private renderHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style.toString()}">
  <title>Forge</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
