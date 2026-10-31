import * as vscode from "vscode";
import type { Logger } from "../util/log";
import { capabilitiesUrl } from "../util/url";

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 2_000;

export type ConnectionState = "unknown" | "connected" | "disconnected";

/**
 * Status bar item showing whether the local TrueForge server is reachable.
 * Polls GET {baseUrl}/api/v1/capabilities; fully async with a short timeout, so it never
 * blocks the extension host. dispose() stops the timer and aborts any in-flight request.
 */
export class TrueForgeStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly configListener: vscode.Disposable;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: AbortController | undefined;
  private disposed = false;
  private current: ConnectionState = "unknown";
  private readonly changed = new vscode.EventEmitter<ConnectionState>();

  /** Fires after a check changes the state (not for the initial "unknown"). */
  readonly onDidChangeState: vscode.Event<ConnectionState> = this.changed.event;

  constructor(private readonly log: Logger) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "forge.checkConnection";
    this.render("unknown");
    this.item.show();
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forge.trueforge.baseUrl")) void this.check();
    });
    this.timer = setInterval(() => void this.check(), POLL_INTERVAL_MS);
    void this.check();
  }

  get state(): ConnectionState {
    return this.current;
  }

  get baseUrl(): string {
    return vscode.workspace.getConfiguration("forge").get<string>("trueforge.baseUrl", "http://localhost:8790");
  }

  /** Runs one health check now. Never throws; overlapping calls are dropped. */
  async check(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    const controller = new AbortController();
    this.inFlight = controller;
    const url = capabilitiesUrl(this.baseUrl);
    let next: ConnectionState = "disconnected";
    try {
      const res = await fetch(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (res.ok) next = "connected";
    } catch {
      next = "disconnected";
    } finally {
      this.inFlight = undefined;
    }
    if (this.disposed) return;
    const changed = next !== this.current;
    if (changed) this.log.info(`TrueForge ${next} (${url})`);
    this.render(next);
    if (changed) this.changed.fire(next);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.inFlight?.abort();
    this.configListener.dispose();
    this.changed.dispose();
    this.item.dispose();
  }

  private render(state: ConnectionState): void {
    this.current = state;
    const url = this.baseUrl;
    if (state === "connected") {
      this.item.text = "$(check) TrueForge: connected";
      this.item.tooltip = `TrueForge reachable at ${url}. Click to re-check.`;
    } else if (state === "disconnected") {
      this.item.text = "$(warning) TrueForge: disconnected";
      this.item.tooltip = `TrueForge not reachable at ${url}. Click to re-check.`;
    } else {
      this.item.text = "$(sync~spin) TrueForge: checking";
      this.item.tooltip = `Checking ${url}…`;
    }
  }
}
