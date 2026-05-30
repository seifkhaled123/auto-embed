import { Command } from "commander";
import { log } from "../log.js";

export function buildInitCommand(): Command {
  return new Command("init")
    .description("Interactive setup: pick embedding provider and vector DB, save config")
    .action(async () => {
      log.info("init: not yet implemented (M1)");
    });
}
