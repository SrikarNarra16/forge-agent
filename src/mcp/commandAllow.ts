/**
 * Opt-in auto-allow for a few commands (forge.autoAllowCommands.readOnly / .tests; both default OFF).
 *
 * This is applied AFTER the denylist (commandPolicy.ts) and is deliberately the opposite kind of check: instead of
 * looking for bad things in a command, the WHOLE command string must match a strict allow pattern. Anything this file
 * does not positively recognise returns `undefined`, and the normal Allow card is shown. Pure and vscode-free.
 *
 *   Tier 1 (readOnly): git status/diff/log/show/ls-files, ls, pwd, cat/head/tail/wc, grep/rg. Nothing is written and no
 *                      project code runs.
 *   Tier 2 (tests):    pytest / python -m pytest, ruff check (no --fix), mypy / python -m mypy. These write only caches,
 *                      BUT THEY EXECUTE WORKSPACE CODE (pytest imports and runs your tests and conftest.py; mypy plugins
 *                      come from the config). That is why it is a separate switch.
 *
 * The command is matched as the agent wrote it. The virtual-environment prefix Forge adds (`. .venv/bin/activate &&`) is
 * added by the command runner AFTER approval, so it never takes part in matching and cannot break it.
 *
 * How the matching stays strict:
 *  - characters that give a shell meaning beyond "words" are rejected anywhere in the string, even inside quotes:
 *    ; & | < > ( ) { } $ ` \ ! # newline, and control characters. That covers chaining, pipes, redirects, $( ), backticks,
 *    escapes, history expansion and comments. (A quoted `|` in a grep pattern therefore falls back to the Allow card; that
 *    is the price of not having to reason about shell quoting rules.)
 *  - unquoted `* ? [ ]` (globs) and a leading `~` (home) are rejected; quotes must balance and are only grouping.
 *  - the program must be one of the listed ones; every option must be on that program's whitelist (so --fix, -o, --output,
 *    --junitxml, --pre, -p, -c, -e ... are simply not recognised); `-k`/`-m` expressions use a small character set.
 *  - every path argument is relative, stays inside the workspace (no leading `/`, no `..` segment, no `~`) and may not
 *    point at secrets or tooling folders (.env*, .git, .ssh, .aws, .venv, node_modules, keys), which `read_file` hides too.
 */
export type AllowTier = 1 | 2;

export interface AllowSettings {
  readOnly: boolean;
  tests: boolean;
}

export interface AllowMatch {
  tier: AllowTier;
  /** "git status", "pytest", ...: what matched, for the log and the panel. */
  program: string;
}

