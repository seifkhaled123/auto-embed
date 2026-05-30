import { Command } from "commander";
import { log } from "../log.js";

export function buildPlanCommand(): Command {
  return new Command("plan")
    .description("Write an EmbedPlan for a file (alias for: embed <file> --plan-only)")
    .argument("<file>", "file to plan for")
    .option("--out <path>", "where to write the plan", "plan.json")
    .action(async () => {
      log.info("plan: not yet implemented (M3)");
    });
}
