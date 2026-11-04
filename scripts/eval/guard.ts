/**
 * Name guard for the eval harness: only throwaway TrueForge names of the exact form (or the end-to-end tests' `e2e-<pid>-forge-*`)
 * `forge-eval-<pid>-r<run>-agent` / `-mcp` / `-extras` may ever be created or deleted.
 */
const FORBIDDEN = new Set(["forge-agent", "forge-editor", "forge-editor-extras", "forge-inline"]);
const THROWAWAY = /^(?:forge-eval-\d+-r\d+-(?:agent|mcp|extras)|e2e-\d+-forge-(?:editor|editor-extras|agent|inline))$/;

export const agentName = (pid: number, run: number): string => `forge-eval-${pid}-r${run}-agent`;
export const mcpName = (pid: number, run: number): string => `forge-eval-${pid}-r${run}-mcp`;
export const extrasName = (pid: number, run: number): string => `forge-eval-${pid}-r${run}-extras`;

export function assertThrowaway(name: string): void {
  if (FORBIDDEN.has(name) || !THROWAWAY.test(name)) throw new Error(`SAFETY: refusing to touch "${name}" (only forge-eval-<pid>-r<run>-agent|mcp names are allowed)`);
}

export interface Snapshot {
  agents: string[];
  mcp: string[];
}

/** Names that differ between two snapshots; empty when TrueForge is exactly as before. */
export function snapshotDiff(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  for (const kind of ["agents", "mcp"] as const) {
    for (const n of after[kind]) if (!before[kind].includes(n)) out.push(`+${kind}:${n}`);
    for (const n of before[kind]) if (!after[kind].includes(n)) out.push(`-${kind}:${n}`);
  }
  return out;
}
