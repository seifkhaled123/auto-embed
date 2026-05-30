import { Command } from "commander";
import {
  configFilePath,
  flatten,
  getPath,
  KEY_PATHS,
  loadConfig,
  maskKey,
  maskUrl,
  saveConfig,
  settablePaths,
  setPath,
  URL_PATHS,
} from "../config/index.js";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { log, pc } from "../log.js";

function maskedDisplay(key: string, value: string): string {
  if (KEY_PATHS.has(key)) return maskKey(value);
  if (URL_PATHS.has(key)) return maskUrl(value);
  return value;
}

export function buildConfigCommand(): Command {
  const cmd = new Command("config").description("Read and write auto-embed configuration.");

  cmd
    .command("set <key> <value>")
    .description(`Set a config value. Valid keys: ${settablePaths().join(", ")}`)
    .action(async (key: string, value: string) => {
      const cfg = await loadConfig();
      const next = setPath(cfg, key, value);
      await saveConfig(next);
      log.success(`set ${pc.bold(key)} = ${maskedDisplay(key, value)}`);
    });

  cmd
    .command("get <key>")
    .description("Read a config value (API keys and DB URLs are masked).")
    .action(async (key: string) => {
      const cfg = await loadConfig();
      const raw = getPath(cfg, key);
      if (raw === undefined) {
        throw new AutoEmbedError(`No value set for ${key}`, ExitCode.UserConfig);
      }
      process.stdout.write(maskedDisplay(key, raw) + "\n");
    });

  cmd
    .command("list")
    .description("List all stored config (API keys and DB URLs masked).")
    .action(async () => {
      const cfg = await loadConfig();
      const flat = flatten(cfg);
      const keys = Object.keys(flat);
      if (keys.length === 0) {
        log.info(pc.dim("(empty) — run `auto-embed init` to get started"));
        return;
      }
      const width = Math.max(...keys.map((k) => k.length));
      for (const k of keys) {
        process.stdout.write(`${k.padEnd(width)}  ${flat[k]}\n`);
      }
    });

  cmd
    .command("path")
    .description("Print the config file path.")
    .action(() => {
      process.stdout.write(configFilePath() + "\n");
    });

  return cmd;
}
