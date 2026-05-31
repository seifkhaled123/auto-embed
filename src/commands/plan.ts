import fsp from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  DEFAULT_MODELS,
  EmbeddingProviderName,
  loadConfig,
} from "../config/index.js";
import { heuristicPlan } from "../plan/heuristic.js";
import { llmPlan, resolvePlannerProvider } from "../plan/llm.js";
import { log, pc } from "../log.js";

interface PlanOpts {
  out: string;
  provider?: EmbeddingProviderName;
  model?: string;
  llm?: boolean;
}

export function buildPlanCommand(): Command {
  return new Command("plan")
    .description("Write an EmbedPlan for a file (alias for: embed <file> --plan-only)")
    .argument("<file>", "file to plan for")
    .option("--out <path>", "where to write the plan", "plan.json")
    .option("--provider <name>", "embedding provider used to set embeddingModel")
    .option("--model <id>", "embedding model override")
    .option("--llm", "tune the plan with one LLM call instead of pure heuristic", false)
    .action(async (file: string, opts: PlanOpts) => {
      const cfg = await loadConfig();
      const provider = opts.provider ?? cfg.defaults?.provider ?? "openai";
      const model =
        opts.model ??
        cfg.defaults?.model ??
        cfg.models?.[provider] ??
        DEFAULT_MODELS[provider];

      const plan = opts.llm
        ? await tuneViaLlm(file, model)
        : heuristicPlan({ sourcePath: file, embeddingModel: model });

      const outPath = path.resolve(opts.out);
      await fsp.writeFile(outPath, JSON.stringify(plan, null, 2) + "\n");
      log.success(`wrote ${opts.llm ? "LLM-tuned" : "heuristic"} plan to ${pc.cyan(outPath)}`);
    });
}

async function tuneViaLlm(file: string, embeddingModel: string) {
  const { provider, apiKey } = resolvePlannerProvider();
  log.info(pc.dim(`tuning plan via ${provider}…`));
  return llmPlan({ sourcePath: file, embeddingModel, provider, apiKey });
}
