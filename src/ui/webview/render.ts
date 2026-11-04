import type { ChatItem, ReviewItemInfo, ReviewQueueEntry } from "../protocol";
import { autoAllowBadge, commandCardModel, reviewDecisions, reviewHeader, reviewOutcomeLine, reviewStatusLine, reviewUndecidedNote, toolCardModel } from "./format";
import { parseMarkdown, type Block, type Inline } from "./markdown";

/**
 * DOM rendering for the Agent panel. Everything is built with createElement and textContent; nothing
 * derived from model output is ever parsed as HTML (a test scans this directory for innerHTML and friends).
 */

export interface RenderHandlers {
  onApproval(callId: string, decision: "allow" | "deny", reason?: string, allowThisRun?: boolean): void;
  onOpenReview(callId: string): void;
  /** "Apply accepted" / "Reject all" in the review queue. */
  onReviewApply(callId: string): void;
  onReviewAcceptAllApply(callId: string): void;
  onReviewRejectAll(callId: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInline(parent: Node, inline: readonly Inline[]): void {
  for (const part of inline) {
    if (part.t === "text") parent.appendChild(document.createTextNode(part.text));
    else if (part.t === "code") parent.appendChild(el("code", "inline-code", part.text));
    else {
      const strong = el("strong");
      renderInline(strong, part.children);
      parent.appendChild(strong);
    }
  }
}

function renderBlock(block: Block): HTMLElement {
  switch (block.t) {
    case "p": {
      const p = el("p");
      renderInline(p, block.inline);
      return p;
    }
    case "code": {
      const pre = el("pre", block.closed ? "code-block" : "code-block open-fence");
      if (block.lang) pre.dataset["lang"] = block.lang;
      pre.appendChild(el("code", undefined, block.text));
      return pre;
    }
    case "ul":
    case "ol": {
      const list = el(block.t);
      for (const item of block.items) {
        const li = el("li");
        renderInline(li, item);
        list.appendChild(li);
      }
      return list;
    }
  }
}

export function renderMarkdown(src: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(src)) fragment.appendChild(renderBlock(block));
  return fragment;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STATUS_GLYPH = { running: "…", awaiting_approval: "?", done: "✓", denied: "✕" } as const;

function renderTool(item: Extract<ChatItem, { kind: "tool" }>, handlers: RenderHandlers, previous: HTMLElement | undefined): HTMLElement {
  const details = el("details", `item tool status-${item.status}`);
  details.dataset["id"] = item.id;
  const wasOpen = previous instanceof HTMLDetailsElement && previous.open;
  details.open = wasOpen || item.approval === "pending";

  const summary = el("summary");
  summary.appendChild(el("span", "glyph", STATUS_GLYPH[item.status]));
  summary.appendChild(el("span", "tool-name", item.name));
  if (item.subagent) summary.appendChild(el("span", "badge", item.subagent));
  const model = toolCardModel(item);
  summary.appendChild(el("span", "tool-args", model.headline));
  const meta = item.review
    ? reviewStateLabel(item.review)
    : item.status === "awaiting_approval"
      ? "needs approval"
      : item.durationMs !== undefined
        ? formatDuration(item.durationMs)
        : item.status === "running"
          ? "running"
          : "";
  const badge = autoAllowBadge(item);
  if (badge) summary.appendChild(el("span", "badge auto-allowed", badge));
  if (meta) summary.appendChild(el("span", "tool-meta", meta));
  details.appendChild(summary);

  const body = el("div", "tool-body");
  const command = commandCardModel(item);
  if (command) {
    body.appendChild(el("div", "label", "Command"));
    body.appendChild(el("pre", "command", command.command));
  }
  if (model.inlineArgs !== undefined && !command) {
    body.appendChild(el("div", "label", "Arguments"));
    body.appendChild(el("pre", "args", model.inlineArgs));
  }
  if (item.resultPreview !== undefined) {
    body.appendChild(el("div", "label", "Result"));
    body.appendChild(el("pre", "result", item.resultPreview));
  }
  if (item.review) {
    body.appendChild(renderReviewRow(item.id, item.review, handlers));
    if (model.detailsArgs !== undefined) {
      // Raw arguments stay available but collapsed: the card is about the file and the change, not JSON.
      const details = el("details", "raw-details");
      details.appendChild(el("summary", undefined, "Details"));
      details.appendChild(el("pre", "args", model.detailsArgs));
      body.appendChild(details);
    }
  }
  else if (item.approval === "pending") body.appendChild(renderApprovalRow(item.id, handlers, command?.offerRunAllow === true));
  else if (item.approval === "allowed") body.appendChild(el("div", "approval-decided allowed", command?.decided ?? "You allowed this call."));
  else if (item.approval === "denied") body.appendChild(el("div", "approval-decided denied", command?.decided ?? "You denied this call."));
  details.appendChild(body);
  return details;
}

function reviewStateLabel(review: ReviewItemInfo): string {
  switch (review.state) {
    case "queued":
      return "queued";
    case "reviewing":
      return review.hunks !== undefined ? `review ${review.hunks} hunk${review.hunks === 1 ? "" : "s"}` : "review";
    case "applying":
      return "applying…";
    case "applied":
      return `applied ${review.applied ?? "?"} of ${review.hunks ?? "?"}`;
    case "rejected":
      return "rejected";
    case "failed":
      return "not applied";
    case "cancelled":
      return "cancelled";
  }
}

/** The card body of a propose_edit / create_file call: the file, the summary, the hunk count and a Review diff button. */
function renderReviewRow(callId: string, review: ReviewItemInfo, handlers: RenderHandlers): HTMLElement {
  const row = el("div", "review");
  row.appendChild(el("div", "review-file", `${review.kind === "create" ? "New file" : "File"}: ${review.path}`));
  if (review.summary) row.appendChild(el("div", "review-summary", review.summary));
  const hunks = review.hunks !== undefined ? `${review.hunks} hunk${review.hunks === 1 ? "" : "s"}` : "";
  if (review.state === "reviewing" || review.state === "queued") {
    if (hunks) row.appendChild(el("div", "review-hunks", hunks));
    const open = el("button", "primary", "Review diff");
    open.disabled = review.state === "queued";
    open.title = review.state === "queued" ? "Waiting for an earlier change to the same file" : "Open the diff and accept or reject each hunk";
    open.addEventListener("click", () => handlers.onOpenReview(callId));
    row.appendChild(open);
    if (review.state === "queued") row.appendChild(el("div", "review-note", "Queued behind another change to this file."));
  } else {
    const text =
      review.state === "applied"
        ? `You applied ${review.applied ?? "?"} of ${review.hunks ?? "?"} hunks.`
        : review.state === "applying"
          ? "Applying the accepted hunks…"
          : review.state === "rejected"
          ? "You rejected this change."
          : review.state === "cancelled"
            ? "Cancelled before anything was written."
            : `Nothing was written. ${review.detail ?? ""}`.trim();
    row.appendChild(el("div", `review-result ${review.state}`, text));
  }
  return row;
}

/** The "Review (N files)" queue shown above the transcript while changes wait for review. */
export function renderReviewQueue(entries: readonly ReviewQueueEntry[], handlers: RenderHandlers): HTMLElement {
  const box = el("div", "queue-box");
  box.appendChild(el("div", "queue-title", reviewHeader(entries)));
  for (const entry of entries) {
    const row = el("button", `queue-row state-${entry.state}`);
    row.type = "button";
    row.appendChild(el("span", "queue-path", entry.path));
    row.appendChild(el("span", "queue-state", reviewStateLabel(entry)));
    row.title = entry.summary;
    row.disabled = entry.state !== "reviewing";
    row.addEventListener("click", () => handlers.onOpenReview(entry.callId));
    box.appendChild(row);
    const controls = renderReviewControls(entry, handlers);
    if (controls) box.appendChild(controls);
  }
  return box;
}

/**
 * The decision controls of one review in the queue: a status line, a note about undecided hunks and the "Apply accepted" /
 * "Reject all" buttons while it waits; a result line once it was written (or failed). The buttons post the same commands
 * as Cmd+Enter and the CodeLens (src/extension.ts), so there is no second way to write a file.
 */
function renderReviewControls(entry: ReviewQueueEntry, handlers: RenderHandlers): HTMLElement | undefined {
  if (entry.state === "reviewing" || entry.state === "applying") {
    const box = el("div", `review-controls state-${entry.state}`);
    box.dataset["callId"] = entry.callId;
    const line = reviewOutcomeLine(entry);
    box.appendChild(el("div", "review-status", entry.state === "applying" ? (line?.text ?? "") : reviewStatusLine(entry)));
    const note = entry.state === "reviewing" ? reviewUndecidedNote(entry) : "";
    if (note) box.appendChild(el("div", "review-note", note));
    const acceptAll = el("button", "primary", "Accept all and apply");
    const apply = el("button", "secondary", "Apply accepted");
    const reject = el("button", "secondary", "Reject all");
    const accepted = entry.accepted ?? 0;
    const undecided = reviewDecisions(entry).undecided;
    acceptAll.disabled = entry.state === "applying" || undecided === 0;
    acceptAll.title = entry.state === "applying" ? "Writing the change…" : undecided === 0 ? "Nothing is undecided: use Apply accepted" : "Accept every undecided hunk (rejected ones stay rejected) and write the result";
    apply.disabled = entry.state === "applying" || accepted === 0;
    reject.disabled = entry.state === "applying";
    apply.title = entry.state === "applying" ? "Writing the change…" : accepted === 0 ? "Accept at least one hunk in the diff first (or use Reject all)" : "Write the accepted hunks (same as Cmd/Ctrl+Enter in the diff)";
    reject.title = "Reject the whole change; nothing is written";
    const lock = (): void => {
      acceptAll.disabled = true;
      apply.disabled = true;
      reject.disabled = true;
    };
    acceptAll.addEventListener("click", () => {
      lock();
      handlers.onReviewAcceptAllApply(entry.callId);
    });
    apply.addEventListener("click", () => {
      lock();
      handlers.onReviewApply(entry.callId);
    });
    reject.addEventListener("click", () => {
      lock();
      handlers.onReviewRejectAll(entry.callId);
    });
    const buttons = el("div", "review-buttons");
    buttons.append(acceptAll, apply, reject);
    box.appendChild(buttons);
    return box;
  }
  const outcome = reviewOutcomeLine(entry);
  if (!outcome) return undefined;
  const line = el("div", `review-outcome ${outcome.tone}`, outcome.text);
  line.dataset["callId"] = entry.callId;
  line.setAttribute("role", outcome.tone === "error" ? "alert" : "status");
  return line;
}

function renderApprovalRow(callId: string, handlers: RenderHandlers, offerRunAllow = false): HTMLElement {
  const row = el("div", "approval");
  row.appendChild(el("div", "approval-title", "Allow this tool call?"));
  const reason = el("input", "reason");
  reason.type = "text";
  reason.placeholder = "Reason if you deny (optional)";
  reason.maxLength = 500;
  const runAllow = el("input");
  runAllow.type = "checkbox";
  const runAllowLabel = el("label", "run-allow");
  runAllowLabel.append(runAllow, document.createTextNode(" Allow this exact command for this run"));
  const allow = el("button", "primary", "Allow");
  const deny = el("button", "secondary", "Deny");
  const decide = (decision: "allow" | "deny"): void => {
    allow.disabled = true;
    deny.disabled = true;
    handlers.onApproval(callId, decision, decision === "deny" ? reason.value.trim() || undefined : undefined, decision === "allow" && runAllow.checked ? true : undefined);
  };
  allow.addEventListener("click", () => decide("allow"));
  deny.addEventListener("click", () => decide("deny"));
  const buttons = el("div", "approval-buttons");
  buttons.append(allow, deny);
  if (offerRunAllow) row.appendChild(runAllowLabel);
  row.append(reason, buttons);
  return row;
}

/** A subagent block: header with title and status, body holds the thread's messages and tool calls (kept across re-renders). */
function renderSubagent(item: Extract<ChatItem, { kind: "subagent" }>, previous: HTMLElement | undefined): HTMLElement {
  const details = el("details", `item subagent state-${item.state}`);
  details.dataset["id"] = item.id;
  details.dataset["thread"] = item.thread;
  details.open = previous instanceof HTMLDetailsElement ? previous.open : true;
  const summary = el("summary");
  summary.appendChild(el("span", "glyph", item.state === "running" ? "…" : item.state === "error" ? "✕" : "✓"));
  summary.appendChild(el("span", "badge", "subagent"));
  summary.appendChild(el("span", "tool-args", item.title));
  summary.appendChild(el("span", "tool-meta", item.state === "running" ? "working" : item.state === "error" ? "failed" : "done"));
  details.appendChild(summary);
  const body = el("div", "subagent-body");
  const old = previous?.querySelector(".subagent-body");
  if (old) body.append(...Array.from(old.childNodes));
  details.appendChild(body);
  return details;
}

/** Builds the element for one transcript item. `previous` is the element being replaced (keeps cards open). */
export function renderItem(item: ChatItem, handlers: RenderHandlers, previous?: HTMLElement): HTMLElement {
  switch (item.kind) {
    case "user": {
      const div = el("div", "item user");
      div.dataset["id"] = item.id;
      div.appendChild(el("div", "bubble", item.text));
      return div;
    }
    case "assistant": {
      const div = el("div", item.streaming ? "item assistant streaming" : "item assistant");
      div.dataset["id"] = item.id;
      if (item.subagent) div.appendChild(el("span", "badge", item.subagent));
      const body = el("div", "markdown");
      body.appendChild(renderMarkdown(item.text));
      div.appendChild(body);
      return div;
    }
    case "tool":
      return renderTool(item, handlers, previous);
    case "subagent":
      return renderSubagent(item, previous);
    case "divider": {
      const div = el("div", "item divider");
      div.dataset["id"] = item.id;
      div.appendChild(el("span", undefined, item.text));
      return div;
    }
    case "notice": {
      const div = el("div", `item notice ${item.level}`);
      div.dataset["id"] = item.id;
      div.textContent = item.text;
      return div;
    }
  }
}
