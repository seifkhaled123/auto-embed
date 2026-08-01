import {
  Config,
  configFilePath,
  DEFAULT_MODELS,
  EmbeddingProviderName,
  envApiKey,
  flatten,
  loadConfig,
  maskKey,
  saveConfig,
  VectorDbName,
} from "../config/index.js";
import { DB_ENV, MODEL_DIMENSIONS, PROVIDER_ENV } from "../config/schema.js";
import { pc } from "../log.js";
import { CANCEL, PromptDriver } from "./driver.js";

const PROVIDER_OPTIONS = [
  { value: "openai" as const, label: "OpenAI", hint: "text-embedding-3-small (1536)" },
  { value: "google" as const, label: "Google", hint: "gemini-embedding-001 (3072)" },
  { value: "voyage" as const, label: "Voyage", hint: "voyage-3 (1024)" },
  { value: "cohere" as const, label: "Cohere", hint: "embed-english-v3.0 (1024)" },
  { value: "local" as const, label: "Local (fastembed)", hint: "no key required" },
];

const DB_OPTIONS = [
  { value: "chroma" as const, label: "Chroma", hint: "local directory or HTTP" },
  { value: "pgvector" as const, label: "pgvector", hint: "Postgres connection string" },
  { value: "pinecone" as const, label: "Pinecone", hint: "API key + index" },
  { value: "qdrant" as const, label: "Qdrant", hint: "URL + optional API key" },
];

export async function runFullConfiguration(
  prompt: PromptDriver,
  initial?: Config,
): Promise<Config | null> {
  initial ??= await loadConfig();
  const provider = await chooseProvider(prompt, initial.defaults?.provider ?? "openai");
  if (provider === null) return null;
  let next = await configureProvider(prompt, initial, provider);
  if (!next) return null;

  const db = await chooseDatabase(prompt, next.defaults?.db ?? "chroma");
  if (db === null) return null;
  next = await configureDatabase(prompt, next, db);
  if (!next) return null;

  next = {
    ...next,
    defaults: {
      ...(next.defaults ?? {}),
      provider,
      db,
      model: next.models?.[provider] ?? DEFAULT_MODELS[provider],
    },
  };
  await saveConfig(next);
  prompt.note(`Saved to ${configFilePath()}`, "Configuration ready");
  return next;
}

export async function runConfigurationMenu(prompt: PromptDriver): Promise<void> {
  while (true) {
    type Choice = "guided" | "provider" | "database" | "defaults" | "status" | "list" | "path" | "back";
    const current = await loadConfig();
    const choice = await prompt.select<Choice>({
      message: "Settings",
      options: [
        { value: "provider", label: "Embedding", hint: labels.provider(current.defaults?.provider ?? "openai") },
        { value: "database", label: "Vector database", hint: labels.database(current.defaults?.db ?? "chroma") },
        { value: "defaults", label: "Run defaults", hint: "model and collection" },
        { value: "status", label: "Provider status" },
        { value: "guided", label: "Setup", hint: "configure embedding and storage" },
        { value: "list", label: "View configuration", hint: "secrets are masked" },
        { value: "path", label: "Configuration file" },
        { value: "back", label: "Back" },
      ],
    });
    if (choice === CANCEL || choice === "back") return;

    if (choice === "guided") {
      await runFullConfiguration(prompt);
      continue;
    }
    if (choice === "list") {
      const values = flatten(await loadConfig());
      const lines = Object.entries(values).map(([key, value]) => `${key.padEnd(28)} ${value}`);
      prompt.note(lines.length ? lines.join("\n") : "(empty)", "Stored configuration");
      continue;
    }
    if (choice === "status") {
      prompt.note(providerStatusText(current), "Providers");
      continue;
    }
    if (choice === "path") {
      prompt.note(configFilePath(), "Configuration file");
      continue;
    }
    if (choice === "provider") {
      const cfg = await loadConfig();
      const provider = await chooseProvider(prompt, cfg.defaults?.provider ?? "openai");
      if (provider === null) continue;
      const next = await configureProvider(prompt, cfg, provider);
      if (next) {
        await saveConfig(next);
        prompt.note(`${provider} configuration saved.`, "Updated");
      }
      continue;
    }
    if (choice === "database") {
      const cfg = await loadConfig();
      const db = await chooseDatabase(prompt, cfg.defaults?.db ?? "chroma");
      if (db === null) continue;
      const next = await configureDatabase(prompt, cfg, db);
      if (next) {
        await saveConfig(next);
        prompt.note(`${db} configuration saved.`, "Updated");
      }
      continue;
    }
    await editDefaults(prompt);
  }
}

