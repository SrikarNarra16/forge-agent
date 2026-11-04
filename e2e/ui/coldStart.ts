/**
 * Layer 2, hermetic: does the review diff show its CodeLens on a COLD start? Every launch uses a brand-new, empty
 * user-data-dir and extensions dir (createEnvironment), activates Forge and opens the Fake Proposal diff:
 *   immediate : as soon as the command palette offers "Forge: Fake Proposal" (i.e. right after activation)
 *   panel     : after the Forge panel is open and ready
 *   delayed   : 5 s after the workbench is up, then the diff
 * Records per launch whether the "Accept hunk" lens text appeared within 10 s and how long it took. No model, no TrueForge.
 *
 *   COLD_MODE=immediate COLD_RUNS=10 npm run test:ui:cold
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describeError } from "../../src/trueforge/client";
import { ROOT, createEnvironment } from "../env";
import { launch, makeScreens, openPanel, runCommand } from "./driver";

const MODE = (process.env["COLD_MODE"] ?? "immediate") as "immediate" | "panel" | "delayed";
const RUNS = Number(process.env["COLD_RUNS"] ?? 10);
const LIMIT_MS = 10_000;

interface Row {
  run: number;
  ok: boolean;
  ms?: number;
  note?: string;
}

async function once(run: number): Promise<Row> {
  const env = await createEnvironment({ extraSettings: { "forge.commandPrefix": "", "forge.trueforge.baseUrl": "http://127.0.0.1:9" } });
  const screens = await makeScreens();
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch(env, { video: false });
    const page = launched.page;
    if (MODE === "panel") await openPanel(page);
    if (MODE === "delayed") await new Promise((r) => setTimeout(r, 5000));
    await runCommand(page, "Forge: Fake Proposal"); // waits for the command to exist, i.e. for activation
    const t0 = Date.now();
    while (Date.now() - t0 < LIMIT_MS) {
      if (await page.locator('a[role="button"]', { hasText: /Accept hunk/ }).locator("visible=true").first().isVisible().catch(() => false)) return { run, ok: true, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 25));
    }
    await screens.shot(page, `cold-${MODE}-${run}-missing-lens`);
    return { run, ok: false, note: "lens not visible within 10 s" };
  } catch (err) {
    return { run, ok: false, note: describeError(err) };
  } finally {
    await launched?.app.close().catch(() => undefined);
    await env.cleanup();
  }
}

async function main(): Promise<number> {
  const rows: Row[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await once(i);
    rows.push(r);
    console.log(`  cold launch ${i} (${MODE}): ${r.ok ? `lens after ${r.ms} ms` : `MISSING (${r.note})`}`);
  }
  const ok = rows.filter((r) => r.ok);
  const ms = ok.map((r) => r.ms as number).sort((a, b) => a - b);
  const summary = `cold start, mode "${MODE}": ${ok.length} of ${rows.length} launches showed the lens within ${LIMIT_MS / 1000} s${ms.length ? ` (min ${ms[0]} ms / median ${ms[Math.floor(ms.length / 2)]} ms / max ${ms[ms.length - 1]} ms)` : ""}${rows.some((r) => !r.ok) ? `; failures: ${rows.filter((r) => !r.ok).map((r) => `#${r.run} ${r.note}`).join("; ")}` : ""}`;
  console.log(`\n${summary}`);
  await appendFile(join(ROOT, "docs", "e2e-results.md"), `## ${new Date().toISOString().slice(0, 16).replace("T", " ")} (UI layer, cold-start lens, hermetic, Playwright)\n\n${summary}\n\nPer launch (ms): ${rows.map((r) => (r.ok ? r.ms : "MISSING")).join(", ")}\n\n`, "utf8");
  return rows.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`cold-start test failed: ${describeError(err)}`);
    process.exit(2);
  },
);
