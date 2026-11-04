/**
 * `npm run tf:setup`: idempotently configures a running local TrueForge from
 * trueforge/models.local.json (or models.example.json): model providers (PUT = create-or-replace)
 * and, when our MCP server is registered, the agents from agents/*.json.
 * API keys come only from the environment variables named by `apiKeyEnv`; they are never printed.
 * Flags: --with-broken (also register the demo-only providers broken-endpoint and badkey-deepseek),
 *        --only-demo (register ONLY those two: needs no API keys and touches no other provider or agent),
 *        --base-url <url>.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { TrueForgeError } from "@truefoundry/trueforge-sdk";
import {
  FORGE_EDITOR_SERVER,
  TRUEFORGE_START_COMMAND,
  createClient,
  describeError,
  ensureAgent,
  normalizeBaseUrl,
  parseAgentFile,
} from "../src/trueforge/client";
import { buildProviderUpsert, parseProvidersFile, resolveApiKeys, selectProviders } from "../src/trueforge/providers";

const root = join(__dirname, "..");

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readFirst(paths: readonly string[]): Promise<{ path: string; text: string }> {
  for (const path of paths) {
    try {
      return { path, text: await readFile(path, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new Error(`none of these files exist: ${paths.join(", ")}`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const onlyDemo = args.includes("--only-demo");
  const withBroken = args.includes("--with-broken") || onlyDemo;
  const baseUrl = normalizeBaseUrl(flagValue(args, "--base-url") ?? process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790");
  const client = createClient(baseUrl);

  try {
    const res = await fetch(`${baseUrl}/api/v1/capabilities`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`TrueForge is not reachable at ${baseUrl}.\nStart it first (terminal 1): npm run tf:start\n  = ${TRUEFORGE_START_COMMAND}`);
    return 1;
  }
  console.log(`TrueForge reachable at ${baseUrl}`);

  const file = await readFirst([join(root, "trueforge", "models.local.json"), join(root, "trueforge", "models.example.json")]);
  console.log(`Providers file: trueforge/${file.path.split("/").pop()}`);
  const selected = selectProviders(parseProvidersFile(JSON.parse(file.text) as unknown), { withBroken, onlyDemo });
  const skipped = parseProvidersFile(JSON.parse(file.text) as unknown).length - selected.length;
  if (skipped > 0 && !onlyDemo) console.log(`Skipping ${skipped} demo-only provider(s) (pass --with-broken to include).`);

  // A provider whose key variable is not set is skipped (you only need the providers you use), not an error;
  // it is an error only when nothing at all could be registered.
  const { keys, missing } = resolveApiKeys(selected, process.env);
  const skippedNoKey = new Set(missing.map((m) => m.provider));
  for (const m of missing) console.log(`Skipping provider "${m.provider}": environment variable ${m.env} is not set (keys are read from the environment, never from files).`);
  const providers = selected.filter((p) => !skippedNoKey.has(p.name));
  if (providers.length === 0) {
    console.error("No provider can be registered: no API key is set. Export at least one, e.g.: export DEEPSEEK_API_KEY=...  (GROQ_API_KEY=... is optional), then re-run.");
    return 1;
  }

  const existing = new Set<string>();
  try {
    const list = await client.settings.modelProviders.list();
    for (const p of list.data) existing.add(p.name);
  } catch {
    // Only used to word the output ("created" vs "replaced"); the PUT below is idempotent either way.
  }

  let failures = 0;
  for (const provider of providers) {
    try {
      const key = keys.get(provider.name) ?? "";
      await client.settings.modelProviders.createOrUpdate(buildProviderUpsert(provider, key));
      const verb = existing.has(provider.name) ? "replaced" : "created";
      console.log(`provider ${provider.name}: ${verb} (models: ${provider.models.map((m) => m.name).join(", ")})`);
    } catch (err) {
      failures++;
      console.error(`provider ${provider.name}: FAILED: ${describeError(err)}`);
    }
  }

  if (onlyDemo) {
    try {
      const models = await client.models.list();
      console.log(`Models available in TrueForge: ${models.data.map((m) => m.name).join(", ") || "(none)"}`);
    } catch (err) {
      console.error(`Could not list models: ${describeError(err)}`);
    }
    return failures > 0 ? 1 : 0;
  }

  // Agents can only be saved once the MCP server they reference is registered; the extension does
  // that on activation and then saves the agents itself.
  let mcpRegistered = true;
  try {
    await client.settings.mcpServers.get(FORGE_EDITOR_SERVER);
  } catch (err) {
    if (err instanceof TrueForgeError && err.statusCode === 404) mcpRegistered = false;
    else throw err;
  }
  const agentDir = join(root, "agents");
  const agentFiles = (await readdir(agentDir)).filter((f) => f.endsWith(".json")).sort();
  if (!mcpRegistered) {
    console.log(`agents: skipped (MCP server "${FORGE_EDITOR_SERVER}" is not registered yet). The extension registers it and saves ${agentFiles.join(", ")} on activation (F5).`);
  } else {
    for (const f of agentFiles) {
      try {
        const agent = parseAgentFile(JSON.parse(await readFile(join(agentDir, f), "utf8")) as unknown);
        const result = await ensureAgent(client, agent);
        console.log(`agent ${agent.name}: ${result.action} (id ${result.id})`);
      } catch (err) {
        failures++;
        console.error(`agent ${f}: FAILED: ${describeError(err)}`);
      }
    }
  }

  try {
    const models = await client.models.list();
    console.log(`Models available in TrueForge: ${models.data.map((m) => m.name).join(", ") || "(none)"}`);
  } catch (err) {
    console.error(`Could not list models: ${describeError(err)}`);
  }
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`tf-setup failed: ${describeError(err)}`);
    process.exit(1);
  },
);
