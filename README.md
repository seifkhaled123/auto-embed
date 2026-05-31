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
| `--out <path>` | `plan.json` | Where to write the plan when `--plan-only` is set. |
| `--batch-size <n>` | provider default | Batch size for embedding API calls. |
| `--concurrency <n>` | `4` | Parallel embedding requests. |
| `--force` | off | Ignore the lockfile; re-embed and replace. |
| `--dry-run` | off | Print the plan + chunk table + USD cost estimate; embed nothing. |
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

# Tune the plan with one LLM call, then run offline forever
ANTHROPIC_API_KEY=sk-ant-… npx @seifkhaled/auto-embed embed ./docs/handbook.pdf --plan --plan-only
npx @seifkhaled/auto-embed embed ./docs/handbook.pdf --plan plan.json --provider openai --db chroma

# Glob ingestion
npx @seifkhaled/auto-embed embed "./docs/**/*.md" --collection handbook --concurrency 8

# CI: deterministic, non-interactive
DATABASE_URL=… npx @seifkhaled/auto-embed embed ./docs/handbook.md \
  --provider openai --db pgvector --collection handbook --yes
```

More patterns in [`examples/`](./examples/).

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

A per-file lockfile lives at `./.auto-embed/<hash>.lock.json`. **Commit `.auto-embed/`** to share idempotency state with CI.

### The `EmbedPlan`

The plan is a small JSON document describing how to chunk one file: splitter type, chunk size, overlap, target collection, embedding model. By default it's derived heuristically from the file extension. `--plan` opts into a single LLM call that inspects the first ~4KB of the file and tunes the plan. `--plan <file>` reuses a saved plan and **never calls the LLM** — free, offline, reproducible.

### Re-run semantics

- File hash unchanged, plan unchanged, model unchanged → skip, `up to date`, **zero API calls**.
- File content changed → diff chunk IDs; embed only the new ones; delete the removed ones.
- Embedding model or dimensions changed → refuse to write (would corrupt the collection with mixed-dim vectors). Use `--force` or pick a fresh `--collection`.

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
