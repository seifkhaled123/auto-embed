import { Command } from "commander";
import { log } from "../log.js";

export function buildProvidersCommand(): Command {
  return new Command("providers")
    .description("List embedding providers and the status of their configured keys")
    .action(async () => {
      log.info("providers: not yet implemented (M1)");
    });
}
