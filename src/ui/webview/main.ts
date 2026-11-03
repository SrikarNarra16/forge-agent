/** Webview entry: the Agent panel (status line, transcript, composer). Talks to the extension through src/ui/protocol.ts. */
import type { ChatItem, ExtToWeb, MentionRef, MentionSuggestionInfo, RunState, StatusInfo, WebToExt } from "../protocol";
import { hasContext } from "./contextModel";
import { renderContext } from "./contextView";
import { findMentionTrigger, type MentionTrigger } from "./mention";
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
  cancelling: "Stopping…",
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

  const contextBox = document.createElement("div");
  contextBox.className = "context-box";
  contextBox.hidden = true;

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
  const chipRow = document.createElement("div");
  chipRow.className = "chips";
  chipRow.hidden = true;
  const suggestions = document.createElement("ul");
  suggestions.className = "suggestions";
  suggestions.hidden = true;
  suggestions.setAttribute("role", "listbox");
  const field = document.createElement("div");
  field.className = "field";
  field.append(chipRow, input, suggestions);
  const composer = document.createElement("form");
  composer.className = "composer";
  composer.append(field, send);

  root.append(bar, queue, contextBox, transcript, composer);

  const elements = new Map<string, HTMLElement>();
  let busy = false;
  let stopping = false;
  let canUndo = false;

  const handlers: RenderHandlers = {
    onApproval: (callId, decision, reason, allowThisRun) => post({ type: "approval", callId, decision, ...(reason ? { reason } : {}), ...(allowThisRun ? { allowThisRun } : {}) }),
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
    stop.disabled = !busy || stopping;
    undo.disabled = busy || !canUndo;
  };

  const upsert = (items: readonly ChatItem[]): void => {
    const stick = nearBottom();
    for (const item of items) {
      const previous = elements.get(item.id);
      const next = renderItem(item, handlers, previous);
      if (previous?.isConnected) previous.replaceWith(next);
      else {
        // items of a subagent thread live inside that subagent's block
        const thread = "thread" in item ? item.thread : undefined;
        const parent = thread ? Array.from(transcript.querySelectorAll<HTMLElement>("details.subagent")).find((d) => d.dataset["thread"] === thread)?.querySelector(".subagent-body") : null;
        (parent ?? transcript).appendChild(next);
      }
      elements.set(item.id, next);
    }
    refreshEmpty();
    if (stick) transcript.scrollTop = transcript.scrollHeight;
  };

  const setStatus = (status: StatusInfo): void => {
    busy = status.state === "running" || status.state === "awaitingApproval" || status.state === "cancelling";
    stopping = status.state === "cancelling";
    canUndo = status.canUndo === true;
    dot.className = `dot state-${status.state}`;
    const label = status.compacting ? "Compacting context…" : STATE_LABEL[status.state];
    statusText.textContent = status.detail && (status.state === "error" || status.state === "cancelled") ? `${label}: ${status.detail}` : label;
    modelText.textContent = status.model ? status.model : "";
    refreshControls();
  };

  let contextElement: HTMLElement | undefined;
  const showContext = (state: Parameters<typeof renderContext>[0]): void => {
    contextBox.hidden = !hasContext(state);
    const next = renderContext(state, contextElement);
    if (contextElement?.isConnected) contextElement.replaceWith(next);
    else contextBox.appendChild(next);
    contextElement = next;
  };

  // --- @mentions: chips above the box, a suggestion list under the caret ---------------------------------
  const chips: MentionRef[] = [];
  let trigger: MentionTrigger | undefined;
  let shown: MentionSuggestionInfo[] = [];
  let active = 0;
  let queryId = 0;
  const renderChips = (): void => {
    chipRow.replaceChildren();
    chipRow.hidden = chips.length === 0;
    for (const [i, chip] of chips.entries()) {
      const node = document.createElement("span");
      node.className = "chip";
      node.textContent = `@${chip.kind === "symbol" ? "#" : ""}${chip.value}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-x";
      remove.textContent = "×";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        chips.splice(i, 1);
        renderChips();
        input.focus();
      });
      node.appendChild(remove);
      chipRow.appendChild(node);
    }
  };
  const closeSuggestions = (): void => {
    trigger = undefined;
    shown = [];
    suggestions.hidden = true;
    suggestions.replaceChildren();
  };
  const paintSuggestions = (): void => {
    suggestions.replaceChildren();
    suggestions.hidden = shown.length === 0;
    for (const [i, s] of shown.entries()) {
      const li = document.createElement("li");
      li.className = i === active ? "active" : "";
      li.setAttribute("role", "option");
      const name = document.createElement("span");
      name.textContent = s.value;
      li.appendChild(name);
      if (s.detail) {
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = s.detail;
        li.appendChild(detail);
      }
      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in the textarea
        choose(i);
      });
      suggestions.appendChild(li);
    }
  };
  const showSuggestions = (results: MentionSuggestionInfo[]): void => {
    if (!trigger) return;
    shown = results;
    active = 0;
    paintSuggestions();
  };
  const choose = (i: number): void => {
    const pick = shown[i];
    if (!pick || !trigger) return;
    if (!chips.some((c) => c.kind === pick.kind && c.value === pick.value)) chips.push({ kind: pick.kind, value: pick.value });
    const caret = input.selectionStart;
    input.value = `${input.value.slice(0, trigger.start)}${input.value.slice(caret)}`;
    input.setSelectionRange(trigger.start, trigger.start);
    closeSuggestions();
    renderChips();
    input.focus();
  };
  const onInput = (): void => {
    trigger = findMentionTrigger(input.value, input.selectionStart);
    if (!trigger) {
      closeSuggestions();
      return;
    }
    queryId += 1;
    post({ type: "mentionQuery", id: queryId, kind: trigger.kind, query: trigger.query });
  };
  input.addEventListener("input", onInput);
  input.addEventListener("blur", closeSuggestions);

  const reset = (): void => {
    chips.length = 0;
    renderChips();
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
      case "context":
        showContext(message.state);
        break;
      case "mentionResults":
        if (message.id === queryId) showSuggestions(message.results);
        break;
      case "reset":
        reset();
        showContext({ reads: [], expand: false });
        break;
    }
  });

  const submit = (): void => {
    const text = input.value.trim();
    if (text === "" || busy) return;
    post({ type: "send", text, ...(chips.length > 0 ? { mentions: [...chips] } : {}) });
    input.value = "";
    chips.length = 0;
    renderChips();
    closeSuggestions();
  };
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener("keydown", (e) => {
    if (!suggestions.hidden && shown.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
        paintSuggestions();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSuggestions();
        return;
      }
    }
    if (e.key === "Backspace" && chips.length > 0 && input.selectionStart === 0 && input.selectionEnd === 0) {
      e.preventDefault();
      chips.pop();
      renderChips();
      return;
    }
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
