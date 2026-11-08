import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRUEFORGE_START_COMMAND, TRUEFORGE_TESTED_VERSION } from "../src/trueforge/client";

const SCRIPT = join(__dirname, "..", "trueforge", "start.sh");
const dryRun = (extraEnv: Record<string, string> = {}, args: string[] = []): string =>
  execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TRUEFORGE_DRY_RUN: "1", ...extraEnv } });

describe("trueforge/start.sh (run in dry-run mode)", () => {
  it("EXPORTS the three environment variables TrueForge needs (a plain shell variable would not reach it: that bug happened once)", () => {
    const out = dryRun();
    expect(out).toContain(`OUTBOUND_URL_ALLOWED_HOSTS=["localhost","127.0.0.1"]`);
    expect(out).toContain("MODEL_HTTP_CONNECT_TIMEOUT_MS=3000");
    expect(out).toContain("MODEL_HTTP_MAX_RETRIES=1");
  });

  it("is pinned to the tested TrueForge version, passes its arguments on, and can be overridden", () => {
    expect(dryRun({}, ["--port", "8791"])).toContain(`COMMAND=npx @truefoundry/trueforge@${TRUEFORGE_TESTED_VERSION} --port 8791`);
    expect(dryRun({ TRUEFORGE_VERSION: "latest" })).toContain("COMMAND=npx @truefoundry/trueforge@latest");
  });

  it("the source has no @latest, and the extension's hint command names the same version", async () => {
    const script = await readFile(SCRIPT, "utf8");
    expect(script).toContain(`TRUEFORGE_VERSION="\${TRUEFORGE_VERSION:-${TRUEFORGE_TESTED_VERSION}}"`);
    expect(script).not.toMatch(/exec npx [^\n]*@latest/);
    expect(TRUEFORGE_START_COMMAND).toContain(`@truefoundry/trueforge@${TRUEFORGE_TESTED_VERSION}`);
    expect(TRUEFORGE_START_COMMAND).not.toContain("@latest");
  });
});
