import { Command } from "commander";
import { log } from "../log.js";

export function buildEmbedCommand(): Command {
  return new Command("embed")
    .description("Parse, chunk, embed, and upsert one or more files into a vector DB")
    .argument("<files...>", "files or globs to ingest")
    .option("--collection <name>", "vector-DB collection / index / table name")
    .option("--provider <name>", "openai | google | voyage | cohere | local")
    .option("--model <id>", "embedding model override")
    .option("--db <name>", "pgvector | pinecone | qdrant | chroma")
    .option("--local", "shortcut: provider=local + db=chroma at ./chroma")
    .option("--chunk-size <n>", "target chunk size in tokens", (v) => parseInt(v, 10))
    .option("--overlap <n>", "token overlap between chunks", (v) => parseInt(v, 10))
    .option("--splitter <type>", "recursive | markdown | pdf | html | code | jsonl | csv")
    .option("--metadata <kv>", "static metadata k=v,k=v attached to every chunk")
    .option("--plan [path]", "tune the plan with one LLM call, or reuse a saved plan")
    .option("--plan-only", "write the plan and stop")
    .option("--batch-size <n>", "embedding batch size", (v) => parseInt(v, 10))
    .option("--concurrency <n>", "parallel embedding requests", (v) => parseInt(v, 10))
    .option("--force", "ignore lockfile; re-embed and replace")
    .option("--dry-run", "show what would happen; embed nothing")
    .option("--out-vectors <path>", "also write vectors to a local .jsonl")
    .option("-y, --yes", "non-interactive mode")
    .action(async () => {
      log.info("embed: not yet implemented (M3+)");
    });
}
