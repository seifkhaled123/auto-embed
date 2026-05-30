import { Command } from "commander";
import {
  envApiKey,
  loadConfig,
  maskKey,
  PROVIDER_ENV,
} from "../config/index.js";
import {
  DEFAULT_MODELS,
  EmbeddingProviderName,
  MODEL_DIMENSIONS,
} from "../config/schema.js";
import { pc } from "../log.js";

interface Row {
  provider: EmbeddingProviderName;
  status: string;
  source: string;
  model: string;
  dim: string;
}

function describe(provider: EmbeddingProviderName, cfgKey: string | undefined): Row {
  const model = DEFAULT_MODELS[provider];
  const dimNum = MODEL_DIMENSIONS[model];
  const dim = dimNum ? String(dimNum) : "—";
  if (provider === "local") {
    return {
      provider,
      status: pc.green("OK"),
      source: pc.dim("no key required"),
      model,
      dim,
    };
  }
  const envName = PROVIDER_ENV[provider]!;
  const envValue = envApiKey(provider);
  if (envValue) {
    return {
      provider,
      status: pc.green("OK"),
      source: `env ${envName} = ${maskKey(envValue)}`,
      model,
      dim,
    };
  }
  if (cfgKey) {
    return {
      provider,
      status: pc.green("OK"),
      source: `config apiKeys.${provider} = ${maskKey(cfgKey)}`,
      model,
      dim,
    };
  }
  return {
    provider,
    status: pc.yellow("missing key"),
    source: pc.dim(`set ${envName} or run \`auto-embed init\``),
    model,
    dim,
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLen = (s: string) => s.replace(ANSI_RE, "").length;

export function buildProvidersCommand(): Command {
  return new Command("providers")
    .description("List embedding providers and the status of their configured keys")
    .action(async () => {
      const cfg = await loadConfig();
      const rows: Row[] = EmbeddingProviderName.options.map((p) => {
        const cfgKey = p === "local" ? undefined : cfg.apiKeys?.[p];
        return describe(p, cfgKey);
      });

      const headers = ["PROVIDER", "STATUS", "KEY", "DEFAULT MODEL", "DIM"];
      const cells: string[][] = rows.map((r) => [r.provider, r.status, r.source, r.model, r.dim]);
      const widths = headers.map((h, i) =>
        Math.max(h.length, ...cells.map((row) => visibleLen(row[i]!))),
      );

      const fmt = (row: string[]) =>
        row
          .map((c, i) => c + " ".repeat(Math.max(0, widths[i]! - visibleLen(c))))
          .join("  ");

      process.stdout.write(pc.dim(fmt(headers)) + "\n");
      for (const row of cells) {
        process.stdout.write(fmt(row) + "\n");
      }
    });
}