export async function chooseProvider(
  prompt: PromptDriver,
  initial: EmbeddingProviderName = "openai",
): Promise<EmbeddingProviderName | null> {
  const value = await prompt.select<EmbeddingProviderName>({
    message: "Embedding provider",
    options: PROVIDER_OPTIONS,
    initialValue: initial,
  });
  return value === CANCEL ? null : value;
}

export async function chooseDatabase(
  prompt: PromptDriver,
  initial: VectorDbName = "chroma",
): Promise<VectorDbName | null> {
  const value = await prompt.select<VectorDbName>({
    message: "Vector database",
    options: DB_OPTIONS,
    initialValue: initial,
  });
  return value === CANCEL ? null : value;
}

export async function configureProvider(
  prompt: PromptDriver,
  config: Config,
  provider: EmbeddingProviderName,
): Promise<Config | null> {
  const next = cloneConfig(config);

  if (provider !== "local") {
    const envName = PROVIDER_ENV[provider]!;
    const envValue = envApiKey(provider);
    const stored = next.apiKeys?.[provider];
    let needsKey = true;

    if (envValue) {
      const reuse = await prompt.confirm({
        message: `${envName} is set. Use it without storing a copy?`,
        initialValue: true,
      });
      if (reuse === CANCEL) return null;
      needsKey = !reuse;
    } else if (stored) {
      const reuse = await prompt.confirm({
        message: `Keep the saved ${provider} key (${maskKey(stored)})?`,
        initialValue: true,
      });
      if (reuse === CANCEL) return null;
      needsKey = !reuse;
    }

    if (needsKey) {
      const key = await prompt.password({
        message: `${provider} API key`,
        validate: validateKey,
      });
      if (key === CANCEL) return null;
      next.apiKeys = { ...(next.apiKeys ?? {}), [provider]: key.trim() };
    }
  }

  const defaultModel = DEFAULT_MODELS[provider];
  const model = await prompt.text({
    message: `${provider} model`,
    initialValue: next.models?.[provider] ?? defaultModel,
    placeholder: defaultModel,
    validate: (value) => (value ?? "").trim() ? undefined : "Enter a model ID.",
  });
  if (model === CANCEL) return null;
  next.models = { ...(next.models ?? {}), [provider]: model.trim() || defaultModel };
  return next;
}

export async function configureDatabase(
  prompt: PromptDriver,
  config: Config,
  db: VectorDbName,
): Promise<Config | null> {
  const next = cloneConfig(config);
  next.dbs = { ...(next.dbs ?? {}) };

  if (db === "chroma") {
    const envUrl = process.env[DB_ENV.chroma.url];
    const url = await prompt.text({
      message: "Chroma URL or local directory",
      initialValue: next.dbs.chroma?.url ?? envUrl ?? "./chroma",
      placeholder: "./chroma or http://localhost:8000",
      validate: nonEmpty("Enter a Chroma URL or directory."),
    });
    if (url === CANCEL) return null;
    if (!envUrl) next.dbs.chroma = { url: url.trim() };
    return next;
  }

  if (db === "pgvector") {
    const envUrl = process.env[DB_ENV.pgvector.url];
    if (envUrl) {
      const reuse = await prompt.confirm({
        message: `${DB_ENV.pgvector.url} is set. Use it without storing a copy?`,
        initialValue: true,
      });
      if (reuse === CANCEL) return null;
      if (reuse) return next;
    }
    const url = await prompt.text({
      message: "Postgres connection URL",
      initialValue: next.dbs.pgvector?.url,
      placeholder: "postgres://user:pass@localhost:5432/dbname",
      validate: validatePostgresUrl,
    });
    if (url === CANCEL) return null;
    next.dbs.pgvector = { url: url.trim() };
    return next;
  }

  if (db === "pinecone") {
    const envKey = process.env[DB_ENV.pinecone.apiKey];
    const stored = next.apiKeys?.pinecone;
    let needsKey = !envKey && !stored;
    if (envKey) {
      const reuse = await prompt.confirm({
        message: `${DB_ENV.pinecone.apiKey} is set. Use it without storing a copy?`,
        initialValue: true,
      });
      if (reuse === CANCEL) return null;
      needsKey = !reuse;
    } else if (stored) {
      const reuse = await prompt.confirm({
        message: `Keep the saved Pinecone key (${maskKey(stored)})?`,
        initialValue: true,
      });
      if (reuse === CANCEL) return null;
      needsKey = !reuse;
    }
    if (needsKey) {
      const key = await prompt.password({ message: "Pinecone API key", validate: validateKey });
      if (key === CANCEL) return null;
      next.apiKeys = { ...(next.apiKeys ?? {}), pinecone: key.trim() };
    }
    const indexName = await prompt.text({
      message: "Default Pinecone index name (optional)",
      initialValue: next.dbs.pinecone?.indexName,
      placeholder: "leave blank to choose per run",
    });
    if (indexName === CANCEL) return null;
    if (indexName.trim()) next.dbs.pinecone = { indexName: indexName.trim() };
    return next;
  }

  const envUrl = process.env[DB_ENV.qdrant.url];
  if (!envUrl) {
    const url = await prompt.text({
      message: "Qdrant URL",
      initialValue: next.dbs.qdrant?.url ?? "http://localhost:6333",
      placeholder: "http://localhost:6333 or https://your-cluster.qdrant.io",
      validate: nonEmpty("Enter a Qdrant URL."),
    });
    if (url === CANCEL) return null;
    next.dbs.qdrant = { url: url.trim() };
  }

  const envKey = process.env[DB_ENV.qdrant.apiKey];
  const stored = next.apiKeys?.qdrant;
  if (!envKey) {
    const key = await prompt.password({
      message: stored
        ? `Qdrant API key (leave blank to keep ${maskKey(stored)})`
        : "Qdrant API key (optional)",
    });
    if (key === CANCEL) return null;
    if (key.trim()) next.apiKeys = { ...(next.apiKeys ?? {}), qdrant: key.trim() };
  }
  return next;
}

