# Cosmetic UI check at recording zoom (18 Nov 2026)

Method: the automated take (`npm run video:take`) runs the real extension at 1920x1080 with VS Code zoom +1 (120%); frames of the Forge panel, the review diff, the CodeLens row and the Context section were inspected. Only clear legibility problems were fixed, in markup/CSS or in the recording settings; no logic changed. Each "before" is a frame from the first full take, each "after" from the next one.

| # | Problem found | Fix | Before | After |
|---|---|---|---|---|
| 1 | At the default side-bar width the panel header (`Open in TrueForge`, `Undo run`, `New chat`, **`Stop`**) overflowed and was clipped; the status ("Waiting for your approval") wrapped into three lines and the panel scrolled sideways | `.bar { flex-wrap: wrap }` + non-shrinking spacer + `nowrap` buttons (`src/ui/webview/style.css`) | `before-panel-header-clipped.jpg` | `after-panel-header.jpg` |
| 2 | The per-hunk CodeLens row ("Accept hunk \| Reject hunk") is tiny (12 px) after video compression | recording setting `editor.codeLensFontSize: 15` (VS Code user setting, set by the take; the README now recommends it for screen recordings; not forced on users) | `before-diff-codelens.jpg` | `after-diff-codelens.jpg` |
| 3 | An empty Secondary Side Bar took a third of the width on the right | recording setting `workbench.secondarySideBar.defaultVisibility: hidden` + close command in the take | (visible in the before frames) | `after-diff-codelens.jpg` |

Checked and left alone: the Context section (reasons, token budget bar) is readable at this zoom; the diff and panel colours follow the VS Code theme; the Stop button is visible and red-outlined.

Re-run after the fixes: build, typecheck, lint, 1044 unit tests, `npm run package` + `code --install-extension forge-agent-0.0.1.vsix --force`, hermetic e2e (8 PASS, 7 live scenarios skipped by design), `npm run test:ui:panel` (all PASS).
