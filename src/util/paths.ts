import * as path from "node:path";

/**
 * Path utilities. `isInside` is the guard that keeps every agent-supplied path
 * within the workspace root (no `..` escapes, no absolute paths elsewhere).
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
