import type { TextEdit } from "./hunks";

/**
 * Plans the three edits of "Forge: Fake Proposal": three lines spread over the file (about 15%, 50% and
 * 85% of the way down), each unique in the file and at least MIN_GAP lines apart, so the diff always
 * shows three separate hunks. Each gets a short marker comment appended. Pure.
 */
const MIN_GAP = 4;
const MIN_LINES = 12;
const TARGETS = [0.15, 0.5, 0.85] as const;

const HASH_COMMENT = new Set(["py", "sh", "rb", "yml", "yaml", "toml", "txt", "md", "rst", "cfg", "ini"]);

export type FakePlan = { ok: true; edits: TextEdit[] } | { ok: false; error: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

export function planFakeEdits(text: string, extension: string): FakePlan {
  const lines = text.split(/\r?\n/);
  if (lines.length < MIN_LINES) return { ok: false, error: `Open a file with at least ${MIN_LINES} lines to try the review (this one has ${lines.length}).` };
  const comment = HASH_COMMENT.has(extension.toLowerCase()) ? "#" : "//";

  const usable = (i: number): boolean => {
    const line = lines[i] ?? "";
    return line.trim().length >= 6 && /[A-Za-z0-9]/.test(line) && countOccurrences(text, line) === 1;
  };

  const chosen: number[] = [];
  for (const fraction of TARGETS) {
    const target = Math.min(lines.length - 1, Math.floor(lines.length * fraction));
    let found: number | undefined;
    for (let offset = 0; offset < lines.length && found === undefined; offset++) {
      for (const candidate of offset === 0 ? [target] : [target + offset, target - offset]) {
        if (candidate < 0 || candidate >= lines.length) continue;
        if (usable(candidate) && chosen.every((c) => Math.abs(c - candidate) >= MIN_GAP)) {
          found = candidate;
          break;
        }
      }
    }
    if (found === undefined) return { ok: false, error: "Could not find three distinct, well-separated lines in this file. Try a file with more varied content." };
    chosen.push(found);
  }
  chosen.sort((a, b) => a - b);
  return {
    ok: true,
    edits: chosen.map((i, n) => {
      const line = lines[i] ?? "";
      return { old_text: line, new_text: `${line}  ${comment} forge fake proposal ${n + 1}` };
    }),
  };
}
