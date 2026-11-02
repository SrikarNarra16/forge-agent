import { describe, expect, it } from "vitest";
import { buildTurnContext, INDEX_BUILDING_NOTE } from "../src/context/injection";
import { ContextIndex } from "../src/context/indexer";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost } from "./helpers/fakeHost";

async function ready() {
  const host = new FakeHost(FIXTURE_FILES, { gitignore: FIXTURE_GITIGNORE });
  const index = new ContextIndex();
  await index.build(host);
  return { host, index };
}

describe("buildTurnContext", () => {
  it("puts the context block first, then the user's request; the transcript shows only what was typed", async () => {
    const { host, index } = await ready();
    const out = await buildTurnContext(index, host, { text: "how does get_debug_flag read FLASK_DEBUG?", budgetTokens: 2000 });
    expect(out.message.startsWith("<context>")).toBe(true);
    expect(out.message).toContain("</context>\n\nUser request:\nhow does get_debug_flag read FLASK_DEBUG?");
    expect(out.display).toBe("how does get_debug_flag read FLASK_DEBUG?");
    expect(out.plan.items.length).toBeGreaterThan(0);
    expect(out.plan.usedTokens).toBeLessThanOrEqual(2000);
    expect(out.plan.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(out.blockTokens).toBeGreaterThan(0);
  });

  it("pins chips and typed @tokens, shows chips in the transcript and warns about unresolved ones", async () => {
    const { host, index } = await ready();
    const out = await buildTurnContext(index, host, {
      text: "explain @helpers.py and @nothing_here_xyz",
      chips: [{ kind: "symbol", value: "Helper" }],
      budgetTokens: 3000,
    });
    expect(out.display).toBe("explain @helpers.py and @nothing_here_xyz\n@#Helper");
    expect(out.plan.items.filter((i) => i.source === "mention").map((i) => i.path)).toContain("src/app/helpers.py");
    expect(out.plan.warnings.join("\n")).toMatch(/@nothing_here_xyz/);
    expect(out.message).toContain("Pinned by the user");
  });

  it("sends the plain text with a visible note when the index is not ready after the wait", async () => {
    const host = new FakeHost(FIXTURE_FILES, { gitignore: FIXTURE_GITIGNORE });
    const index = new ContextIndex(); // never built
    const started = Date.now();
    const out = await buildTurnContext(index, host, { text: "where is get_debug_flag", budgetTokens: 2000, waitMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.message).toBe("where is get_debug_flag");
    expect(out.plan.note).toBe(INDEX_BUILDING_NOTE);
    expect(out.plan.items).toEqual([]);
  });

  it("uses the index as soon as it becomes ready during the wait", async () => {
    const host = new FakeHost(FIXTURE_FILES, { gitignore: FIXTURE_GITIGNORE });
    const index = new ContextIndex();
    const pending = buildTurnContext(index, host, { text: "where is get_debug_flag", budgetTokens: 2000, waitMs: 2000 });
    void index.build(host);
    const out = await pending;
    expect(out.plan.note).toBeUndefined();
    expect(out.message).toContain("<context>");
  });

  it("sends plain text when nothing is relevant", async () => {
    const { host, index } = await ready();
    const out = await buildTurnContext(index, host, { text: "zzzqqq", budgetTokens: 2000 });
    expect(out.message).toBe("zzzqqq");
    expect(out.plan.items).toEqual([]);
    expect(out.plan.note).toBeUndefined();
  });
});
