import { describe, expect, it } from "vitest";
import { FORGE_EDITOR_SERVER, buildMcpServerUpsert, sessionUrl } from "../src/trueforge/client";

describe("buildMcpServerUpsert", () => {
  it("builds the exact remote header-auth body from the API cheatsheet", () => {
    expect(buildMcpServerUpsert("http://127.0.0.1:41234/mcp", "tok123")).toEqual({
      manifest: {
        type: "remote",
        name: "forge-editor",
        url: "http://127.0.0.1:41234/mcp",
        description: "Forge VS Code editor tools (read, search, edit, run)",
        auth: { type: "header", headers: { Authorization: "Bearer tok123" } },
      },
    });
    expect(FORGE_EDITOR_SERVER).toBe("forge-editor");
  });

  it("only puts the token in the auth header", () => {
    const body = buildMcpServerUpsert("http://127.0.0.1:1/mcp", "SECRET-TOKEN");
    const withoutAuth = { ...body.manifest, auth: undefined };
    expect(JSON.stringify(withoutAuth)).not.toContain("SECRET-TOKEN");
  });
});

describe("sessionUrl", () => {
  it("links to the TrueForge UI session page", () => {
    expect(sessionUrl("http://localhost:8790/", "abc")).toBe("http://localhost:8790/sessions/abc");
  });
});