async function editDefaults(prompt: PromptDriver): Promise<void> {
  const cfg = await loadConfig();
  const provider = await chooseProvider(prompt, cfg.defaults?.provider ?? "openai");
  if (provider === null) return;
  const db = await chooseDatabase(prompt, cfg.defaults?.db ?? "chroma");
  if (db === null) return;
  const model = await prompt.text({
    message: "Default model",
    initialValue: cfg.models?.[provider] ?? DEFAULT_MODELS[provider],
    validate: nonEmpty("Enter a model ID."),
  });
  if (model === CANCEL) return;
  const collection = await prompt.text({
    message: "Default collection (optional)",
    initialValue: cfg.defaults?.collection,
    placeholder: "derive from each filename",
    validate: validateOptionalCollection,
  });
  if (collection === CANCEL) return;
  const next: Config = {
    ...cfg,
    defaults: {
      ...(cfg.defaults ?? {}),
      provider,
      db,
      model: model.trim(),
      ...(collection.trim() ? { collection: collection.trim() } : {}),
    },
  };
  if (!collection.trim() && next.defaults) delete next.defaults.collection;
  await saveConfig(next);
  prompt.note("Provider, database, model, and collection defaults updated.", "Defaults saved");
}

function validateKey(value: string | undefined): string | undefined {
  return (value ?? "").trim().length < 8 ? "Key looks too short." : undefined;
}

function validatePostgresUrl(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  return text.startsWith("postgres://") || text.startsWith("postgresql://")
    ? undefined
    : "Must start with postgres:// or postgresql://";
}

function validateOptionalCollection(value: string | undefined): string | undefined {
  const text = (value ?? "").trim();
  if (!text) return undefined;
  return /^[a-z0-9][a-z0-9_-]*$/.test(text)
    ? undefined
    : "Use lowercase letters, numbers, hyphens, or underscores.";
}

function nonEmpty(message: string): (value: string | undefined) => string | undefined {
  return (value) => (value ?? "").trim() ? undefined : message;
}

function cloneConfig(config: Config): Config {
  return JSON.parse(JSON.stringify(config)) as Config;
}

export function providerStatusText(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return EmbeddingProviderName.options.map((provider) => {
    const model = config.models?.[provider] ?? DEFAULT_MODELS[provider];
    const dimensions = MODEL_DIMENSIONS[model] ?? "custom dimensions";
    const suffix = ` · ${model} · ${dimensions}`;
    if (provider === "local") return `${provider.padEnd(8)} ready      no key required${suffix}`;
    const envName = PROVIDER_ENV[provider]!;
    const envValue = envApiKey(provider, env);
    const stored = config.apiKeys?.[provider];
    if (envValue) return `${provider.padEnd(8)} ready      env ${envName} = ${maskKey(envValue)}${suffix}`;
    if (stored) return `${provider.padEnd(8)} ready      config = ${maskKey(stored)}${suffix}`;
    return `${provider.padEnd(8)} missing    set ${envName} or configure it here${suffix}`;
  }).join("\n");
}

export const labels = {
  provider: (provider: EmbeddingProviderName) => PROVIDER_OPTIONS.find((item) => item.value === provider)?.label ?? provider,
  database: (db: VectorDbName) => DB_OPTIONS.find((item) => item.value === db)?.label ?? db,
  configured: pc.green("configured"),
};
