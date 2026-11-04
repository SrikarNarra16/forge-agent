import ignore from "ignore";

/**
 * Gitignore-aware path filtering shared by the vscode host and the test fake: .gitignore text plus hard
 * excludes that are never exposed to the agent for listing or searching.
 */

/** Directories never listed or searched (matched at any depth). */
export const HARD_EXCLUDE_DIRS = [".git", "node_modules", ".venv", "__pycache__", "dist", "out", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox"] as const;

/** Binary-ish extensions skipped by searches and maps. */
export const BINARY_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar", "whl", "egg", "pyc", "pyo",
  "so", "dylib", "dll", "exe", "woff", "woff2", "ttf", "eot", "mp3", "mp4", "mov", "vsix", "sqlite", "db",
] as const;

export interface IgnoreMatcher {
  /** `relPath` is workspace-relative and POSIX-separated. */
  isIgnored(relPath: string, isDir: boolean): boolean;
}

export function createIgnoreMatcher(gitignoreText?: string, extraPatterns: readonly string[] = []): IgnoreMatcher {
  const ig = ignore();
  ig.add(HARD_EXCLUDE_DIRS.map((d) => `${d}/`));
  ig.add(BINARY_EXTENSIONS.map((e) => `*.${e}`));
  if (gitignoreText) ig.add(gitignoreText);
  if (extraPatterns.length > 0) ig.add([...extraPatterns]);
  return {
    isIgnored(relPath, isDir) {
      const p = relPath.replace(/^\/+/, "").replace(/\/+$/, "");
      if (p === "") return false;
      return ig.ignores(isDir ? `${p}/` : p);
    },
  };
}

/** Precompiled include filter: true when a path matches any gitignore-syntax pattern in `globs` (all paths if empty). */
export function createGlobMatcher(globs: readonly string[]): (relPath: string) => boolean {
  if (globs.length === 0) return () => true;
  const ig = ignore().add([...globs]);
  return (relPath) => ig.ignores(relPath);
}
