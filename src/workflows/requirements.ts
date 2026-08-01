import {
  Config,
  EmbeddingProviderName,
  envApiKey,
  VectorDbName,
} from "../config/index.js";
import { DB_ENV } from "../config/schema.js";
import type {
  PlanMode,
  WorkflowRequirement,
  WorkflowResult,
} from "./types.js";

export interface RequirementInput {
  result: WorkflowResult;
  planMode: PlanMode;
  provider: EmbeddingProviderName;
  db: VectorDbName;
}

export function inspectWorkflowRequirements(
  input: RequirementInput,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): WorkflowRequirement[] {
  const missing: WorkflowRequirement[] = [];
  const embeds = input.result === "embed" || input.result === "embed-export";

  if (embeds && input.provider !== "local") {
    const provider = input.provider;
    if (!envApiKey(provider, env) && !config.apiKeys?.[provider]) {
      missing.push({ kind: "provider-key", provider });
    }
  }

  if (embeds && input.db === "pgvector") {
    if (!env[DB_ENV.pgvector.url] && !config.dbs?.pgvector?.url) {
      missing.push({ kind: "database-url", db: "pgvector" });
    }
  }

  if (embeds && input.db === "pinecone") {
    if (!env[DB_ENV.pinecone.apiKey] && !config.apiKeys?.pinecone) {
      missing.push({ kind: "database-key", db: "pinecone" });
    }
  }

  if (input.planMode === "llm" && !plannerKeyAvailable(config, env)) {
    missing.push({ kind: "planner-key" });
  }

  return missing;
}

function plannerKeyAvailable(config: Config, env: NodeJS.ProcessEnv): boolean {
  const explicit = env.AUTO_EMBED_PLAN_PROVIDER;
  if (explicit === "anthropic") return Boolean(env.ANTHROPIC_API_KEY);
  if (explicit === "openai") return Boolean(env.OPENAI_API_KEY || config.apiKeys?.openai);
  if (explicit === "google") return Boolean(env.GOOGLE_API_KEY || config.apiKeys?.google);
  return Boolean(
    env.ANTHROPIC_API_KEY ||
      env.OPENAI_API_KEY ||
      env.GOOGLE_API_KEY ||
      config.apiKeys?.openai ||
      config.apiKeys?.google,
  );
}
