import * as vscode from "vscode";
import type { Logger } from "../util/log";
import { ProposalCodeLensProvider } from "./codeLens";
import { PROPOSAL_SCHEME, type ProposalFileSystem } from "./proposalFs";
import type { ReviewHandle, ReviewPresenter } from "./reviewHandler";
import type { ReviewSession } from "./session";
import { hunkSummary } from "./hunks";

/**
 * The review UI. For each ReviewSession it keeps the read-only proposal document in sync with the user's
 * per-hunk decisions (a rejected hunk is reverted in the proposal, so the diff visibly shrinks), shows the
 * CodeLenses, and opens `vscode.diff(real file, proposal)` focused on the first changed hunk. It also owns
 * the review commands, which accept the callId from a CodeLens or fall back to the active proposal editor.
 */

const CODELENS_PROMPT_KEY = "forge.codeLensPromptShown";

interface ActiveReview {
  session: ReviewSession;
  proposalUri: vscode.Uri;
  originalUri: vscode.Uri;
  lastText: string;
  unsubscribe: () => void;
}

export class ReviewUi implements ReviewPresenter, vscode.Disposable {
  readonly lenses: ProposalCodeLensProvider;
  private readonly active = new Map<string, ActiveReview>();
  private readonly byProposal = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly fs: ProposalFileSystem,
    private readonly memento: vscode.Memento,
    private readonly log: Logger,
  ) {
    this.lenses = new ProposalCodeLensProvider({ sessionForProposal: (uri) => this.sessionForProposal(uri) });
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(PROPOSAL_SCHEME, fs, { isCaseSensitive: true, isReadonly: true }),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSAL_SCHEME }, this.lenses),
      this.lenses,
      ...this.registerCommands(),
    );
  }

  dispose(): void {
    for (const review of [...this.active.values()]) review.session.cancel();
    for (const d of this.disposables) d.dispose();
  }

  sessionForProposal(uri: vscode.Uri): ReviewSession | undefined {
    const callId = this.byProposal.get(uri.toString());
    return callId ? this.active.get(callId)?.session : undefined;
  }

  // --- ReviewPresenter -------------------------------------------------------------------------------

  present(session: ReviewSession, options: { autoOpen: boolean }): ReviewHandle {
    const { callId, path: rel, kind } = session.info;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error("No workspace folder is open.");

    const proposalUri = this.fs.uriFor(callId, rel);
    const text = session.layout().text;
    this.fs.set(proposalUri, text);
    let originalUri: vscode.Uri;
    if (kind === "edit") {
      originalUri = vscode.Uri.file(`${root}/${rel}`);
    } else {
      originalUri = this.fs.uriFor(callId, rel, "original"); // a new file diffs against an empty document
      this.fs.set(originalUri, "");
    }

    const review: ActiveReview = { session, proposalUri, originalUri, lastText: text, unsubscribe: () => undefined };
    review.unsubscribe = session.onChange(() => {
      const next = session.layout().text;
      if (next !== review.lastText) {
        review.lastText = next;
        this.fs.set(proposalUri, next);
      }
      this.lenses.refresh();
    });
    this.active.set(callId, review);
    this.byProposal.set(proposalUri.toString(), callId);
    this.lenses.refresh();
    void this.maybePromptForCodeLens();
    if (options.autoOpen) void this.open(callId);

    return {
      close: () => {
        review.unsubscribe();
        void this.closeDiff(proposalUri);
        this.fs.remove(proposalUri);
        if (kind === "create") this.fs.remove(originalUri);
        this.active.delete(callId);
        this.byProposal.delete(proposalUri.toString());
        this.lenses.refresh();
      },
    };
  }

  /** Read-only view of a pending review (its file and the text of every hunk), for tools that decide through the real commands. */
  peek(callId: string): { path: string; hunks: Array<{ id: number; text: string }> } | undefined {
    const review = this.active.get(callId);
    if (!review) return undefined;
    return { path: review.session.info.path, hunks: review.session.hunks.map((h) => ({ id: h.id, text: h.lines.map((l) => `${l.type}${l.text}`).join("") })) };
  }

  /** Opens (or focuses) the diff of a pending review, revealed at its first changed hunk. */
  async open(callId: string): Promise<void> {
    const review = this.active.get(callId);
    if (!review) return;
    const { session, proposalUri, originalUri } = review;
    const first = session.layout().ranges[0];
    const line = first?.start ?? 0;
    const selection = new vscode.Range(line, 0, line, 0);
    try {
      await vscode.commands.executeCommand("vscode.diff", originalUri, proposalUri, `Forge: ${session.info.path} (${session.info.summary})`, {
        preview: false,
        preserveFocus: false,
        selection,
      } satisfies vscode.TextDocumentShowOptions);
      // Make sure the first hunk is on screen on the modified side.
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === proposalUri.toString());
      if (editor) {
        editor.selection = new vscode.Selection(selection.start, selection.start);
        editor.revealRange(selection, vscode.TextEditorRevealType.AtTop);
      }
    } catch (err) {
      this.log.error(`could not open the review diff for ${session.info.path}`, err);
      void vscode.window.showErrorMessage(`Forge could not open the review for ${session.info.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async closeDiff(proposalUri: vscode.Uri): Promise<void> {
    const target = proposalUri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === target) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }

  /** `diffEditor.codeLens` makes the lenses render in diffs. Forge enables it by default; if the user turned it off, offer once. */
  private async maybePromptForCodeLens(): Promise<void> {
    const enabled = vscode.workspace.getConfiguration("diffEditor").get<boolean>("codeLens", false);
    if (enabled || this.memento.get<boolean>(CODELENS_PROMPT_KEY)) return;
    await this.memento.update(CODELENS_PROMPT_KEY, true);
    const choice = await vscode.window.showInformationMessage(
      "Forge shows Accept/Reject buttons above each change in the review diff, which needs the setting diffEditor.codeLens. Turn it on? (Without it you can use the buttons in the editor title bar, Cmd/Ctrl+Enter to apply, or the command \"Forge: Review Hunks…\".)",
      "Turn on",
    );
    if (choice === "Turn on") await vscode.workspace.getConfiguration("diffEditor").update("codeLens", true, vscode.ConfigurationTarget.Global);
  }

  // --- commands ----------------------------------------------------------------------------------------

  /** The review a command refers to: the callId passed by a lens, else the active proposal editor, else the only pending review. */
  private resolve(callId: unknown): ActiveReview | undefined {
    if (typeof callId === "string") {
      const byId = this.active.get(callId);
      if (byId) return byId;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = uri ? this.byProposal.get(uri.toString()) : undefined;
    if (fromEditor) return this.active.get(fromEditor);
    return this.active.size === 1 ? [...this.active.values()][0] : undefined;
  }

  private noReview(): void {
    void vscode.window.showInformationMessage("Forge: there is no change waiting for review.");
  }

  /** The hunk under the cursor of the active proposal editor, if any. */
  private hunkAtCursor(review: ActiveReview): number | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== review.proposalUri.toString()) return undefined;
    const line = editor.selection.active.line;
    const ranges = review.session.layout().ranges;
    const inside = ranges.findIndex((r) => line >= r.start && line < Math.max(r.end, r.start + 1));
    return inside === -1 ? undefined : inside;
  }

  private registerCommands(): vscode.Disposable[] {
    const hunkCommand =
      (action: "accept" | "reject") =>
      async (callId?: unknown, hunkId?: unknown): Promise<void> => {
        const review = this.resolve(callId);
        if (!review) return this.noReview();
        const id = typeof hunkId === "number" ? hunkId : this.hunkAtCursor(review);
        if (id === undefined) {
          await this.pickHunks(review);
          return;
        }
        if (action === "accept") review.session.accept(id);
        else review.session.reject(id);
      };

    /** A command that acts on the whole review, or says there is nothing to review. */
    const wholeReview =
      (act: (session: ReviewSession) => void) =>
      (callId?: unknown): void => {
        const review = this.resolve(callId);
        if (!review) {
          this.noReview();
          return;
        }
        act(review.session);
      };

    return [
      vscode.commands.registerCommand("forge.reviewAcceptHunk", hunkCommand("accept")),
      vscode.commands.registerCommand("forge.reviewRejectHunk", hunkCommand("reject")),
      vscode.commands.registerCommand("forge.reviewAcceptAll", wholeReview((s) => s.acceptAll())),
      vscode.commands.registerCommand("forge.reviewRejectAll", wholeReview((s) => s.rejectAll())),
      // used by the panel's "Accept all and apply" (then forge.reviewApply): accepts only what is still undecided
      vscode.commands.registerCommand("forge.reviewAcceptPending", wholeReview((s) => s.acceptPending())),
      vscode.commands.registerCommand("forge.reviewApply", wholeReview((s) => s.apply())),
      vscode.commands.registerCommand("forge.reviewPickHunk", async (callId?: unknown) => {
        const review = this.resolve(callId);
        if (!review) return this.noReview();
        await this.pickHunks(review);
      }),
      vscode.commands.registerCommand("forge.reviewOpen", (callId?: unknown) => (typeof callId === "string" ? this.open(callId) : undefined)),
    ];
  }

  /** Fallback UI when lenses are unavailable: tick the hunks to accept; unticked ones are rejected. */
  private async pickHunks(review: ActiveReview): Promise<void> {
    const { session } = review;
    const items = session.hunks.map((h) => ({
      label: hunkSummary(h),
      description: session.decisionList[h.id] === "pending" ? "undecided" : session.decisionList[h.id],
      picked: session.decisionList[h.id] === "accepted",
      id: h.id,
    }));
    const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: `Forge: ${session.info.path}`, placeHolder: "Tick the hunks to ACCEPT; unticked hunks are rejected" });
    if (!picked) return;
    const chosen = new Set(picked.map((p) => p.id));
    for (const h of session.hunks) {
      if (chosen.has(h.id)) session.accept(h.id);
      else session.reject(h.id);
    }
  }
}
