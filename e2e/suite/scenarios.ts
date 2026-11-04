import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import type { E2eConfig, ScenarioResult } from "../common";
import { TASK_A_INSTRUCTION, TASK_B_PROMPT, dirty, getDebugFlagRange, openFile, resetWorkspace, sleep, state, verifyTaskA, verifyTaskB, waitFor, waitIdle, type E2eState } from "./helpers";

export interface ScenarioOutcome {
  detail: string;
  data?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  name: string;
  /** Needs the real TrueForge and a real model (E2E_LIVE=1). */
  live: boolean;
  /** Needs the hermetic fake TrueForge (set up by the runner when `fake` is true in the config). */
  fake?: boolean;
  run(cfg: E2eConfig): Promise<ScenarioOutcome>;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** What happened after `before` was taken: the transcript and the notices keep earlier scenarios' entries. */
function since(before: E2eState, now: E2eState): E2eState {
  return { ...now, items: now.items.slice(before.items.length), notices: now.notices.slice(before.notices.length), stateHistory: now.stateHistory.slice(before.stateHistory.length) };
}

const decide = (policy: unknown): Thenable<unknown> => vscode.commands.executeCommand("forge.e2e.decide", { policy });
/** State of the NEWEST review (finished ones of earlier scenarios stay in the queue until the next run). */
const reviewState = (s: E2eState): string | undefined => s.review.at(-1)?.state;

async function setModels(models: string[]): Promise<void> {
  await vscode.workspace.getConfiguration("forge").update("models", models, vscode.ConfigurationTarget.Global); // the TEMP user-data-dir's settings
}

/** Runs the fake proposal (three separate edits to src/flask/helpers.py) through the real review handler. */
async function startFakeProposal(cfg: E2eConfig): Promise<void> {
  await openFile(cfg, "src/flask/helpers.py");
  // the command only resolves when the review is finished, so it must not be awaited here
  void Promise.resolve(vscode.commands.executeCommand("forge.fakeProposal")).catch(() => undefined);
  await waitFor("the review to be shown", async () => reviewState(await state()) === "reviewing", 20_000);
}

// ---------------------------------------------------------------------------------------------------------------

const panelAndLenses: Scenario = {
  id: "10",
  name: "Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses",
  live: false,
  async run(cfg) {
    await vscode.commands.executeCommand("forge.openAgent");
    const s = await waitFor("the panel webview to resolve and announce itself", async () => {
      const st = await state();
      return st.panelViewResolved && st.readyCount >= 1 ? st : undefined;
    }, 30_000);

    await startFakeProposal(cfg);
    const proposal = await waitFor("the proposal document", () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "forge-proposal"), 15_000);
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", proposal.uri)) ?? [];
    const titles = lenses.map((l) => l.command?.title ?? "");
    assert(titles.filter((t) => t.includes("Accept hunk")).length >= 3, `expected an "Accept hunk" lens per hunk, got: ${titles.join(" | ")}`);
    assert(titles.filter((t) => t.includes("Reject hunk")).length >= 3, `expected a "Reject hunk" lens per hunk, got: ${titles.join(" | ")}`);
    assert(titles.some((t) => t === "Accept all") && titles.some((t) => t === "Reject all"), `missing Accept all / Reject all: ${titles.join(" | ")}`);
    assert(titles.some((t) => /apply/i.test(t)), `missing the Apply lens: ${titles.join(" | ")}`);
    await vscode.commands.executeCommand("forge.reviewRejectAll");
    await waitFor("the rejected review to finish", async () => reviewState(await state()) === "rejected", 15_000);
    assert((await dirty(cfg)) === "", "a rejected proposal changed the workspace");
    return { detail: `panel resolved (ready x${s.readyCount}); ${titles.length} lenses: ${[...new Set(titles)].join(", ")}`, data: { lenses: titles.length } };
  },
};

