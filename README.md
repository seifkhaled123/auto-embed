# auto-embed

> Zero-config CLI that ingests files into vector databases for RAG projects. Parse, chunk, embed, upsert — one command.

`auto-embed` is the file-side of a RAG pipeline as a single command. It parses your docs (Markdown, PDF, HTML, DOCX, CSV, JSON, code), chunks them with a token-aware splitter, calls an embedding provider, and upserts the vectors into your vector DB. Re-runs are idempotent: unchanged files cost zero API calls, edited files re-embed only what changed.

- **One command, full pipeline.** Parse → chunk → embed → upsert.
- **Zero-key prototype.** `--local` runs end-to-end with fastembed + Chroma — no API keys.
- **Idempotent.** A `.auto-embed/` lockfile makes re-runs cheap; editing a paragraph re-embeds only the affected chunks.
- **5 embedding providers, 4 vector DBs.** OpenAI · Google · Voyage · Cohere · fastembed. pgvector · Pinecone · Qdrant · Chroma.
- **Provider-agnostic.** Same flags, same UX, same lockfile shape.
- **CI-friendly.** Deterministic chunk IDs, exit codes that mean things, no interactive prompts in non-TTY.

Sibling of [`auto-seed`](https://www.npmjs.com/package/auto-seed) — same opinionated, one-command philosophy.

## What's new in v1.2

- **Real repository inputs.** Mix explicit files, quoted globs, and recursive directories. Paths are normalized, de-duplicated, and sorted before ingestion; repository build/cache directories and symlink recursion are skipped safely.
- **Content-safe fallback.** Unknown text extensions fall back with a warning, while binary content and malformed supported formats fail clearly instead of producing garbage chunks.
- **Inspectable atomic vectors.** `--out-vectors <file>.jsonl` writes one ordered, credential-free vector export and exposes it only after the entire run succeeds.
- **Crash-safe continuation.** Batch checkpoints prevent successful embeddings from being paid for twice. Replacement vectors land before old IDs are deleted, and interrupts leave resumable state.
- **Bounded large-file paths.** TXT, logs, supported code, CSV, and JSONL stream through hashing, parsing, chunking, and batching. Whole-document formats have an explicit 100 MB limit and actionable conversion guidance.
- **Measured ingestion quality.** A private offline evaluator tracks Hit Rate, Recall@K, Precision@K, MRR, and nDCG without adding a public query API.
- **Release evidence.** CI exercises Ubuntu, macOS, and Windows and checks the built CLI, circular dependencies, retrieval thresholds, package contents/size, and the 500 ms cold-start budget.

The GitHub `v1.2.0` release contains these changes. npm remains on the prior published version until `v1.2.0` is intentionally published there.

---

## Install

Published on npm as `@seifkhaled/auto-embed`. The CLI binary is `auto-embed`.

```bash
# One-off (no install):
npx @seifkhaled/auto-embed embed ./README.md --local

# Or install globally and use the short name:
npm i -g @seifkhaled/auto-embed
auto-embed embed ./README.md --local
```

## Quick start

```bash
# Zero-key prototype: fastembed + Chroma, no setup needed
npx @seifkhaled/auto-embed embed ./README.md --local

# Or: configure a real provider + DB once
npx @seifkhaled/auto-embed init
npx @seifkhaled/auto-embed embed ./docs/handbook.pdf
npx @seifkhaled/auto-embed embed "./docs/**/*.md" --collection handbook
npx @seifkhaled/auto-embed embed ./docs --collection handbook
```

The `init` flow asks you to pick an embedding provider, paste a key, pick a vector DB, and paste a connection. The config lives in `~/.auto-embed/config.json` with mode `0600` and is masked on display.

---

## Supported inputs and outputs

| Input file | Parser | Default splitter |
|---|---|---|
| `.md` / `.mdx` | `unified` + `remark` | header-aware (H1/H2/H3) |
| `.pdf` | `unpdf` | per-page + recursive within |
| `.html` / `.htm` | `cheerio` | strips nav/aside/footer/script |
| `.docx` | `mammoth` → markdown | header-aware |
| `.csv` | built-in | one chunk per row, header in meta |
| `.json` / `.jsonl` | built-in | one chunk per element / line |
| `.txt`, code (`.ts/.js/.py/.go/.rs/.java`) | built-in | recursive (language-tuned for code) |

| Embedding provider | Default model | Dim |
|---|---|---|
| OpenAI | `text-embedding-3-small` | 1536 |
| Google | `gemini-embedding-001` | 3072 |
| Voyage | `voyage-3` | 1024 |
| Cohere | `embed-english-v3.0` | 1024 |
| Local (fastembed) | `BAAI/bge-small-en-v1.5` | 384 |

| Vector DB | Connection |
|---|---|
| Chroma | local path (`./chroma`) or HTTP URL |
| pgvector | `DATABASE_URL` |
| Pinecone | `PINECONE_API_KEY` + index name |
| Qdrant | URL + optional API key |

See [`docs/providers/`](./docs/providers/) and [`docs/vector-dbs/`](./docs/vector-dbs/) for per-target setup notes.

---

## Common flags

| Flag | Default | Description |
|---|---|---|
| `--collection <name>` | derived from filename | Target collection / index / table. |
| `--provider <name>` | from config | `openai` · `google` · `voyage` · `cohere` · `local`. |
| `--model <id>` | provider default | Override embedding model. |
| `--db <name>` | from config | `pgvector` · `pinecone` · `qdrant` · `chroma`. |
| `--local` | off | Shortcut: `--provider local --db chroma` with auto-spawned local Chroma. |
| `--chunk-size <n>` | `800` (tokens) | Target chunk size. |
| `--overlap <n>` | `100` (tokens) | Token overlap between chunks. |
| `--splitter <type>` | from extension | `recursive` · `markdown` · `pdf` · `html` · `code` · `jsonl` · `csv`. |
| `--metadata <k=v,…>` | none | Static metadata stamped onto every chunk. |
| `--plan` | off | One LLM call to tune the plan (cheap; reuse via `--plan plan.json`). |
| `--plan <path>` | — | Reuse a saved plan; **skips the LLM call entirely**. |
| `--plan-only` | off | Write the plan and stop; no embedding. |
| `--out <path>` | mode-dependent | Output path for `--plan-only` (`plan.json`) or one combined `--show-chunks` report. |
| `--batch-size <n>` | provider default | Batch size for embedding API calls. |
| `--concurrency <n>` | `4` | Parallel embedding requests. |
| `--force` | off | Ignore the lockfile; re-embed and replace. |
| `--dry-run` | off | Print the plan + chunk table + USD cost estimate; embed nothing. |
| `--show-chunks` | off | Write every would-be chunk to a text file; embed nothing. |
| `--out-vectors <path>` | none | Also atomically write ordered vectors to one JSONL file for inspection. |
| `--verbose` | off | Debug logging. |

Run `auto-embed embed --help` for the complete list.

---

## Examples

```bash
# Smallest possible flow: embed the README locally
npx @seifkhaled/auto-embed embed ./README.md --local

# Real flow: PDFs into Pinecone
PINECONE_API_KEY=… npx @seifkhaled/auto-embed embed ./docs/handbook.pdf \
  --provider openai --db pinecone --collection handbook

# Preview a plan + cost without making API calls
npx @seifkhaled/auto-embed embed ./docs/handbook.pdf --dry-run

# Inspect the exact chunk text and metadata without embedding anything
npx @seifkhaled/auto-embed embed ./docs/handbook.pdf --show-chunks
npx @seifkhaled/auto-embed embed ./docs/one.md ./docs/two.md --show-chunks --out docs-chunks.txt

# Tune the plan with one LLM call, then run offline forever
ANTHROPIC_API_KEY=sk-ant-… npx @seifkhaled/auto-embed embed ./docs/handbook.pdf --plan --plan-only
npx @seifkhaled/auto-embed embed ./docs/handbook.pdf --plan plan.json --provider openai --db chroma

# Glob ingestion
npx @seifkhaled/auto-embed embed "./docs/**/*.md" --collection handbook --concurrency 8

# Recursive directory ingestion
npx @seifkhaled/auto-embed embed ./docs --collection handbook

# Keep an inspectable local copy of the vectors while upserting
npx @seifkhaled/auto-embed embed ./docs --local --out-vectors docs-vectors.jsonl

# CI: deterministic, non-interactive
DATABASE_URL=… npx @seifkhaled/auto-embed embed ./docs/handbook.md \
  --provider openai --db pgvector --collection handbook --yes
```

More patterns in [`examples/`](./examples/).

### Inspect chunks without embedding

Pass `--show-chunks` to stop after parsing and chunking. Without `--out`, each input writes a source-specific report named `<filename>-chunks.txt` in the current directory (for example, `handbook.pdf` writes `handbook-chunks.txt`). Pass `--out <path>` to combine multiple inputs into one report. This mode does not initialize an embedding provider, connect to a vector database, write a lockfile, or create any embeddings. Each entry contains the exact chunk text, its deterministic ID, token count, and metadata.

Use `--out <path>.txt` to choose a different output file. When `--out` is provided with multiple input files, their chunks are collected into that report.

### Input expansion and fallback

Input arguments may be explicit files, quoted glob patterns, or directories. Directories recurse through files; results are normalized, de-duplicated, and sorted so shell-expanded and CLI-expanded inputs behave consistently. Default recursive ignores cover `.git`, `node_modules`, `.auto-embed`, `dist`, and `chroma`, and symlinked directories are not traversed. Passing an explicit file bypasses those directory ignores.

If an input or quoted pattern matches nothing, the command exits as a user/config error and prints an actionable hint. Matching the same file through a directory, glob, and explicit argument still processes it only once.

Unknown extensions are inspected before parsing. Text-like content falls back to the recursive text parser with a warning. Binary content and malformed files with a supported extension fail with a parser error.

`--out-vectors <path>` writes one combined JSONL file in resolved input order. Each row contains source path, chunk identity and text, metadata, model, dimensions, and the vector. The file is written through a temporary path and atomically renamed after every input succeeds; it never contains API keys or stored configuration. Because vectors cannot be reconstructed from the lockfile, this explicit inspection mode embeds every chunk even when ingestion is otherwise up to date. If an export run fails, its temporary file is removed and the next export regenerates all vectors so the final JSONL is complete.

---

## Config & secrets

`~/.auto-embed/config.json` (file mode `0600`):

```json
{
  "defaults": { "provider": "openai", "db": "chroma" },
  "models":   { "openai": "text-embedding-3-small" },
  "apiKeys":  { "openai": "sk-…", "pinecone": "pcsk-…" },
  "dbs":      { "pgvector": { "url": "postgres://…" }, "chroma": { "url": "./chroma" } }
}
```

Environment variables **take precedence** over the file (recommended in CI):

- Embedding providers: `OPENAI_API_KEY` · `GOOGLE_API_KEY` · `VOYAGE_API_KEY` · `COHERE_API_KEY`
- Vector DBs: `DATABASE_URL` · `PINECONE_API_KEY` · `QDRANT_URL` · `QDRANT_API_KEY` · `CHROMA_URL`
- Selection: `AUTO_EMBED_PROVIDER` · `AUTO_EMBED_DB` · `AUTO_EMBED_MODEL`
- Optional LLM planner: `ANTHROPIC_API_KEY` (alternative: `OPENAI_API_KEY` or `GOOGLE_API_KEY`), `AUTO_EMBED_PLAN_PROVIDER`

Useful one-liners:

```bash
auto-embed providers                              # who's configured, who's missing keys
auto-embed config list                            # all stored values, API keys masked
auto-embed config get defaults.provider
auto-embed config set defaults.db pinecone
auto-embed config path                            # absolute path to the config file
```

`auto-embed` never logs a full API key and never writes a key into a generated file or lockfile.

---

## How it works

```
┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────┐
│ 1. PARSE │   │ 2. CHUNK │   │ 3. LOCKFILE  │   │ 4. EMBED │   │ 5. UPSERT│
│ file →   │──▶│ token-   │──▶│ diff vs.     │──▶│ provider │──▶│ vector DB│
│ sections │   │ aware    │   │ prior chunks │   │ batches  │   │ adapter  │
└──────────┘   └──────────┘   └──────┬───────┘   └──────────┘   └──────────┘
                                     │
                                fast-path:
                              "up to date" if
                             nothing changed,
                              0 API calls.
```

The chunker uses `js-tiktoken` for token counts and a port of LangChain's recursive splitter (no LangChain dependency). Each chunk gets a deterministic ID derived from `sha256(sourcePath + index + chunkerVersion + text)` — same input file + same plan + same model → byte-identical chunk IDs across machines.

A per-file lockfile lives at `./.auto-embed/<hash>.lock.json`. The directory is ignored by default because it also contains temporary job/evaluation state. Teams that deliberately share idempotency state with CI can force-add only the stable `*.lock.json` files; do not commit incomplete job manifests or local evaluation output.

### The `EmbedPlan`

The plan is a small JSON document describing how to chunk one file: splitter type, chunk size, overlap, target collection, embedding model. By default it's derived heuristically from the file extension. `--plan` opts into a single LLM call that inspects the first ~4KB of the file and tunes the plan. `--plan <file>` reuses a saved plan and **never calls the LLM** — free, offline, reproducible.

### Re-run semantics

- File hash unchanged, plan unchanged, model unchanged → skip, `up to date`, **zero API calls**.
- File content changed → diff chunk IDs; embed only the new ones; delete the removed ones.
- Embedding model or dimensions changed → refuse to write (would corrupt the collection with mixed-dim vectors). Use `--force` or pick a fresh `--collection`.

### Crash recovery

In-progress work is recorded atomically under `.auto-embed/jobs/`. Each embedding batch is checkpointed only after its vectors are successfully upserted. If the provider, vector database, process, or final lockfile write fails, run the same command again: already committed chunk IDs are skipped, incomplete batches continue, and old chunk IDs are not deleted until every replacement is safe. The final lockfile is written only after upserts and deletions complete, then the temporary job manifest is removed.

`--force` discards matching checkpoint progress and starts that ingestion again. `SIGINT` and `SIGTERM` stop new provider work, allow active calls to finish, close the vector database, and leave the job manifest ready for a later resume.

### Large-file behavior

File hashing always uses a stream. Real ingestion of TXT, logs, supported code, CSV, and JSONL uses reusable async parser/chunker passes; normal embedding batches are upserted and released instead of retaining every vector. CSV is record-aware, including quoted newlines, and JSONL retains physical line metadata.

Markdown/MDX, PDF, HTML, DOCX, JSON, and content-sniffed formats currently depend on whole-document parser libraries. The CLI rejects those inputs above 100 MB before reading them and suggests splitting or converting to TXT, CSV, or JSONL. Preview/report modes may intentionally retain chunk text to print or export it; the bounded-memory guarantee applies to real ingestion.

The opt-in `bun run perf:large` gate generates 128 MB TXT and JSONL fixtures, streams each hash and chunks each twice, and verifies byte hash plus chunk-ID determinism. The ratified ceiling is 384 MB peak RSS; the 2026-07-31 baseline produced 6,039 TXT chunks and 7,690 JSONL chunks at 326.9 MB peak RSS in 217.34 seconds on the development machine.

### Private retrieval-quality evaluation

`bun run eval` is an engineering gate, not a public query feature. It chunks the versioned corpus under `test/fixtures/eval/` with each manifest strategy, ranks chunks through a deterministic offline TF-IDF/cosine backend, and reports Hit Rate, Recall@K, Precision@K, MRR, and nDCG. Golden labels identify an expected source plus exact supporting phrase; hard negatives intentionally reuse terms such as “rotation.”

The command atomically writes `.auto-embed/eval/evaluation.json` and a self-contained `.auto-embed/eval/evaluation.html`. Repeated runs with the same manifest are byte-identical. Regression thresholds apply to the structural `markdown-800-100` baseline. No evaluator code is included in the published package, and no `query` command or retrieval library API is exposed.

### Release assurance

`bun run quality` runs strict typechecking, the complete test suite, the production build, a circular-dependency scan, built-CLI smoke tests, the offline retrieval gate, and npm archive/cold-start validation. The opt-in `bun run perf:large` adds the generated 128 MB TXT/JSONL memory and determinism gate.

The GitHub Actions matrix covers Node 20 and 22 on Ubuntu plus Node 22 on macOS and Windows. The current v1.2 baseline is 201 passing assertions, no circular dependencies, a 108.2 KB npm archive (460.8 KB unpacked), and a measured maximum cold start of 162.9 ms against a 500 ms budget.

### Product boundary

`auto-embed` ends after vectors are safely written. It does not ship query embedding, top-k retrieval, hybrid fusion, MMR, reranking, HyDE, prompt composition, answer generation, citations, agents, hosted synchronization, web crawling, database-row ingestion, multimodal indexing, or query-time authorization. Use the selected vector database SDK and the serving application for those concerns. The private evaluator performs retrieval only as an engineering measurement and is not included in the npm package.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User / config error (missing key, invalid flag, missing file) |
| `2` | Parser error (broken PDF, malformed JSON, etc.) |
| `3` | Provider API error (auth, rate limit, LLM JSON failure after retry) |
| `4` | Vector DB error (connection failure, schema error) |
| `5` | Integrity error (dimension mismatch, plan-hash mismatch, etc.) |

Errors print a single human-readable line plus an actionable `hint:`. Use `--verbose` for stack traces.

---

## `--local` notes

`--local` spawns a Chroma server in the background (`node_modules/.bin/chroma run --path ./chroma`) the first time it's needed and leaves it running so subsequent CLI invocations reuse it. Stop it with:

```bash
pkill -f "chroma run"
```

The fastembed model (`BAAI/bge-small-en-v1.5`, ~30 MB) is downloaded once to a local cache on first use.

---

## License

MIT.