/** Characters that are never accepted, quoted or not. */
const FORBIDDEN = /[;&|<>(){}$`\\!#\n\r\0\t]/;

interface Token {
  text: string;
  /** Any part of the token was inside quotes. */
  quoted: boolean;
}

/** Splits on spaces, honouring '...' and "..." only as grouping. Returns undefined for unbalanced quotes, unquoted globs or a leading ~. */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let quote: "'" | '"' | undefined;
  let has = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      has = true;
      continue;
    }
    if (ch === " ") {
      if (has) tokens.push({ text: current, quoted });
      current = "";
      quoted = false;
      has = false;
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[" || ch === "]") return undefined; // an unquoted glob
    current += ch;
    has = true;
  }
  if (quote) return undefined;
  if (has) tokens.push({ text: current, quoted });
  if (tokens.some((t) => !t.quoted && t.text.startsWith("~"))) return undefined;
  return tokens;
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=,./^-]+$/;
const DOTDOT_SEGMENT = /(^|\/)\.\.(\/|$)/;
const SENSITIVE_SEGMENT = /^(\.env.*|\.git|\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.venv|venv|node_modules|id_rsa.*|id_ed25519.*|.*\.pem|.*\.key|credentials.*)$/i;

/** A relative workspace path: no leading `/` or `-`, no `..` segment, no secrets/tooling folders, no `:`. */
function isWorkspacePath(text: string): boolean {
  if (text === "" || text.startsWith("/") || text.startsWith("-") || !SAFE_WORD.test(text) || DOTDOT_SEGMENT.test(text)) return false;
  return !text.split("/").some((segment) => SENSITIVE_SEGMENT.test(segment));
}

/** A pytest node id such as tests/test_a.py::TestX::test_y or tests/test_a.py::test_y[param] (brackets only when quoted). */
function isPytestTarget(t: Token): boolean {
  const [file, ...rest] = t.text.split("::");
  if (!isWorkspacePath(file ?? "")) return false;
  return rest.every((part) => (t.quoted ? /^[A-Za-z0-9_.,@%+=: [\]-]*$/ : /^[A-Za-z0-9_.-]+$/).test(part));
}

const isInt = (t: Token): boolean => /^\d{1,6}$/.test(t.text);
/** Expression of -k / -m: words and spaces only (and, or, not), no parentheses (already rejected globally). */
const isExpression = (t: Token): boolean => /^[A-Za-z0-9_.,= -]{1,200}$/.test(t.text) && !t.text.startsWith("-");

interface Spec {
  /** Flags without a value. */
  flags: ReadonlySet<string>;
  /** Flags that take the next token (or `=value`) and how that value must look. */
  valued?: Readonly<Record<string, (value: Token) => boolean>>;
  /** Positional arguments. */
  positional: (t: Token) => boolean;
  minPositional?: number;
  maxPositional?: number;
}

const set = (...items: string[]): ReadonlySet<string> => new Set(items);

/** Checks the arguments of one program against its spec. Combined short flags (-la, -sb) are allowed when every letter is a listed one-letter flag. */
function argsMatch(args: Token[], spec: Spec): boolean {
  let positional = 0;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfOptions && a.text === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.text.startsWith("-") && a.text !== "-") {
      if (a.quoted) return false;
      const eq = a.text.indexOf("=");
      const name = eq === -1 ? a.text : a.text.slice(0, eq);
      if (spec.flags.has(name) && eq === -1) continue;
      const check = spec.valued?.[name];
      if (check) {
        const value = eq !== -1 ? { text: a.text.slice(eq + 1), quoted: false } : args[++i];
        if (!value || !check(value)) return false;
        continue;
      }
      // -la, -sb, -vv: every letter must be a listed one-letter flag
      if (/^-[A-Za-z]{2,}$/.test(a.text) && [...a.text.slice(1)].every((c) => spec.flags.has(`-${c}`))) continue;
      // -n20 / -C3 style attached numbers
      const attached = /^(-[A-Za-z])(\d{1,6})$/.exec(a.text);
      if (attached && spec.valued?.[attached[1]!]) continue;
      return false;
    }
    if (!spec.positional(a)) return false;
    positional++;
  }
  return positional >= (spec.minPositional ?? 0) && positional <= (spec.maxPositional ?? 50);
}

const pathPositional = (t: Token): boolean => isWorkspacePath(t.text);

// ---- tier 1 ---------------------------------------------------------------------------------------------------------

const REV_BODY = "[A-Za-z0-9_@+=,^][A-Za-z0-9_@+=,./^-]{0,99}";
const REV = new RegExp(`^${REV_BODY}(~\\d{1,4})?$`);
const RANGE = new RegExp(`^${REV_BODY}\\.\\.\\.?${REV_BODY}$`);
/** A commit-ish: HEAD, HEAD^, HEAD~2, main, v1.2.3, abc123, origin/main, a..b, a...b (no leading `/` or `-`, no `..` path segments). */
const isRev = (t: Token): boolean => (REV.test(t.text) && !DOTDOT_SEGMENT.test(t.text)) || RANGE.test(t.text);
const gitPositional = (t: Token): boolean => isRev(t) || isWorkspacePath(t.text);

const GIT: Record<string, Spec> = {
  status: { flags: set("-s", "-b", "--short", "--branch", "--porcelain", "--no-color", "-uall", "-uno", "-unormal", "--ignored"), positional: pathPositional },
  diff: {
    flags: set("--stat", "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--no-color", "--no-ext-diff", "--no-textconv", "--numstat", "--summary", "-w", "--ignore-all-space"),
    valued: { "-U": isInt, "--unified": isInt },
    positional: gitPositional,
  },
  log: {
    flags: set("--oneline", "--stat", "--name-only", "--name-status", "--no-color", "--graph", "--decorate", "--no-decorate", "--no-merges", "--shortstat"),
    valued: { "-n": isInt, "--max-count": isInt, "--pretty": (v) => /^(oneline|short|medium|full|fuller)$/.test(v.text), "--format": (v) => /^(oneline|short|medium|full|fuller)$/.test(v.text) },
    positional: gitPositional,
  },
  show: {
    flags: set("--stat", "--name-only", "--name-status", "--no-color", "--no-ext-diff", "--no-textconv", "--shortstat", "--numstat", "--summary"),
    valued: { "-U": isInt },
    positional: gitPositional,
    maxPositional: 3,
  },
  "ls-files": { flags: set("-m", "-o", "-c", "-d", "--modified", "--others", "--cached", "--deleted", "--exclude-standard"), positional: pathPositional },
};

const LS: Spec = { flags: set("-a", "-l", "-h", "-1", "-R", "-t", "-S", "-r", "-A", "--all", "--human-readable"), positional: pathPositional };
const CAT: Spec = { flags: set("-n", "-b", "-s"), positional: pathPositional, minPositional: 1 };
const HEADTAIL: Spec = { flags: set("-q", "-v"), valued: { "-n": isInt, "-c": isInt }, positional: pathPositional, minPositional: 1 };
const WC: Spec = { flags: set("-l", "-w", "-c", "-m"), positional: pathPositional, minPositional: 1 };

/**
 * grep / rg: one pattern, then paths. Not allowed: -r/-R (grep would walk hidden files such as .env and, with -R, follow
 * symlinks; rg recurses by itself and skips hidden and ignored files), -e/-f (patterns from elsewhere), --pre (runs a
 * program), and the flags that mean something else in rg (-E encoding, -L follow, -r replace).
 */
const GREP_FLAGS = set("-n", "-i", "-l", "-L", "-c", "-w", "-v", "-E", "-F", "-H", "-h", "-s", "-I", "-q");
const RG_FLAGS = set("-n", "-i", "-l", "-c", "-w", "-v", "-F", "-H", "-s", "-q");
const SEARCH_VALUED: Record<string, (v: Token) => boolean> = { "-A": isInt, "-B": isInt, "-C": isInt, "-m": isInt };

function searchMatch(args: Token[], flags: ReadonlySet<string>): boolean {
  // the first non-option token is the pattern (any text without the forbidden characters), the rest are paths
  const options: Token[] = [];
  let pattern: Token | undefined;
  const paths: Token[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (pattern === undefined && a.text.startsWith("-") && !a.quoted) {
      options.push(a);
      if (SEARCH_VALUED[a.text]) options.push(args[++i] ?? { text: "x", quoted: false });
      continue;
    }
    if (pattern === undefined) pattern = a;
    else paths.push(a);
  }
  if (!pattern || pattern.text === "" || pattern.text.startsWith("-") || pattern.text.length > 300) return false;
  if (!argsMatch(options, { flags, valued: SEARCH_VALUED, positional: () => false })) return false;
  return paths.every(pathPositional);
}

function matchTier1(words: Token[]): string | undefined {
  const [program, ...args] = words;
  if (!program || program.quoted) return undefined;
  switch (program.text) {
    case "git": {
      const sub = args[0];
      const spec = sub && !sub.quoted ? GIT[sub.text] : undefined;
      return spec && sub && argsMatch(args.slice(1), spec) ? `git ${sub.text}` : undefined;
    }
    case "ls":
      return argsMatch(args, LS) ? "ls" : undefined;
    case "pwd":
      return args.length === 0 ? "pwd" : undefined;
    case "cat":
      return argsMatch(args, CAT) ? "cat" : undefined;
    case "head":
    case "tail":
      return argsMatch(args, HEADTAIL) ? program.text : undefined;
    case "wc":
      return argsMatch(args, WC) ? "wc" : undefined;
    case "grep":
      return searchMatch(args, GREP_FLAGS) ? "grep" : undefined;
    case "rg":
      return searchMatch(args, RG_FLAGS) ? "rg" : undefined;
    default:
      return undefined;
  }
}

// ---- tier 2 ---------------------------------------------------------------------------------------------------------

const PYTEST: Spec = {
  flags: set("-q", "-v", "-x", "-s", "-l", "-ra", "-rA", "-rf", "-rs", "-rx", "-rE", "--quiet", "--verbose", "--exitfirst", "--lf", "--last-failed", "--ff", "--failed-first", "--no-header", "--collect-only", "--co", "--showlocals", "--strict-markers"),
  valued: {
    "-k": (v) => isExpression(v),
    "-m": (v) => isExpression(v),
    "--tb": (v) => /^(auto|long|short|line|native|no)$/.test(v.text),
    "--maxfail": (v) => isInt(v),
    "--durations": (v) => isInt(v),
  },
  positional: isPytestTarget,
};
const RUFF_CHECK: Spec = {
  flags: set("--no-fix", "-q", "--quiet", "--statistics", "--show-source", "--no-cache", "--diff"),
  valued: { "--select": (v) => /^[A-Z0-9,]{1,60}$/.test(v.text), "--ignore": (v) => /^[A-Z0-9,]{1,60}$/.test(v.text) },
  positional: pathPositional,
};
const MYPY: Spec = {
  flags: set("--strict", "--ignore-missing-imports", "--no-error-summary", "--show-error-codes", "--no-pretty", "--pretty"),
  positional: pathPositional,
};

function matchTier2(words: Token[]): string | undefined {
  let [program, ...args] = words;
  if (!program || program.quoted) return undefined;
  // `python -m pytest` / `python3 -m ruff check` / `python -m mypy`
  if ((program.text === "python" || program.text === "python3") && args[0]?.text === "-m" && !args[0].quoted && args[1] && !args[1].quoted) {
    program = args[1];
    args = args.slice(2);
  }
  switch (program.text) {
    case "pytest":
      return argsMatch(args, PYTEST) ? "pytest" : undefined;
    case "ruff":
      return args[0]?.text === "check" && !args[0].quoted && argsMatch(args.slice(1), RUFF_CHECK) ? "ruff check" : undefined;
    case "mypy":
      return argsMatch(args, MYPY) ? "mypy" : undefined;
    default:
      return undefined;
  }
}

/** Which tier a command belongs to, whatever the switches say (undefined = not on the allow-list). Never throws. */
export function classifyCommand(command: string): AllowMatch | undefined {
  if (command.length === 0 || command.length > 600 || FORBIDDEN.test(command)) return undefined;
  const words = tokenize(command.trim());
  if (!words || words.length === 0) return undefined;
  const t1 = matchTier1(words);
  if (t1) return { tier: 1, program: t1 };
  const t2 = matchTier2(words);
  return t2 ? { tier: 2, program: t2 } : undefined;
}

/** The match, only if the switch for its tier is on. */
export function autoAllowMatch(command: string, settings: AllowSettings): AllowMatch | undefined {
  const m = classifyCommand(command);
  if (!m) return undefined;
  return (m.tier === 1 && settings.readOnly) || (m.tier === 2 && settings.tests) ? m : undefined;
}

export const TIER_LABEL: Record<AllowTier, string> = { 1: "tier 1: read-only", 2: "tier 2: tests" };
