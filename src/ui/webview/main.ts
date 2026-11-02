/** Webview entry: the Agent panel (status line, transcript, composer). Talks to the extension through src/ui/protocol.ts. */
import type { ChatItem, ExtToWeb, RunState, StatusInfo, WebToExt } from "../protocol";
import { renderItem, renderReviewQueue, type RenderHandlers } from "./render";
import "./style.css";

const vscode = acquireVsCodeApi();
const post = (message: WebToExt): void => vscode.postMessage(message);

const STATE_LABEL: Record<RunState, string> = {
  idle: "Ready",
  running: "Working…",
  awaitingApproval: "Waiting for your approval",
  done: "Done",
  error: "Error",
  cancelled: "Stopped",
};

function mount(): void {
  const root = document.getElementById("app");
  if (!root) return;

  const dot = document.createElement("span");
  dot.className = "dot state-idle";
  const statusText = document.createElement("span");
  statusText.className = "status-text";
  const modelText = document.createElement("span");
  modelText.className = "model";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const newChat = document.createElement("button");
  newChat.className = "secondary";
  newChat.textContent = "New chat";
  const undo = document.createElement("button");
  undo.id = "undo";
  undo.className = "secondary";
  undo.textContent = "Undo run";
  undo.title = "Restore every file the agent changed in its last run";
  undo.disabled = true;
  const stop = document.createElement("button");
  stop.id = "stop";
  stop.className = "danger";
  stop.textContent = "Stop";
  stop.disabled = true;
  const bar = document.createElement("header");
  bar.className = "bar";
  bar.append(dot, statusText, modelText, spacer, undo, newChat, stop);

  const queue = document.createElement("div");
  queue.className = "queue";
  queue.hidden = true;

  const transcript = document.createElement("main");
  transcript.className = "transcript";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "Ask Forge about this workspace. It reads files through your editor and shows every tool call here.";

  const input = document.createElement("textarea");
  input.rows = 2;
  input.placeholder = "Ask Forge…  (Enter to send, Shift+Enter for a new line)";
  const send = document.createElement("button");
  send.className = "primary";
  send.textContent = "Send";
  const composer = document.createElement("form");
  composer.className = "composer";
  composer.append(input, send);

  root.append(bar, queue, transcript, composer);

  const elements = new Map<string, HTMLElement>();
  let busy = false;
  let canUndo = false;

  const handlers: RenderHandlers = {
    onApproval: (callId, decision, reason) => post({ type: "approval", callId, decision, ...(reason ? { reason } : {}) }),
    onOpenReview: (callId) => post({ type: "openReview", callId }),
  };

  const nearBottom = (): boolean => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  const refreshEmpty = (): void => {
    if (elements.size === 0) {
      if (!empty.isConnected) transcript.appendChild(empty);
    } else if (empty.isConnected) {
      empty.remove();
    }
  };
  const refreshControls = (): void => {
    send.disabled = busy;
    stop.disabled = !busy;
    undo.disabled = busy || !canUndo;
  };

  const upsert = (items: readonly ChatItem[]): void => {
    const stick = nearBottom();
    for (const item of items) {
      const previous = elements.get(item.id);
      const next = renderItem(item, handlers, previous);
      if (previous?.isConnected) previous.replaceWith(next);
      else transcript.appendChild(next);
      elements.set(item.id, next);
    }
    refreshEmpty();
    if (stick) transcript.scrollTop = transcript.scrollHeight;
  };

  const setStatus = (status: StatusInfo): void => {
    busy = status.state === "running" || status.state === "awaitingApproval";
    canUndo = status.canUndo === true;
    dot.className = `dot state-${status.state}`;
    const label = status.compacting ? "Compacting context…" : STATE_LABEL[status.state];
    statusText.textContent = status.detail && (status.state === "error" || status.state === "cancelled") ? `${label}: ${status.detail}` : label;
    modelText.textContent = status.model ? status.model : "";
    refreshControls();
  };

  const reset = (): void => {
    for (const node of elements.values()) node.remove();
    elements.clear();
    refreshEmpty();
  };

  window.addEventListener("message", (event: MessageEvent<ExtToWeb>) => {
    const message = event.data;
    switch (message.type) {
      case "init":
        reset();
        upsert(message.items);
        setStatus(message.status);
        transcript.scrollTop = transcript.scrollHeight;
        break;
      case "upsert":
        upsert(message.items);
        break;
      case "status":
        setStatus(message.status);
        break;
      case "review": {
        queue.replaceChildren();
        queue.hidden = message.entries.length === 0;
        if (message.entries.length > 0) queue.appendChild(renderReviewQueue(message.entries, handlers));
        break;
      }
      case "reset":
        reset();
        break;
    }
  });

  const submit = (): void => {
    const text = input.value.trim();
    if (text === "" || busy) return;
    post({ type: "send", text });
    input.value = "";
  };
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  stop.addEventListener("click", () => post({ type: "stop" }));
  newChat.addEventListener("click", () => post({ type: "newChat" }));
  undo.addEventListener("click", () => post({ type: "undoRun" }));

  refreshEmpty();
  refreshControls();
  post({ type: "ready" });
}

mount();
