import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_FAKE_KEY, buildProviderUpsert, parseProvidersFile, resolveApiKeys, selectProviders } from "../src/trueforge/providers";

async function exampleFile(): Promise<unknown> {
  return JSON.parse(await readFile(join(__dirname, "..", "trueforge", "models.example.json"), "utf8")) as unknown;
}

describe("models.example.json", () => {
  it("parses and lists deepseek, groq and the demo-only broken-endpoint provider", async () => {
    const providers = parseProvidersFile(await exampleFile());
    expect(providers.map((p) => p.name)).toEqual(["deepseek", "groq", "broken-endpoint"]);
    expect(providers.find((p) => p.name === "broken-endpoint")?.demoOnly).toBe(true);
  });

  it("skips demo-only providers unless --with-broken", async () => {
    const providers = parseProvidersFile(await exampleFile());
    expect(selectProviders(providers, { withBroken: false }).map((p) => p.name)).toEqual(["deepseek", "groq"]);
    expect(selectProviders(providers, { withBroken: true })).toHaveLength(3);
  });
});

describe("keys are never read from the file", () => {
  it("rejects a providers file that contains key material", async () => {
    const file = (await exampleFile()) as { providers: Array<Record<string, unknown>> };
    for (const field of [{ api_key: "sk-1" }, { apiKey: "sk-1" }, { auth: { api_key: "sk-1" } }]) {
      const bad = { providers: [{ ...file.providers[0], ...field }] };
      expect(() => parseProvidersFile(bad)).toThrow(/invalid providers file/);
    }
  });

  it("resolves keys from the environment and reports missing variables", async () => {
    const providers = selectProviders(parseProvidersFile(await exampleFile()), { withBroken: false });
    const { keys, missing } = resolveApiKeys(providers, { DEEPSEEK_API_KEY: " ds-key ", GROQ_API_KEY: "" });
    expect(keys.get("deepseek")).toBe("ds-key");
    expect(missing).toEqual([{ provider: "groq", env: "GROQ_API_KEY" }]);
  });

  it("uses the fake key only for the demo-only provider", async () => {
    const providers = parseProvidersFile(await exampleFile());
    const { keys, missing } = resolveApiKeys(providers, { DEEPSEEK_API_KEY: "a", GROQ_API_KEY: "b" });
    expect(keys.get("broken-endpoint")).toBe(DEMO_FAKE_KEY);
    expect(missing).toEqual([]);
  });
});

describe("buildProviderUpsert", () => {
  it("builds the custom-provider body from the cheatsheet in SDK camelCase", async () => {
    const groq = parseProvidersFile(await exampleFile()).find((p) => p.name === "groq");
    expect(groq).toBeDefined();
    expect(buildProviderUpsert(groq!, "gk")).toEqual({
      manifest: {
        type: "custom",
        name: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        auth: { apiKey: "gk" },
        models: [{ name: "gpt-oss-120b", modelId: "openai/gpt-oss-120b", properties: { contextLength: 32000, maxOutputTokens: 4000 } }],
      },
    });
  });
});
