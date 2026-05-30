import fsp from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  DEFAULT_MODELS,
  EmbeddingProviderName,
  loadConfig,
} from "../config/index.js";
import { log, pc } from "../log.js";
import { heuristicPlan } from "../plan/heuristic.js";

interface PlanOpts {
  out: string;
  provider?: EmbeddingProviderName;
  model?: string;
}

export function buildPlanCommand(): Command {
  return new Command("plan")
    .description("Write a heuristic EmbedPlan for a file (alias for: embed <file> --plan-only)")
    .argument("<file>", "file to plan for")
    .option("--out <path>", "where to write the plan", "plan.json")
    .option("--provider <name>", "embedding provider used to set embeddingModel")
    .option("--model <id>", "embedding model override")
    .action(async (file: string, opts: PlanOpts) => {
      const cfg = await loadConfig();
      const provider = opts.provider ?? cfg.defaults?.provider ?? "openai";
      const model =
        opts.model ??
        cfg.defaults?.model ??
        cfg.models?.[provider] ??
        DEFAULT_MODELS[provider];
      const plan = heuristicPlan({ sourcePath: file, embeddingModel: model });
      const outPath = path.resolve(opts.out);
      await fsp.writeFile(outPath, JSON.stringify(plan, null, 2) + "\n");
      log.success(`wrote plan to ${pc.cyan(outPath)}`);
    });
}
