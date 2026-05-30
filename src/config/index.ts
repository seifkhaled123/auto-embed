import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { configDir, configFile } from "./paths.js";
import {
  Config,
  ConfigSchema,
  DEFAULT_MODELS,
  EmbeddingProviderName,
  EMPTY_CONFIG,
  PROVIDER_ENV,
  VectorDbName,
} from "./schema.js";
import { maskKey, maskUrl } from "./mask.js";

export async function loadConfig(): Promise<Config> {
  const file = configFile();
  try {
    const raw = await fsp.readFile(file, "utf8");
    const json = JSON.parse(raw);
    return ConfigSchema.parse(json);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ...EMPTY_CONFIG };
    if (err instanceof z.ZodError) {
      throw new AutoEmbedError(
        `Config file at ${file} is invalid: ${err.issues[0]?.message ?? "unknown"}`,
        ExitCode.UserConfig,
        "Re-run `auto-embed init` to recreate it.",
      );
    }
    if (err instanceof SyntaxError) {
      throw new AutoEmbedError(
        `Config file at ${file} is not valid JSON.`,
        ExitCode.UserConfig,
        "Re-run `auto-embed init` to recreate it.",
      );
    }
    throw err;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  const dir = configDir();
  const file = configFile();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const data = JSON.stringify(cfg, null, 2);
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, file);
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    // ignore on platforms without POSIX perms (Windows)
  }
}

export function configFileExists(): boolean {
  return fs.existsSync(configFile());
}

export function configFilePath(): string {
  return configFile();
}

/** Resolve provider env-var key. Returns "" if none set. */
export function envApiKey(
  provider: EmbeddingProviderName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = PROVIDER_ENV[provider];
  if (!name) return "";
  return env[name] ?? "";
}

export interface ResolvedConfig {
  provider: EmbeddingProviderName;
  model: string;
  apiKey: string;
  db: VectorDbName;
}

/**
 * Resolve effective runtime config. Precedence (highest first):
 *   1. CLI overrides
 *   2. env vars (AUTO_EMBED_*, provider keys)
 *   3. config file
 *   4. built-in defaults
 *
 * Throws AutoEmbedError if a required key is missing.
 */
export function resolveRuntime(
  cfg: Config,
  overrides: { provider?: EmbeddingProviderName; model?: string; db?: VectorDbName } = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const provider: EmbeddingProviderName =
    overrides.provider ??
    (env.AUTO_EMBED_PROVIDER as EmbeddingProviderName | undefined) ??
    cfg.defaults?.provider ??
    "openai";

  if (!EmbeddingProviderName.options.includes(provider)) {
    throw new AutoEmbedError(
      `Unknown provider: ${provider}. Expected one of: ${EmbeddingProviderName.options.join(", ")}.`,
      ExitCode.UserConfig,
    );
  }

  const model =
    overrides.model ??
    env.AUTO_EMBED_MODEL ??
    cfg.defaults?.model ??
    cfg.models?.[provider] ??
    DEFAULT_MODELS[provider];

  const apiKey = provider === "local" ? "" : envApiKey(provider, env) || cfg.apiKeys?.[provider] || "";

  if (provider !== "local" && !apiKey) {
    const envVarName = PROVIDER_ENV[provider]!;
    throw new AutoEmbedError(
      `No API key found for provider "${provider}".`,
      ExitCode.UserConfig,
      `Run \`auto-embed init\` or set ${envVarName}.`,
    );
  }

  const db: VectorDbName =
    overrides.db ??
    (env.AUTO_EMBED_DB as VectorDbName | undefined) ??
    cfg.defaults?.db ??
    "chroma";

  if (!VectorDbName.options.includes(db)) {
    throw new AutoEmbedError(
      `Unknown vector DB: ${db}. Expected one of: ${VectorDbName.options.join(", ")}.`,
      ExitCode.UserConfig,
    );
  }

  return { provider, model, apiKey, db };
}

// ---------- Dotted get/set ----------

const SETTABLE_PATHS = new Set([
  "defaults.provider",
  "defaults.db",
  "defaults.model",
  "defaults.collection",
  "models.openai",
  "models.google",
  "models.voyage",
  "models.cohere",
  "models.local",
  "apiKeys.openai",
  "apiKeys.google",
  "apiKeys.voyage",
  "apiKeys.cohere",
  "apiKeys.pinecone",
  "apiKeys.qdrant",
  "dbs.pgvector.url",
  "dbs.pinecone.indexName",
  "dbs.qdrant.url",
  "dbs.chroma.url",
]);

export const KEY_PATHS = new Set([
  "apiKeys.openai",
  "apiKeys.google",
  "apiKeys.voyage",
  "apiKeys.cohere",
  "apiKeys.pinecone",
  "apiKeys.qdrant",
]);

export const URL_PATHS = new Set([
  "dbs.pgvector.url",
  "dbs.qdrant.url",
  "dbs.chroma.url",
]);

export function settablePaths(): string[] {
  return [...SETTABLE_PATHS];
}

export function setPath(cfg: Config, dotted: string, value: string): Config {
  if (!SETTABLE_PATHS.has(dotted)) {
    throw new AutoEmbedError(
      `Unknown config key: ${dotted}`,
      ExitCode.UserConfig,
      `Valid keys: ${[...SETTABLE_PATHS].join(", ")}`,
    );
  }
  const next: Config = JSON.parse(JSON.stringify(cfg));
  const parts = dotted.split(".");
  let obj = next as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const cur = obj[k];
    if (!cur || typeof cur !== "object") {
      const fresh: Record<string, unknown> = {};
      obj[k] = fresh;
      obj = fresh;
    } else {
      obj = cur as Record<string, unknown>;
    }
  }
  obj[parts[parts.length - 1]!] = value;
  return ConfigSchema.parse(next);
}

export function getPath(cfg: Config, dotted: string): string | undefined {
  const parts = dotted.split(".");
  let cur: unknown = cfg;
  for (const k of parts) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  if (cur === undefined || cur === null) return undefined;
  return String(cur);
}

/** Flat, mask-aware view for `config list`. */
export function flatten(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dotted of SETTABLE_PATHS) {
    const v = getPath(cfg, dotted);
    if (v === undefined) continue;
    if (KEY_PATHS.has(dotted)) out[dotted] = maskKey(v);
    else if (URL_PATHS.has(dotted)) out[dotted] = maskUrl(v);
    else out[dotted] = v;
  }
  return out;
}

export type { Config };
export {
  ConfigSchema,
  DEFAULT_MODELS,
  EmbeddingProviderName,
  EMPTY_CONFIG,
  PROVIDER_ENV,
  VectorDbName,
};

// re-export mask helpers for command code
export { maskKey, maskUrl };
// re-export path helpers
export { configDir };
export const _internal = { configFilePath: configFile, configDirPath: configDir, file: path.basename };
