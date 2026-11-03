import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { estimateTokens } from "../../util/tokens";
import { checkCommand } from "../commandPolicy";
import type { WorkspaceHost } from "../host";
import { errorResult, runTool, summarize, textResult, type ToolDeps } from "./common";

/**
 * run_command: runs a shell command in the workspace root AFTER the user approved it (TrueForge gates the tool by
 * name; the extension's approval handler shows the command). The denylist is checked again here. Output is
 * tail-truncated; the exit code is always reported. Cancelling (Stop) kills the process tree.
 */
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 300;
export const OUTPUT_MAX_LINES = 200;
export const OUTPUT_MAX_TOKENS = 4000;

export const COMMAND_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export const runCommandShape = {
  command: z.string().describe("Shell command to run in the workspace root, e.g. 'pytest tests/test_cli.py -q'. Short, non-interactive, no prompts."),
  timeout_s: z.number().optional().describe(`Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). The command is killed when it expires.`),
};
export const runCommandSchema = z.object(runCommandShape);
export type RunCommandArgs = z.infer<typeof runCommandSchema>;

/** Last `maxLines` lines and at most `maxTokens` tokens, with a footer that says what was cut. */
export function tailOutput(output: string, options: { maxLines?: number; maxTokens?: number } = {}): { text: string; truncated: boolean; totalLines: number; shownLines: number } {
  const maxLines = options.maxLines ?? OUTPUT_MAX_LINES;
  const maxTokens = options.maxTokens ?? OUTPUT_MAX_TOKENS;
  const lines = output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (output === "") return { text: "", truncated: false, totalLines: 0, shownLines: 0 };
  let kept = lines.slice(-maxLines);
  let used = 0;
  let start = kept.length;
  while (start > 0) {
    const cost = estimateTokens(kept[start - 1] ?? "") + 1;
    if (used + cost > maxTokens && start < kept.length) break;
    used += cost;
    start--;
  }
  kept = kept.slice(start);
  if (kept.length === 1 && estimateTokens(kept[0] ?? "") > maxTokens) kept = [`…${(kept[0] ?? "").slice(-(maxTokens * 4 - 4))}`];
  const truncated = kept.length < lines.length;
  const body = kept.join("\n");
  return { text: truncated ? `[output truncated: showing the last ${kept.length} of ${lines.length} lines]\n${body}` : body, truncated, totalLines: lines.length, shownLines: kept.length };
}

export function formatResult(result: { exitCode: number | null; output: string; timedOut: boolean; aborted: boolean; durationMs: number }, timeoutS: number): string {
  const tail = tailOutput(result.output);
  const seconds = (result.durationMs / 1000).toFixed(1);
  const head = result.timedOut
    ? `timed out after ${timeoutS}s and was killed (the output below is partial)`
    : result.aborted
      ? "cancelled (the user pressed Stop) and was killed"
      : `exit code ${String(result.exitCode)} (${seconds}s)`;
  return tail.text === "" ? `${head}\n(no output)` : `${head}\n${tail.text}`;
}

export async function runRunCommand(host: WorkspaceHost, deps: ToolDeps, args: RunCommandArgs, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "run_command", summarize({ command: args.command, timeout_s: args.timeout_s }), signal, async () => {
    const command = (args.command ?? "").trim();
    if (command === "") return errorResult("command is required. Pass the shell command to run, e.g. command='pytest tests/test_cli.py -q'.");
    const timeoutS = args.timeout_s ?? DEFAULT_TIMEOUT_S;
    if (!Number.isFinite(timeoutS) || timeoutS < 1) return errorResult(`timeout_s must be a number from 1 to ${MAX_TIMEOUT_S} (got ${String(args.timeout_s)}).`);
    const seconds = Math.min(timeoutS, MAX_TIMEOUT_S);
    const root = await host.rootPath();
    const verdict = checkCommand(command, { root });
    if (!verdict.ok) return errorResult(`Command not run: ${verdict.reason} Use a safer command, or edit files with propose_edit.`);
    if (deps.tickets && !deps.tickets.take(command)) return errorResult("Command not run: it was not approved by the user (or the run was cancelled). Ask the user, or use another approach.");
    if (!deps.commands) return errorResult("Running commands is not available in this editor session. Ask the user to run the command and paste the result.");
    deps.terminal?.started(command);
    const result = await deps.commands.run(command, { cwd: root, timeoutMs: seconds * 1000, signal, onOutput: (chunk) => deps.terminal?.output(chunk) });
    deps.terminal?.finished(result);
    return textResult(formatResult(result, seconds));
  });
}

export function registerRunCommand(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Run a shell command in the workspace root (needs the user's approval each time). Use it to run the project's own tests after you make edits (pytest, npm test), read the failures and fix them. Keep commands short and non-interactive. Never use it to edit or create files: use propose_edit / create_file. Returns the exit code and the END of the output (last ~200 lines). Destructive commands (rm -rf outside build folders, sudo, git push, curl|sh) are refused.",
      inputSchema: runCommandShape,
      annotations: { title: "Run command", ...COMMAND_ANNOTATIONS },
    },
    (args, extra) => runRunCommand(host, deps, args, extra.signal),
  );
}