const singleUndo: Scenario = {
  id: "3",
  name: "After an apply, ONE real `undo` restores the pre-apply text (single undo step)",
  live: false,
  async run(cfg) {
    const editor = await openFile(cfg, "src/flask/helpers.py");
    const before = editor.document.getText();
    await startFakeProposal(cfg);
    await decide("acceptAll");
    await waitFor("the review to be applied", async () => reviewState(await state()) === "applied", 20_000);
    await decide("stop");
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${cfg.workspace}/src/flask/helpers.py`));
    const afterApply = doc.getText();
    assert(afterApply !== before, "the apply did not change the document");
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("undo"); // ONE undo, on the editor the user would be looking at
    const afterUndo = vscode.window.activeTextEditor?.document.getText() ?? doc.getText();
    if (afterUndo !== before) {
      const lines = (t: string): string[] => t.split("\n");
      const changedAfterApply = lines(afterApply).filter((l, i) => l !== lines(before)[i]).length;
      const remaining = lines(afterUndo).filter((l, i) => l !== lines(before)[i]).length;
      throw new Error(`one undo did not restore the pre-apply text: the apply changed ${changedAfterApply} line(s); after ONE undo ${remaining} line(s) still differ (undo restored ${changedAfterApply - remaining})`);
    }
    return { detail: "one undo restored the exact pre-apply text (3 hunks applied as one undo step)" };
  },
};

const undoRun: Scenario = {
  id: "4",
  name: "Undo run restores the files (Fake Proposal)",
  live: false,
  async run(cfg) {
    await startFakeProposal(cfg);
    await decide("acceptAll");
    await waitFor("the review to be applied", async () => reviewState(await state()) === "applied", 20_000).catch(async (err) => {
      const st = await state();
      throw new Error(`${String(err)}; review queue: ${JSON.stringify(st.review.at(-1))}; notices: ${st.notices.map((n) => n.text).join(" | ")}`);
    });
    await decide("stop");
    assert((await dirty(cfg)) !== "", "nothing was applied to disk");
    await vscode.commands.executeCommand("forge.undoLastRun");
    await waitFor("Undo run to restore the file", async () => (await dirty(cfg)) === "", 15_000);
    return { detail: "git status clean after Undo run" };
  },
};

/** The applier race behind scenario 6 ("Document has been closed"): the target file is NOT open in any editor, hunk 1 is rejected, the rest accepted. No model involved. */
const rejectHunkLoop: Scenario = {
  id: "11",
  name: "Reject hunk 1, accept the rest, apply: 10 times in a row with the file not open in any editor (no model)",
  live: false,
  async run(cfg) {
    const failures: string[] = [];
    for (let i = 1; i <= 10; i++) {
      await resetWorkspace(cfg); // closes every editor: helpers.py is not open when the proposal is applied
      const before = await state();
      void Promise.resolve(vscode.commands.executeCommand("forge.fakeProposal")).catch(() => undefined);
      try {
        await decide("rejectIndexOfFirst:0");
        const done = await waitFor(`round ${i}: the review to finish`, async () => {
          const st = await state();
          const r = st.review.at(-1);
          return st.review.length > before.review.length && r && ["applied", "rejected", "failed", "cancelled"].includes(r.state) ? r : undefined;
        }, 20_000, 50);
        await decide("stop");
        if (done.state !== "applied" || done.applied !== 2 || done.hunks !== 3) failures.push(`round ${i}: ${done.state} ${done.applied ?? "?"} of ${done.hunks ?? "?"} hunks${done.detail ? ` (${done.detail})` : ""}`);
        else {
          const text = await readFile(`${cfg.workspace}/src/flask/helpers.py`, "utf8");
          const marks = (text.match(/forge fake proposal \d/g) ?? []).length;
          if (marks !== 2) failures.push(`round ${i}: expected 2 of 3 edits on disk, found ${marks}`);
        }
      } catch (err) {
        await decide("stop");
        failures.push(`round ${i}: ${err instanceof Error ? err.message : String(err)}`);
        await vscode.commands.executeCommand("forge.reviewRejectAll").then(undefined, () => undefined);
      }
    }
    assert(failures.length === 0, `${failures.length} of 10 rounds failed: ${failures.join(" | ")}`);
    const retries = await countForgeLog(cfg, /closed during the edit .* retrying once/);
    const landed = await countForgeLog(cfg, /the edit had already landed in the document/);
    const logLines = await countForgeLog(cfg, /./); // sanity: proves the Forge log was actually read
    assert(logLines > 0, "could not read the Forge output channel log, so the retry count above would mean nothing");
    return { detail: `10 of 10 rounds: hunk 1 rejected, 2 of 3 hunks applied and found on disk; the applier logged ${retries} closed-document retr${retries === 1 ? "y" : "ies"} (${landed} where the edit had already landed and only needed saving); ${logLines} Forge log lines read`, data: { retries, landed, logLines } };
  },
};

/** Counts lines of the test instance\'s Forge output channel log that match (the log lives in the temp user-data-dir). */
async function countForgeLog(cfg: E2eConfig, pattern: RegExp): Promise<number> {
  if (!cfg.userDataDir) return 0;
  const { readdir } = await import("node:fs/promises");
  let count = 0;
  for (const rel of await readdir(`${cfg.userDataDir}/logs`, { recursive: true })) {
    if (!String(rel).endsWith("Forge.log")) continue;
    count += (await readFile(`${cfg.userDataDir}/logs/${String(rel)}`, "utf8")).split("\n").filter((l) => pattern.test(l)).length;
  }
  return count;
}

const noHooksNote = "The forge.e2e.* commands exist only in this run (FORGE_E2E=1); the `nohooks` suite checks the opposite.";

// ---------------------------------------------------------------------------------------------------------------
// LIVE scenarios (real TrueForge + model)

async function inlineTaskA(cfg: E2eConfig): Promise<void> {
  const range = await getDebugFlagRange(cfg);
  await vscode.commands.executeCommand("forge.e2e.inlineEdit", { path: "src/flask/helpers.py", ...range, instruction: TASK_A_INSTRUCTION });
}

const taskAInline: Scenario = {
  id: "1",
  name: "Task A inline edit, accept all -> verify-task-a PASS",
  live: true,
  async run(cfg) {
    await decide("acceptAll");
    const t0 = Date.now();
    await inlineTaskA(cfg);
    const s = await waitIdle(180_000);
    await decide("stop");
    assert(s.runState === "done", `run ended '${s.runState}': ${s.notices.map((n) => n.text).join(" | ")}`);
    const v = await verifyTaskA(cfg);
    assert(v.code === 0, `verify-task-a failed:\n${v.out.slice(-1500)}`);
    return { detail: `PASS in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${s.usage.input + s.usage.output} tokens`, data: { seconds: (Date.now() - t0) / 1000, tokens: s.usage.input + s.usage.output } };
  },
};

const taskAPartial: Scenario = {
  id: "2",
  name: "Task A partial accept (reject the code hunk) -> only the docstring changed",
  live: true,
  async run(cfg) {
    await decide({ review: "rejectHunkMatching", pattern: "not in \\{", commands: "allow" });
    await inlineTaskA(cfg);
    const s = await waitIdle(180_000);
    await decide("stop");
    assert(s.runState === "done", `run ended '${s.runState}': ${s.notices.map((n) => n.text).join(" | ")}`);
    const text = await readFile(`${cfg.workspace}/src/flask/helpers.py`, "utf8");
    assert(/not in \{"0", "false", "no"\}/.test(text), "the code hunk was changed although it was rejected");
    assert(/\boff\b/.test(text.slice(text.indexOf("def get_debug_flag"), text.indexOf("def get_debug_flag") + 900)), "the docstring hunk was not applied");
    const applied = s.review[0];
    return { detail: `code hunk kept as it was, docstring updated (${applied?.applied ?? "?"} of ${applied?.hunks ?? "?"} hunks applied)`, data: { hunks: applied?.hunks, applied: applied?.applied } };
  },
};

function toolCounts(s: E2eState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of s.items) if (i.kind === "tool") counts[String(i.name)] = (counts[String(i.name)] ?? 0) + 1;
  return counts;
}

const taskBPanel: Scenario = {
  id: "5",
  name: "Task B via the panel, accept all -> verify-task-b PASS",
  live: true,
  async run(cfg) {
    await decide("acceptAll");
    const t0 = Date.now();
    await vscode.commands.executeCommand("forge.e2e.sendPanel", { prompt: TASK_B_PROMPT });
    const s = await waitIdle(480_000);
    await decide("stop");
    assert(s.runState === "done", `run ended '${s.runState}': ${s.notices.map((n) => n.text).join(" | ")}`);
    const v = await verifyTaskB(cfg);
    const counts = toolCounts(s);
    const calls = Object.values(counts).reduce((a, b) => a + b, 0);
    assert(v.code === 0, `verify-task-b failed:\n${v.out.slice(-2000)}`);
    return {
      detail: `PASS in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${calls} tool calls, ${s.usage.calls} model calls, ${s.usage.input + s.usage.output} tokens; context items ${s.context.plan?.items.length ?? 0}`,
      data: { seconds: (Date.now() - t0) / 1000, toolCalls: calls, counts, modelCalls: s.usage.calls, tokens: s.usage.input + s.usage.output },
    };
  },
};

const taskBRejected: Scenario = {
  id: "6",
  name: "Task B with one rejected hunk -> the agent is told and the result is reported",
  live: true,
  async run(cfg) {
    const before = await state();
    await decide("rejectIndexOfFirst:0");
    const t0 = Date.now();
    await vscode.commands.executeCommand("forge.e2e.sendPanel", { prompt: TASK_B_PROMPT });
    const s = since(before, await waitIdle(480_000));
    await decide("stop");
    assert(s.runState === "done", `run ended '${s.runState}': ${s.notices.map((n) => n.text).join(" | ")}`);
    const first = s.items.find((i) => i.kind === "tool" && i.name === "propose_edit");
    const told = String(first?.["resultPreview"] ?? "");
    assert(/rejected/i.test(told), `the agent was not told about the rejected hunk; first propose_edit result: ${told.slice(0, 200)}`);
    const finalText = [...s.items].reverse().find((i) => i.kind === "assistant")?.["text"];
    assert(typeof finalText === "string" && finalText.length > 0, "no final message");
    const v = await verifyTaskB(cfg);
    return { detail: `agent told ("${told.slice(0, 90)}"); final message ${String(finalText).length} chars; verify-task-b ${v.code === 0 ? "PASS" : "FAIL (expected: a hunk was rejected)"}`, data: { verifyPass: v.code === 0, seconds: (Date.now() - t0) / 1000 } };
  },
};

const stopMidRun: Scenario = {
  id: "7",
  name: "Stop mid-run -> state cancelled, workspace pristine (git status clean)",
  live: true,
  async run(cfg) {
    const before = await state();
    await decide("acceptAll");
    await vscode.commands.executeCommand("forge.e2e.sendPanel", { prompt: TASK_B_PROMPT });
    // stop after the first file was really applied, so the rollback has something to undo
    await waitFor("the first applied edit", async () => (await state()).review.some((r) => r.state === "applied"), 240_000, 200);
    const t0 = Date.now();
    await vscode.commands.executeCommand("forge.stop");
    const s = await waitFor("the run to be cancelled", async () => {
      const st = await state();
      return st.runState === "cancelled" ? since(before, st) : undefined;
    }, 20_000, 50);
    const took = Date.now() - t0;
    await decide("stop");
    assert(s.stateHistory.includes("cancelling"), `the UI never showed 'Stopping…': ${s.stateHistory.join(">")}`);
    await waitFor("the workspace to be pristine", async () => (await dirty(cfg)) === "", 15_000);
    return { detail: `cancelled ${took} ms after the click, workspace pristine; notice: ${s.notices.at(-1)?.text.slice(0, 120) ?? ""}`, data: { stopMs: took } };
  },
};

const fallback: Scenario = {
  id: "8",
  name: "Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, pristine before the first apply, Task A PASS",
  live: true,
  async run(cfg) {
    await setModels(["broken-endpoint/broken", "deepseek/flash"]);
    await decide({ review: "none", commands: "allow" });
    await inlineTaskA(cfg); // the diff opens and waits: nothing is applied until we decide
    const s1 = await waitFor("the review to open on the fallback model", async () => {
      const st = await state();
      return reviewState(st) === "reviewing" ? st : undefined;
    }, 120_000);
    assert(s1.chainEvents.some((e) => e.kind === "switched"), `no switch notice: ${JSON.stringify(s1.chainEvents)}`);
    assert(s1.chainNotice?.includes("switched to deepseek/flash"), `panel chain notice missing: ${s1.chainNotice}`);
    const pristine = await dirty(cfg);
    assert(pristine === "", `the workspace was changed before the first apply: ${pristine}`);
    const afterMs = s1.chainEvents.find((e) => e.kind === "switched")?.afterMs;
    await decide("acceptAll");
    const s = await waitIdle(180_000);
    await decide("stop");
    assert(s.runState === "done", `run ended '${s.runState}'`);
    const v = await verifyTaskA(cfg);
    assert(v.code === 0, `verify-task-a failed:\n${v.out.slice(-1200)}`);
    return { detail: `${s1.chainNotice}; clean before the first apply; Task A PASS`, data: { timeToFallbackMs: afterMs } };
  },
};

const brokenOnly: Scenario = {
  id: "9",
  name: "Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace",
  live: true,
  async run(cfg) {
    const before = await state();
    await setModels(["broken-endpoint/broken"]);
    await inlineTaskA(cfg);
    const s = since(before, await waitIdle(60_000));
    assert(s.runState === "error", `expected an error, got '${s.runState}'`);
    const text = s.notices.map((n) => n.text).join(" | ");
    assert(/No model could answer/.test(text) && /broken-endpoint\/broken/.test(text), `unclear error: ${text}`);
    assert((await dirty(cfg)) === "", "the workspace was changed");
    return { detail: text.slice(0, 200) };
  },
};

export const SCENARIOS: Scenario[] = [panelAndLenses, singleUndo, undoRun, rejectHunkLoop, taskAInline, taskAPartial, taskBPanel, taskBRejected, stopMidRun, fallback, brokenOnly];
export { noHooksNote, resetWorkspace, sleep };
export type { ScenarioResult };
