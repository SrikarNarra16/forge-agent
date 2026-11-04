/** Shared by the runner (plain node) and the suite (inside the VS Code extension host). */
export interface E2eConfig {
  /** Temp copy of Flask at the pinned commit; the workspace VS Code opens. */
  workspace: string;
  /** Python with pytest/flask from the fixture venv. */
  python: string;
  repoRoot: string;
  prefix: string;
  live: boolean;
  /** Comma-separated scenario ids to run (default: all that apply). */
  only: string | undefined;
  resultFile: string;
  outDir: string;
  baseUrl: string;
  /** The temp --user-data-dir (its logs/ folder holds the Forge output channel). */
  userDataDir?: string;
  /** Estimated dollars one live pass may spend (aborts the remaining live scenarios). */
  liveBudgetUsd: number;
  /** Which part of the suite to run: the scenarios, or only the check that no hooks exist without FORGE_E2E. */
  suite: "scenarios" | "nohooks";
}

export interface ScenarioResult {
  id: string;
  name: string;
  live: boolean;
  status: "PASS" | "FAIL" | "SKIP";
  ms: number;
  detail: string;
  /** Free-form measurements (tokens, counts, timings) for the results table. */
  data?: Record<string, unknown>;
}
