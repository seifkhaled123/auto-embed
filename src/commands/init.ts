import { Command } from "commander";
import * as p from "@clack/prompts";
import {
  Config,
  configFilePath,
  DEFAULT_MODELS,
  envApiKey,
  loadConfig,
  PROVIDER_ENV,
  saveConfig,
} from "../config/index.js";
import {
  DB_ENV,
  EmbeddingProviderName,
  VectorDbName,
} from "../config/schema.js";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { log, pc } from "../log.js";

function bail(): never {
  throw new AutoEmbedError("Cancelled.", ExitCode.UserConfig);
}

export function buildInitCommand(): Command {
  return new Command("init")
    .description("Interactive setup: pick embedding provider, paste key, pick vector DB.")
    .action(async () => {
      p.intro(pc.bold("auto-embed init"));

      const existing = await loadConfig();

      // --- Embedding provider ---
      const provider = (await p.select({
        message: "Which embedding provider?",
        options: [
          { value: "openai", label: "OpenAI", hint: "text-embedding-3-small (1536)" },
          { value: "google", label: "Google", hint: "text-embedding-004 (768)" },
          { value: "voyage", label: "Voyage", hint: "voyage-3 (1024)" },
          { value: "cohere", label: "Cohere", hint: "embed-english-v3.0 (1024)" },
          { value: "local", label: "Local (fastembed)", hint: "BAAI/bge-small-en-v1.5 (384) — no key" },
        ],
        initialValue: existing.defaults?.provider ?? "openai",
      })) as EmbeddingProviderName | symbol;
      if (p.isCancel(provider)) bail();

      let apiKey: string | undefined;
      if (provider !== "local") {
        const envName = PROVIDER_ENV[provider]!;
        const envValue = envApiKey(provider);
        if (envValue) {
          const reuse = await p.confirm({
            message: `${envName} is set in your environment. Use it without storing a copy?`,
            initialValue: true,
          });
          if (p.isCancel(reuse)) bail();
          if (!reuse) {
            const k = await p.password({
              message: `Paste your ${provider} API key`,
              validate: (v) => ((v ?? "").trim().length < 8 ? "Key looks too short." : undefined),
            });
            if (p.isCancel(k)) bail();
            apiKey = k.trim();
          }
        } else {
          const k = await p.password({
            message: `Paste your ${provider} API key`,
            validate: (v) => ((v ?? "").trim().length < 8 ? "Key looks too short." : undefined),
          });
          if (p.isCancel(k)) bail();
          apiKey = k.trim();
        }
      }

      // --- Vector DB ---
      const db = (await p.select({
        message: "Which vector database?",
        options: [
          { value: "chroma", label: "Chroma", hint: "local file dir or HTTP" },
          { value: "pgvector", label: "pgvector", hint: "Postgres connection string" },
          { value: "pinecone", label: "Pinecone", hint: "API key + index name" },
          { value: "qdrant", label: "Qdrant", hint: "URL + optional API key" },
        ],
        initialValue: existing.defaults?.db ?? "chroma",
      })) as VectorDbName | symbol;
      if (p.isCancel(db)) bail();

      const next: Config = {
        ...existing,
        defaults: {
          ...(existing.defaults ?? {}),
          provider,
          db,
        },
        apiKeys: { ...(existing.apiKeys ?? {}) },
        dbs: { ...(existing.dbs ?? {}) },
      };

      if (apiKey) {
        next.apiKeys = { ...(next.apiKeys ?? {}), [provider]: apiKey };
      }

      if (db === "chroma") {
        const envUrl = process.env[DB_ENV.chroma.url];
        const initial = existing.dbs?.chroma?.url ?? envUrl ?? "./chroma";
        const url = await p.text({
          message: "Chroma URL or local directory",
          initialValue: initial,
          placeholder: "./chroma or http://localhost:8000",
        });
        if (p.isCancel(url)) bail();
        if (!envUrl) next.dbs!.chroma = { url: url.trim() };
      } else if (db === "pgvector") {
        const envUrl = process.env[DB_ENV.pgvector.url];
        if (envUrl) {
          const reuse = await p.confirm({
            message: `DATABASE_URL is set in your environment. Use it without storing a copy?`,
            initialValue: true,
          });
          if (p.isCancel(reuse)) bail();
          if (!reuse) {
            const url = await p.text({
              message: "Postgres connection URL",
              placeholder: "postgres://user:pass@localhost:5432/dbname",
              validate: (v) =>
                (v ?? "").startsWith("postgres://") || (v ?? "").startsWith("postgresql://")
                  ? undefined
                  : "Must start with postgres:// or postgresql://",
            });
            if (p.isCancel(url)) bail();
            next.dbs!.pgvector = { url: url.trim() };
          }
        } else {
          const url = await p.text({
            message: "Postgres connection URL",
            placeholder: "postgres://user:pass@localhost:5432/dbname",
            initialValue: existing.dbs?.pgvector?.url,
            validate: (v) =>
              (v ?? "").startsWith("postgres://") || (v ?? "").startsWith("postgresql://")
                ? undefined
                : "Must start with postgres:// or postgresql://",
          });
          if (p.isCancel(url)) bail();
          next.dbs!.pgvector = { url: url.trim() };
        }
      } else if (db === "pinecone") {
        const envKey = process.env[DB_ENV.pinecone.apiKey];
        if (!envKey) {
          const k = await p.password({
            message: "Paste your Pinecone API key",
            validate: (v) => ((v ?? "").trim().length < 8 ? "Key looks too short." : undefined),
          });
          if (p.isCancel(k)) bail();
          next.apiKeys = { ...(next.apiKeys ?? {}), pinecone: k.trim() };
        } else {
          const reuse = await p.confirm({
            message: `${DB_ENV.pinecone.apiKey} is set in your environment. Use it without storing a copy?`,
            initialValue: true,
          });
          if (p.isCancel(reuse)) bail();
          if (!reuse) {
            const k = await p.password({
              message: "Paste your Pinecone API key",
              validate: (v) => ((v ?? "").trim().length < 8 ? "Key looks too short." : undefined),
            });
            if (p.isCancel(k)) bail();
            next.apiKeys = { ...(next.apiKeys ?? {}), pinecone: k.trim() };
          }
        }
        const indexName = await p.text({
          message: "Default Pinecone index name (optional, can override with --collection)",
          initialValue: existing.dbs?.pinecone?.indexName,
          placeholder: "leave blank to set per-run",
        });
        if (p.isCancel(indexName)) bail();
        const trimmed = indexName.trim();
        if (trimmed) next.dbs!.pinecone = { indexName: trimmed };
      } else if (db === "qdrant") {
        const envUrl = process.env[DB_ENV.qdrant.url];
        if (!envUrl) {
          const url = await p.text({
            message: "Qdrant URL",
            placeholder: "http://localhost:6333 or https://your-cluster.qdrant.io",
            initialValue: existing.dbs?.qdrant?.url ?? "http://localhost:6333",
          });
          if (p.isCancel(url)) bail();
          next.dbs!.qdrant = { url: url.trim() };
        }
        const envKey = process.env[DB_ENV.qdrant.apiKey];
        if (!envKey) {
          const k = await p.password({
            message: "Qdrant API key (optional, leave blank for unauthenticated)",
          });
          if (p.isCancel(k)) bail();
          const trimmed = k.trim();
          if (trimmed) next.apiKeys = { ...(next.apiKeys ?? {}), qdrant: trimmed };
        }
      }

      // --- Default model ---
      const defaultModel = DEFAULT_MODELS[provider as EmbeddingProviderName];
      const model = await p.text({
        message: `Default embedding model for ${provider}?`,
        initialValue: existing.models?.[provider as EmbeddingProviderName] ?? defaultModel,
        placeholder: defaultModel,
      });
      if (p.isCancel(model)) bail();
      next.models = {
        ...(next.models ?? {}),
        [provider as EmbeddingProviderName]: model.trim() || defaultModel,
      };

      await saveConfig(next);
      p.outro(`Saved to ${pc.cyan(configFilePath())}`);
      log.info("");
      log.info(pc.dim("Try: `auto-embed embed ./README.md --local`"));
    });
}
