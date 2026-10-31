import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "../src/mcp/tools/common";

describe("resolveWorkspacePath", () => {
  const root = "/work";

  it("resolves relative paths and the root", () => {
    expect(resolveWorkspacePath(root, "src/app/helpers.py")).toEqual({ ok: true, rel: "src/app/helpers.py", abs: "/work/src/app/helpers.py" });
    expect(resolveWorkspacePath(root, "./src//app/../app/helpers.py")).toMatchObject({ ok: true, rel: "src/app/helpers.py" });
    expect(resolveWorkspacePath(root, undefined)).toEqual({ ok: true, rel: "", abs: root });
    expect(resolveWorkspacePath(root, ".")).toMatchObject({ ok: true, rel: "" });
  });

  it("accepts an absolute path that is inside the workspace", () => {
    expect(resolveWorkspacePath(root, "/work/src/a.py")).toMatchObject({ ok: true, rel: "src/a.py" });
  });

  it("rejects traversal, with a message that teaches the fix", () => {
    for (const bad of ["../etc/passwd", "src/../../etc/passwd", "..", "src/../..", "..\\secret"]) {
      const r = resolveWorkspacePath(root, bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/outside the workspace.*relative to the workspace root/s);
    }
  });

  it("rejects absolute paths outside the root, including prefix look-alikes", () => {
    for (const bad of ["/etc/passwd", "/work-other/file.py", "/"]) {
      expect(resolveWorkspacePath(root, bad).ok, bad).toBe(false);
    }
  });

  it("rejects anything under .git, node_modules and .venv, however it is spelled", () => {
    for (const bad of [".git/config", "node_modules/pkg/index.js", ".venv/lib/x.py", "src/node_modules/x.js", "src/../.git/HEAD", ".GIT/config", "/work/.git/config"]) {
      const r = resolveWorkspacePath(root, bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/Access denied.*never exposed/s);
    }
  });

  it("can require a non-empty path", () => {
    const r = resolveWorkspacePath(root, "", { allowRoot: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/path is required/i);
  });

  it("does not block names that merely contain a blocked word", () => {
    expect(resolveWorkspacePath(root, "src/my.git/notes.txt").ok).toBe(true);
    expect(resolveWorkspacePath(root, "docs/node_modules_guide.md").ok).toBe(true);
  });
});
