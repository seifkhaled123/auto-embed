import { Command } from "commander";
import { log } from "../log.js";

export function buildConfigCommand(): Command {
  const config = new Command("config").description("Manage stored auto-embed config");

  config
    .command("get <key>")
    .description("Print a config value")
    .action(async () => {
      log.info("config get: not yet implemented (M1)");
    });

  config
    .command("set <key> <value>")
    .description("Set a config value")
    .action(async () => {
      log.info("config set: not yet implemented (M1)");
    });

  config
    .command("list")
    .description("List all config values (keys masked)")
    .action(async () => {
      log.info("config list: not yet implemented (M1)");
    });

  config
    .command("path")
    .description("Print the config file path")
    .action(async () => {
      log.info("config path: not yet implemented (M1)");
    });

  return config;
}
