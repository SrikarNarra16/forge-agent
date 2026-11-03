/**
 * Denylist for run_command: a safety net against obviously destructive or exfiltrating shell commands, checked
 * before the user is asked and again before the command runs. It is NOT a sandbox; the real protection is that
 * every command needs the user's approval. Pure and vscode-free.
 */
export type CommandCheck = { ok: true } | { ok: false; reason: string };

/** Splits a command line into simple commands at ; && || | & newlines, $( ) and backticks. */
export function splitCommands(command: string): string[] {
  return command
    .replace(/\$\(|`|\(|\)|\{|\}/g, ";")
    .split(/\|\||&&|[;|&\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const tokens = (simple: string): string[] => simple.split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ""));

/** True for a path that leaves the workspace: absolute, ~, $HOME, or climbing out with .. */
function outsideWorkspace(path: string, root: string): boolean {
  const p = path.replace(/^["']|["']$/g, "");
  if (p === "") return false;
  if (p.startsWith("~") || /^\$\{?HOME\}?/.test(p)) return true;
  if (p.startsWith("/")) {
    const r = root.replace(/\/+$/, "");
    return !(r !== "" && (p === r || p.startsWith(`${r}/`)));
  }
  return p.split("/").includes("..");
}

const DANGEROUS_RM_TARGET = (p: string, root: string): boolean => p === "." || p === "./" || p === ".." || p === "*" || p === "./*" || p === "/*" || p === "~" || p === "~/" || p === "~/*" || outsideWorkspace(p, root) || p === "/";

export function checkCommand(command: string, options: { root?: string } = {}): CommandCheck {
  const root = options.root ?? "";
  if (command.trim() === "") return { ok: false, reason: "The command is empty." };
  const deny = (reason: string): CommandCheck => ({ ok: false, reason });

  // pipe-to-shell downloads, on the whole line
  if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(command)) return deny("Piping a download into a shell (curl|sh, wget|sh) is not allowed.");
  if (/\b(?:ba|z|da|k)?sh\s+-c\s+["']?\s*\$\(\s*(?:curl|wget)\b/.test(command)) return deny("Running downloaded scripts is not allowed.");

  for (const simple of splitCommands(command)) {
    const t = tokens(simple);
    // skip leading VAR=value assignments and env/command/nohup wrappers
    let i = 0;
    while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i] ?? "") || ["env", "command", "nohup", "time", "exec", "builtin"].includes(t[i] ?? ""))) i++;
    const cmd = (t[i] ?? "").replace(/^.*\//, "");
    const args = t.slice(i + 1);
    if (cmd === "sudo" || cmd === "doas" || cmd === "su") return deny("Commands that escalate privileges (sudo, su) are not allowed.");
    if (["shutdown", "reboot", "halt", "poweroff", "init"].includes(cmd)) return deny(`${cmd} is not allowed.`);
    if (cmd === "mkfs" || cmd.startsWith("mkfs.")) return deny("Formatting file systems (mkfs) is not allowed.");
    if (cmd === "dd" && args.some((a) => /^of=\/dev\//.test(a))) return deny("Writing to a device with dd is not allowed.");
    if (cmd === "rm") {
      const flags = args.filter((a) => a.startsWith("-")).join("");
      const recursive = /r|R/.test(flags.replace(/^-+/g, "")) || args.includes("--recursive");
      const targets = args.filter((a) => !a.startsWith("-"));
      if (recursive && targets.some((p) => DANGEROUS_RM_TARGET(p, root))) return deny("Recursive deletion of the workspace, your home folder or paths outside the workspace is not allowed. Delete specific files you created, or ask the user.");
      if (targets.some((p) => p === "/" || p === "~" || p === "/*")) return deny("Deleting the root or home folder is not allowed.");
    }
    if (cmd === "git") {
      // options such as -C <dir> or -c k=v can precede the subcommand, so look at every word
      if (args.includes("push")) return deny("git push is not allowed: the user publishes changes themselves.");
      if (args.includes("clean")) return deny("git clean deletes untracked files and is not allowed.");
      if (args.includes("reset") && args.includes("--hard")) return deny("git reset --hard discards work and is not allowed.");
    }
  }

  // redirects / tee to paths outside the workspace
  for (const m of command.matchAll(/(?:^|[^<>&0-9])(?:\d?>>?|&>)\s*(["']?)([^\s;&|"']+)\1/g)) {
    const target = m[2] ?? "";
    if (target.startsWith("/dev/null") || target === "&1" || target === "&2") continue;
    if (outsideWorkspace(target, root)) return deny(`Writing to ${target} (outside the workspace) is not allowed. Edit files with propose_edit.`);
  }
  for (const m of command.matchAll(/\btee\s+(?:-[a-zA-Z]+\s+)*(["']?)([^\s;&|"']+)\1/g)) {
    if (outsideWorkspace(m[2] ?? "", root)) return deny(`Writing to ${m[2]} (outside the workspace) is not allowed.`);
  }
  return { ok: true };
}
