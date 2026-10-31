/** Webview entry: renders the minimal "Forge ready" panel with a disabled Stop button. */
import "./style.css";

function render(root: HTMLElement): void {
  const status = document.createElement("p");
  status.className = "status";
  status.textContent = "Forge ready";

  const stop = document.createElement("button");
  stop.id = "stop";
  stop.textContent = "Stop";
  stop.disabled = true;

  root.append(status, stop);
}

const root = document.getElementById("app");
if (root) render(root);
