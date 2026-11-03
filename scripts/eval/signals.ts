import type { TurnView } from "../../src/trueforge/events";
import { commandOf } from "../../src/trueforge/commandApprovals";
import { EXTRAS_TOOL_NAMES } from "../../src/mcp/tools/extras";

/** Informational scores derived from what the agent did (not part of pass/fail). */
export interface Signals {
  ranTests: boolean;
  usedDeferredLoading: boolean;
  usedScout: boolean;
}

const META_TOOLS = new Set(["list_tools", "get_tool_info", "call_tool", "get_tool_output_schema"]);

export function deriveSignals(view: TurnView | undefined): Signals {
  const calls = view?.toolCalls ?? [];
  const firstEdit = calls.findIndex((c) => (c.name === "propose_edit" || c.name === "create_file") && c.status !== "denied");
  const ranTests = calls.some((c, i) => c.name === "run_command" && c.status !== "denied" && c.response !== undefined && /\bpytest\b/.test(commandOf(c.args) ?? "") && (firstEdit < 0 ? true : i > firstEdit));
  const usedDeferredLoading = calls.some((c) => META_TOOLS.has(c.name) || (EXTRAS_TOOL_NAMES as readonly string[]).includes(c.name));
  const usedScout = calls.some((c) => c.name === "create_sub_agent") || (view?.threads ?? []).some((t) => t.id !== "main");
  return { ranTests, usedDeferredLoading, usedScout };
}
