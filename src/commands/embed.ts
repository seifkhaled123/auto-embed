import { Command } from "commander";
import {
  EmbedWorkflowOptions,
  runEmbedWorkflow,
} from "../workflows/embed.js";

export function buildEmbedCommand(): Command {
  return new Command("embed")
    .description("Parse, chunk, embed, and upsert one or more files into a vector DB")
    .argument("<files...>", "files, globs, or directories to ingest")
    .option("--collection <name>", "vector-DB collection / index / table name")
    .option("--provider <name>", "openai | google | voyage | cohere | local")
    .option("--model <id>", "embedding model override")
    .option("--db <name>", "pgvector | pinecone | qdrant | chroma")
    .option("--local", "shortcut: provider=local + db=chroma at ./chroma")
    .option("--chunk-size <n>", "target chunk size in tokens", parseInteger)
    .option("--overlap <n>", "token overlap between chunks", parseInteger)
    .option("--splitter <type>", "recursive | markdown | pdf | html | code | jsonl | csv")
    .option("--metadata <kv>", "static metadata k=v,k=v attached to every chunk")
    .option("--plan [path]", "tune the plan with one LLM call, or reuse a saved plan")
    .option("--plan-only", "write the plan and stop")
    .option(
      "--out <path>",
      "output path for --plan-only or a combined --show-chunks report",
    )
    .option("--batch-size <n>", "embedding batch size", parseInteger)
    .option("--concurrency <n>", "parallel embedding requests", parseInteger)
    .option("--force", "ignore lockfile; re-embed and replace")
    .option("--dry-run", "show what would happen; embed nothing")
    .option("--show-chunks", "write all would-be chunks to a .txt file; embed nothing")
    .option("--out-vectors <path>", "also atomically write all vectors to one .jsonl")
    .option("-y, --yes", "non-interactive mode")
    .action((inputArgs: string[], opts: EmbedWorkflowOptions) =>
      runEmbedWorkflow(inputArgs, opts),
    );
}

function parseInteger(value: string): number {
  return parseInt(value, 10);
}
