import { Command } from "commander";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { ClackPromptDriver } from "../interactive/driver.js";
import { runFullConfiguration } from "../interactive/configuration.js";
import { log, pc } from "../log.js";

export function buildInitCommand(): Command {
  return new Command("init")
    .description("Interactive setup: pick embedding provider, paste key, pick vector DB.")
    .action(async () => {
      const prompt = new ClackPromptDriver();
      prompt.intro(pc.bold("auto-embed init"));
      const config = await runFullConfiguration(prompt);
      if (!config) throw new AutoEmbedError("Cancelled.", ExitCode.UserConfig);
      prompt.outro("Setup complete.");
      log.info("");
      log.info(pc.dim("Try: `auto-embed embed ./README.md --local`"));
    });
}
