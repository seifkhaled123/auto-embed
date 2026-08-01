import { Command } from "commander";
import type { EmbeddingProviderName } from "../config/index.js";
import { runEmbedWorkflow } from "../workflows/embed.js";

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
    .action((file: string, opts: PlanOpts) =>
      runEmbedWorkflow([file], {
        provider: opts.provider,
        model: opts.model,
        plan: opts.llm ? true : undefined,
        planOnly: true,
        out: opts.out,
      }),
    );
}
