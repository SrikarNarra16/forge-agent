import { serialization, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { z } from "zod";

/**
 * Model-provider file handling for scripts/tf-setup.ts: parses trueforge/models.{local,example}.json,
 * resolves API keys from environment variables (NEVER from the file) and builds the SDK upsert
 * request. Shared with tests, so it must not import the vscode API.
 */

/** Obviously fake key used for every opt-in demo provider (not a secret). */
export const DEMO_FAKE_KEY = "sk-fake-key-for-demo-providers-NOT-A-REAL-KEY";

const modelSchema = z.strictObject({
  name: z.string(),
  model_id: z.string(),
  properties: z.strictObject({
    context_length: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
  }),
});

const providerSchema = z.strictObject({
  _comment: z.string().optional(),
  type: z.literal("custom"),
  name: z.string(),
  base_url: z.url(),
  /** Name of the environment variable holding the key. Keys themselves are rejected by this strict schema. */
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name").optional(),
  /** Demo-only providers (Task C) never use a real key: they always get DEMO_FAKE_KEY and need no environment variable. */
  demoOnly: z.boolean().optional(),
  models: z.array(modelSchema).min(1),
}).refine((p) => p.demoOnly === true || p.apiKeyEnv !== undefined, { message: "apiKeyEnv is required (names the environment variable that holds the key)", path: ["apiKeyEnv"] });

const fileSchema = z.strictObject({
  _comment: z.string().optional(),
  providers: z.array(providerSchema),
});

export type ProviderEntry = z.infer<typeof providerSchema>;

export function parseProvidersFile(json: unknown): ProviderEntry[] {
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`invalid providers file: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data.providers;
}

/** Drops demo-only providers (e.g. broken-endpoint) unless explicitly requested; `onlyDemo` keeps ONLY them (no real keys needed). */
export function selectProviders(providers: readonly ProviderEntry[], opts: { withBroken: boolean; onlyDemo?: boolean }): ProviderEntry[] {
  if (opts.onlyDemo) return providers.filter((p) => p.demoOnly === true);
  return providers.filter((p) => opts.withBroken || p.demoOnly !== true);
}

export interface ResolvedKeys {
  keys: Map<string, string>;
  /** Providers whose env var is unset/empty (name -> env var name). */
  missing: Array<{ provider: string; env: string }>;
}

export function resolveApiKeys(providers: readonly ProviderEntry[], env: Readonly<Record<string, string | undefined>>): ResolvedKeys {
  const keys = new Map<string, string>();
  const missing: ResolvedKeys["missing"] = [];
  for (const p of providers) {
    if (p.demoOnly) {
      keys.set(p.name, DEMO_FAKE_KEY); // never read the environment for a demo provider: a real key must not reach a demo endpoint
      continue;
    }
    const envName = p.apiKeyEnv ?? "";
    const value = env[envName]?.trim();
    if (value) keys.set(p.name, value);
    else missing.push({ provider: p.name, env: envName });
  }
  return { keys, missing };
}

/** Body for PUT /api/v1/settings/model-providers (cheatsheet 1a), in SDK camelCase. */
export function buildProviderUpsert(provider: ProviderEntry, apiKey: string): TrueForgeApi.settings.UpdateModelProviderRequest {
  const wire = {
    type: provider.type,
    name: provider.name,
    base_url: provider.base_url,
    auth: { api_key: apiKey },
    models: provider.models,
  };
  const parsed = serialization.ModelProviderManifest.parse(wire, { unrecognizedObjectKeys: "fail" });
  if (!parsed.ok) throw new Error(`could not build provider "${provider.name}": ${parsed.errors.map((e) => e.message).slice(0, 3).join("; ")}`);
  return { manifest: parsed.value };
}
