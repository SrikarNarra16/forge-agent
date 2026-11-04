import type { WorkspaceHost } from "../mcp/host";

/**
 * The shell prefix run before every agent command (forge.commandPrefix). An explicit setting always wins. When it is
 * empty and the workspace has a Python virtual environment (`.venv/bin/activate`, else `venv/bin/activate`), the prefix
 * defaults to `. <dir>/bin/activate &&`, so `pytest` finds the project's packages. The effective prefix and where
 * it came from are shown in the panel's Context section, so it is never hidden.
 *
 * It uses the POSIX `.` (dot) command, not `source`, because commands run through `$SHELL -c` and fall back to `/bin/sh`,
 * which is dash on Debian/Ubuntu and has no `source`. `.` works in dash, bash and zsh.
 *
 * POSIX only, like run_command itself (it runs `$SHELL -c`): a Windows-style environment (`Scripts\activate` only) is
 * NOT detected and no prefix is invented for it; set forge.commandPrefix yourself there. To keep an existing venv from
 * being activated, set the prefix to a no-op such as `true &&`. Pure and vscode-free: the host is injected.
 */
export type PrefixSource = "setting" | "auto" | "none";

export interface EffectivePrefix {
  prefix: string;
  source: PrefixSource;
}

/** Candidate directories in priority order. `.venv` is the uv/poetry/IDE default, `venv` the older convention. */
export const VENV_DIRS = [".venv", "venv"] as const;

/** `. .venv/bin/activate &&` if the workspace has such an environment, else undefined. Never throws. */
export async function detectVenvPrefix(host: Pick<WorkspaceHost, "readText">): Promise<string | undefined> {
  for (const dir of VENV_DIRS) {
    try {
      // readText reads files regardless of the ignore rules that hide .venv from listings; any error = not there
      await host.readText(`${dir}/bin/activate`);
      return `. ${dir}/bin/activate &&`;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** The setting wins whenever it has any text; otherwise the detected prefix; otherwise none. */
export function effectivePrefix(setting: string, detected: string | undefined): EffectivePrefix {
  const explicit = setting.trim();
  if (explicit !== "") return { prefix: explicit, source: "setting" };
  if (detected) return { prefix: detected, source: "auto" };
  return { prefix: "", source: "none" };
}

/**
 * Keeps the detection result between runs. `effective()` is synchronous (the command runner reads it per command);
 * `refresh()` re-detects (activation, a settings change, the start of each run, so a venv created meanwhile is found).
 */
export class CommandPrefixResolver {
  private detected: string | undefined;
  private listeners = new Set<(effective: EffectivePrefix) => void>();

  constructor(
    private readonly host: Pick<WorkspaceHost, "readText">,
    private readonly getSetting: () => string,
  ) {}

  effective(): EffectivePrefix {
    return effectivePrefix(this.getSetting(), this.detected);
  }

  async refresh(): Promise<EffectivePrefix> {
    const before = this.effective();
    this.detected = await detectVenvPrefix(this.host);
    const now = this.effective();
    if (now.prefix !== before.prefix || now.source !== before.source) this.emit(now);
    return now;
  }

  /** Called when the effective prefix changes (also after a settings change, via `notify`). */
  onChange(listener: (effective: EffectivePrefix) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The setting changed: tell listeners the new effective value (no re-detection needed). */
  notify(): void {
    this.emit(this.effective());
  }

  private emit(effective: EffectivePrefix): void {
    for (const l of [...this.listeners]) l(effective);
  }
}
