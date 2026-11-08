/**
 * Shared isolation for both e2e layers: a scrubbed environment, a temp user-data-dir and extensions-dir (your VS Code
 * profile is never read), a temp `git clone --local` of fixtures/flask at the pinned commit, a prefixed set of TrueForge
 * resources (`e2e-<pid>-forge-*`) with a name guard, a before/after snapshot and cleanup on every exit path.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, describeError } from "../src/trueforge/client";
import { resourceNames } from "../src/trueforge/resourceNames";
import { assertThrowaway, type Snapshot } from "../scripts/eval/guard";
import { createWorkspace, type Workspace } from "../scripts/eval/workspace";

export const ROOT = resolve(__dirname, "..");
export const DEFAULT_VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
export const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";

/**
 * The runner may itself be started from a VS Code terminal or extension host. Their environment must not leak into the
 * VS Code we launch: ELECTRON_RUN_AS_NODE would make it run as plain Node, and VSCODE_IPC_HOOK & co. could attach it to
 * (and so disturb) the user's running window.
 */
export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_") || key === "ELECTRON_NO_ATTACH_CONSOLE") {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

export function vscodeExecutable(): string {
  const exe = process.env["VSCODE_EXE"] ?? DEFAULT_VSCODE;
  if (!existsSync(exe)) throw new Error(`VS Code executable not found at ${exe}. Set VSCODE_EXE to your installation's binary (macOS: .../Contents/MacOS/Code).`);
  return exe;
}

export async function snapshotTrueForge(): Promise<Snapshot | undefined> {
  const client = createClient(BASE_URL);
  try {
    const agents: string[] = [];
    for await (const a of await client.agents.list({ limit: 100 })) agents.push(a.name);
    return { agents: agents.sort(), mcp: (await client.settings.mcpServers.list()).data.map((m) => m.name).sort() };
  } catch {
    return undefined;
  }
}

/** Deletes every e2e-<pid>- agent, MCP server and session (name guard: nothing else can be touched). */
export async function cleanupTrueForge(prefix: string, sessions: readonly string[] = []): Promise<string[]> {
  const log: string[] = [];
  const client = createClient(BASE_URL);
  const names = resourceNames(prefix);
  try {
    for (const id of sessions) await client.sessions.delete(id).catch(() => undefined);
    for (const agent of [names.agent, names.inline]) {
      assertThrowaway(agent);
      for await (const a of await client.agents.list({ agentName: agent, limit: 100 })) if (a.name === agent) await client.agents.delete(a.id).then(() => log.push(`deleted agent ${agent}`), (e: unknown) => log.push(`could not delete ${agent}: ${describeError(e)}`));
    }
    for (const server of [names.editor, names.extras]) {
      assertThrowaway(server);
      await client.settings.mcpServers.delete(server).then(() => log.push(`deleted MCP server ${server}`), () => undefined);
    }
  } catch (err) {
    log.push(`cleanup problem: ${describeError(err)}`);
  }
  return log;
}

export interface E2eEnvironment {
  prefix: string;
  temp: string;
  userData: string;
  extensions: string;
  workspace: Workspace;
  settingsFile: string;
  settings: Record<string, unknown>;
  /** Rewrites the temp profile's settings.json (merging `patch`): VS Code picks the change up live. */
  updateSettings(patch: Record<string, unknown>): Promise<void>;
  /** Launch arguments that isolate VS Code from the user's profile. */
  launchArgs: string[];
  cleanup(): Promise<void>;
}

/**
 * `defaultSettings` (or E2E_DEFAULT_SETTINGS=1): run with the product's DEFAULT settings, as a user would: no explicit
 * forge.commandPrefix (so the auto-detected `. .venv/bin/activate &&` is used; the copy gets a real `.venv`) and both
 * forge.autoAllowCommands.* off (their default). Without it the tests set an explicit prefix that points at the fixture's python.
 */
export async function createEnvironment(options: { extraSettings?: Record<string, unknown>; defaultSettings?: boolean } = {}): Promise<E2eEnvironment> {
  const defaultSettings = options.defaultSettings === true || process.env["E2E_DEFAULT_SETTINGS"] === "1";
  const scrubbed = scrubEnvironment();
  if (scrubbed.length > 0) console.log(`Removed ${scrubbed.length} inherited VS Code/Electron environment variable(s) so the test instance is fully separate: ${scrubbed.join(", ")}`);
  const prefix = `e2e-${process.pid}-`;
  const temp = await mkdtemp(join(tmpdir(), "forge-e2e-"));
  const userData = join(temp, "user-data");
  const extensions = join(temp, "extensions");
  let workspace: Workspace | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const line of await cleanupTrueForge(prefix)) console.log(`cleanup: ${line}`);
    // FORGE_KEEP_WORKSPACE=1 leaves the temp Flask clone (with the agent's result) for inspection; remove it yourself afterwards
    if (process.env["FORGE_KEEP_WORKSPACE"] === "1" && workspace) console.log(`Workspace kept for inspection: ${workspace.root}`);
    else await workspace?.dispose();
    await rm(temp, { recursive: true, force: true });
  };
  const bail = (what: string) => (): void => {
    console.error(`${what}: cleaning up e2e resources`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", bail("interrupted"));
  process.once("SIGTERM", bail("terminated"));

  try {
    workspace = await createWorkspace({ realVenv: defaultSettings }); // clean clone at the pinned commit; `import flask` verified to resolve into the copy
    console.log(`Workspace: ${workspace.root}`);
    await mkdir(join(userData, "User"), { recursive: true });
    const venvBin = join(workspace.python, "..");
    const settings: Record<string, unknown> = {
      "forge.models": ["deepseek/flash", "deepseek/v4-pro"],
      ...(defaultSettings ? {} : { "forge.commandPrefix": `export PATH='${venvBin}':"$PATH" PYTHONPATH='${join(workspace.root, "src")}' PYTHONDONTWRITEBYTECODE=1 &&` }),
      "forge.resourcePrefix": prefix,
      "forge.rollbackOnCancel": true,
      "forge.trueforge.baseUrl": BASE_URL,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "security.workspace.trust.enabled": false,
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "chat.disableAIFeatures": true,
      "window.restoreWindows": "none",
      "files.autoSave": "off",
      ...options.extraSettings,
    };
    const settingsFile = join(userData, "User", "settings.json");
    await writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
    return {
      prefix,
      temp,
      userData,
      extensions,
      workspace,
      settingsFile,
      settings,
      async updateSettings(patch) {
        Object.assign(settings, patch);
        await writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
      },
      launchArgs: [workspace.root, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
