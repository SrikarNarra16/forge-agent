import * as vscode from "vscode";
import { refreshUnlessAsked } from "./refreshBurst";
import { PROPOSAL_SCHEME } from "./proposalFs";
import type { ReviewSession } from "./session";

/**
 * CodeLens provider for the proposal side of the review diff: one lens pair per hunk
 * ("✓ Accept hunk" / "✗ Reject hunk", becoming "✓ accepted" / "✗ rejected" once decided) and
 * "Accept all · Reject all · Apply (n of m accepted) ▸" at the top. Lenses only render in a diff editor when
 * `diffEditor.codeLens` is true; the extension enables that by default (package.json configurationDefaults).
 */
export interface SessionLookup {
  sessionForProposal(uri: vscode.Uri): ReviewSession | undefined;
}

export class ProposalCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this.changed.event;

  constructor(private readonly lookup: SessionLookup) {}

  refresh(): void {
    this.changed.fire();
  }

  /** How often VS Code asked for the lenses of each proposal document (keyed by URI string). */
  private readonly asked = new Map<string, number>();

  /**
   * Called after a review diff opened: if VS Code has still not asked this provider for the document at +600 ms (and again at
   * +1.5 s), fires the change event so it does. When VS Code asked (the normal case) nothing is fired, so the lens is neither
   * delayed nor redrawn. Bounded (2 checks); returns a canceller.
   */
  refreshAfterOpen(proposal: vscode.Uri, alive: () => boolean): () => void {
    const key = proposal.toString();
    return refreshUnlessAsked(() => this.changed.fire(), () => (this.asked.get(key) ?? 0) > 0, alive);
  }

  /** Forgets the request count of a finished review's document. */
  forget(proposal: vscode.Uri): void {
    this.asked.delete(proposal.toString());
  }

  dispose(): void {
    this.changed.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== PROPOSAL_SCHEME) return [];
    this.asked.set(document.uri.toString(), (this.asked.get(document.uri.toString()) ?? 0) + 1);
    const session = this.lookup.sessionForProposal(document.uri);
    if (!session || session.finished) return [];

    const callId = session.info.callId;
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    const accepted = session.count("accepted");
    lenses.push(
      new vscode.CodeLens(top, { title: "Accept all", command: "forge.reviewAcceptAll", arguments: [callId], tooltip: "Mark every hunk as accepted" }),
      new vscode.CodeLens(top, { title: "Reject all", command: "forge.reviewRejectAll", arguments: [callId], tooltip: "Reject every hunk and finish (Esc)" }),
      new vscode.CodeLens(top, {
        title: `Apply (${accepted} of ${session.hunks.length} accepted) ▸`,
        command: "forge.reviewApply",
        arguments: [callId],
        tooltip: "Write the accepted hunks to the file. Undecided hunks are not written. (Cmd/Ctrl+Enter)",
      }),
    );

    const layout = session.layout();
    const lastLine = Math.max(0, document.lineCount - 1);
    for (const hunk of session.hunks) {
      const range = layout.ranges[hunk.id];
      const line = Math.min(range?.start ?? 0, lastLine);
      const at = new vscode.Range(line, 0, line, 0);
      const decision = session.decisionList[hunk.id];
      const label = `hunk ${hunk.id + 1} of ${session.hunks.length}`;
      if (decision === "accepted") {
        lenses.push(new vscode.CodeLens(at, { title: "✓ accepted", command: "forge.reviewRejectHunk", arguments: [callId, hunk.id], tooltip: `${label}: click to reject instead` }));
      } else if (decision === "rejected") {
        lenses.push(new vscode.CodeLens(at, { title: "✗ rejected", command: "forge.reviewAcceptHunk", arguments: [callId, hunk.id], tooltip: `${label}: click to accept instead` }));
      } else {
        lenses.push(
          new vscode.CodeLens(at, { title: "✓ Accept hunk", command: "forge.reviewAcceptHunk", arguments: [callId, hunk.id], tooltip: label }),
          new vscode.CodeLens(at, { title: "✗ Reject hunk", command: "forge.reviewRejectHunk", arguments: [callId, hunk.id], tooltip: label }),
        );
      }
    }
    return lenses;
  }
}
