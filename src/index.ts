import { Command } from "commander";
import { buildInitCommand } from "./commands/init.js";
import { buildEmbedCommand } from "./commands/embed.js";
import { buildPlanCommand } from "./commands/plan.js";
import { buildConfigCommand } from "./commands/config.js";
import { buildProvidersCommand } from "./commands/providers.js";
import { isAutoEmbedError } from "./errors.js";
import { log, setVerbose, isVerbose } from "./log.js";

const VERSION = "0.0.0";

function buildProgram(): Command {
  const program = new Command();
  program
    .name("auto-embed")
    .description(
      "Zero-config CLI that ingests files into vector databases for RAG projects.",
    )
    .version(VERSION, "-V, --version", "show version")
    .option("--verbose", "verbose logging", false);

  program.hook("preAction", (thisCmd) => {
    const opts = thisCmd.optsWithGlobals();
    if (opts.verbose) setVerbose(true);
  });

  program.addCommand(buildInitCommand());
  program.addCommand(buildEmbedCommand(), { isDefault: true });
  program.addCommand(buildPlanCommand());
  program.addCommand(buildConfigCommand());
  program.addCommand(buildProvidersCommand());

  return program;
}

async function main() {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isAutoEmbedError(err)) {
      log.error(err.message);
      if (err.hint) log.hint(err.hint);
      if (isVerbose() && err.stack) process.stderr.write(err.stack + "\n");
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    if (isVerbose() && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  }
}

await main();
