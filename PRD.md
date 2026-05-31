# auto-embed — Product Requirements Document

**Status:** Draft v0.1
**Owner:** Seif Khaled
**Last updated:** 2026-05-30

---

## 1. Summary

`auto-embed` is a zero-config CLI that ingests source files into a vector database for use in RAG (retrieval-augmented generation) systems. It parses a file, chunks it intelligently, generates embeddings, and writes the vectors plus metadata to the user's vector store of choice — all in one command.

It is the sibling of [`auto-seed`](https://www.npmjs.com/package/auto-seed): same opinionated, one-command philosophy, same config model, same target audience (application developers who want to skip 80% of the RAG-ingest plumbing).

```bash
npx auto-embed init                              # one-time: pick embedding provider + vector DB
npx auto-embed embed ./docs/handbook.pdf         # parse → chunk → embed → upsert
npx auto-embed embed ./docs/**/*.md --collection handbook
```

---

## 2. Problem

Every RAG project starts the same way: write 200–500 lines of glue code to parse PDFs/Markdown/HTML, pick a chunking strategy, hand-roll a tokenizer-aware splitter, call an embedding API, batch and rate-limit the calls, then upsert to whichever vector DB the project chose this week. The code is tedious, boilerplate-heavy, easy to get wrong, and almost identical across projects.

Existing tools force a tradeoff:

- **LangChain / LlamaIndex** — comprehensive but heavyweight; a 50 MB dependency tree for a job that should be one CLI call.
- **Vector-DB-vendor SDKs** (Pinecone, Weaviate, Chroma) — only handle the last step.
- **Custom scripts** — what every dev ends up writing, badly, every time.

There is no `npx`-able tool that does the whole pipeline correctly, idempotently, across the common file types and vector stores.

## 3. Target user

A developer building a RAG-powered feature — chatbot, semantic search, code-aware assistant, internal-docs Q&A — who:

- Already knows which vector DB they want to use.
- Already has (or wants) an embedding provider account, or wants a local-only option for prototypes.
- Does **not** want to write a chunking pipeline from scratch.
- Wants ingestion to be reproducible, idempotent, and CI-friendly.

Secondary user: someone evaluating RAG for the first time and wanting a zero-friction "see it work" path with no API keys (`--local`).

## 4. Goals

- **One command, full pipeline.** Parse → chunk → embed → upsert in a single invocation.
- **Sensible defaults, deep overrides.** Works on day one with no flags; every decision is overridable.
- **Idempotent re-runs.** Re-embedding the same file is safe and cheap. Changed files do incremental upserts.
- **Reproducible.** The same input file + same plan + same model produces byte-identical vectors and chunk IDs.
- **Provider-agnostic.** 5 embedding providers, 4 vector DBs in v1, all with the same UX.
- **Zero-key prototype path.** `--local` runs end-to-end with no API keys (fastembed + Chroma local).
- **CI-friendly.** Non-interactive flag set, deterministic output, exit codes that mean things.

## 5. Non-goals (v1)

- **Database-to-RAG ingestion.** Walking SQL tables and embedding row contents is a future "auto-embed db" subcommand; v1 is file-only.
- **Retrieval / query side.** This tool ingests. It does not query. Users use their vector DB's native SDK to retrieve.
- **Hosted UI or dashboard.** CLI only.
- **Custom model training or fine-tuning.** Embeddings are called from existing providers; we don't train.
- **Multi-modal embeddings (images, audio).** Text only in v1.
- **Reranking, hybrid search, BM25.** Out of scope; users layer this in their query path.
- **OCR for scanned PDFs.** Text-extractable PDFs only in v1.

## 6. Scope

### 6.1 Supported input file types (v1)

| Type | Parser | Splitter strategy |
|---|---|---|
| `.md` / `.mdx` | `unified` + `remark` | Header-aware (split on H1/H2/H3 boundaries, then recursive within each section) |
| `.pdf` | `unpdf` | Page boundaries + recursive char splitter; preserves page-number metadata |
| `.txt` | built-in | Recursive char splitter |
| `.html` / `.htm` | `cheerio` | Strip nav/footer, extract semantic blocks, recursive within |
| `.docx` | `mammoth` | Convert to MD, then header-aware |
| `.json` / `.jsonl` | built-in | One chunk per top-level object/line, with key-path metadata |
| `.csv` | built-in | One chunk per row, header-aware, configurable text column(s) |
| Code (`.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`) | built-in | Recursive splitter tuned to language separators (functions, classes) |

Unsupported file types degrade to recursive text splitter with a warning rather than failing.

### 6.2 Supported vector databases (v1)

| DB | Mode | Connection |
|---|---|---|
| **pgvector** | self-host / hosted Postgres | `DATABASE_URL` |
| **Pinecone** | hosted | `PINECONE_API_KEY` + index name |
| **Qdrant** | self-host / cloud | URL + optional API key |
| **Chroma** | local / hosted | URL or path |

Adding more (Weaviate, Supabase, Mongo Atlas Vector, Redis) is a v2 plugin shape.

### 6.3 Supported embedding providers (v1)

| Provider | Default model | Dimensions |
|---|---|---|
| **OpenAI** | `text-embedding-3-small` | 1536 |
| **Google** | `gemini-embedding-001` | 3072 |
| **Voyage** | `voyage-3` | 1024 |
| **Cohere** | `embed-english-v3.0` | 1024 |
| **Local (fastembed)** | `BAAI/bge-small-en-v1.5` | 384 |

All overridable via `--model`. No Anthropic — they do not ship embeddings (they recommend Voyage).

### 6.4 The Embed Plan (hybrid model)

By **default**, chunking is fully heuristic — driven by file extension. No LLM call required for ingestion. The user only needs an embedding-provider key (or `--local`).

`--plan` opts into a single LLM call that inspects the first ~4KB of the file and returns a tuned `EmbedPlan` JSON: splitter type, chunk size, overlap, metadata fields to extract, collection name suggestion. The local pipeline then executes the plan deterministically.

`--plan-only` writes the plan and stops. `--plan <file>` reuses a saved plan (skips the LLM call entirely — free, offline, reproducible). Same pattern as auto-seed.

When `--plan` is **not** passed, no LLM provider is required to be configured.

### 6.5 Idempotency model

- Each chunk gets a deterministic ID: `sha256(file_path + chunk_index + chunker_version + chunk_text)[:16]`.
- A sidecar lockfile `.auto-embed.lock.json` is written next to the ingested file (or in `./.auto-embed/`), recording `{file_hash, chunk_count, chunk_ids[], embedding_model, embedding_dimensions, chunker_version, plan_hash, timestamp}`.
- Re-run behavior:
  - **File hash unchanged, model unchanged, chunker version unchanged** → skip, exit 0, print "up to date".
  - **File hash changed** → diff chunk IDs, delete removed chunks, upsert new/changed.
  - **Embedding model or dimensions changed** → refuse to write (would corrupt the collection with mixed-dim vectors); require `--force` or `--collection <new-name>`.
- `--force` ignores the lockfile and replaces all chunks for the file.

### 6.6 CLI surface (v1)

```
auto-embed init                          # interactive setup
auto-embed embed <files...> [flags]      # the main command
auto-embed plan <file>                   # alias for: embed <file> --plan-only
auto-embed config <get|set|list|path>    # manage stored config
auto-embed providers                     # list available providers + status of configured keys
auto-embed --version
```

#### `embed` flags

| Flag | Default | Description |
|---|---|---|
| `--collection <name>` | derived from filename | Vector-DB collection / index / table name |
| `--provider <name>` | from config | `openai`, `google`, `voyage`, `cohere`, `local` |
| `--model <id>` | provider default | Embedding model override |
| `--db <name>` | from config | `pgvector`, `pinecone`, `qdrant`, `chroma` |
| `--local` | off | Shortcut: provider=local + db=chroma at `./chroma` |
| `--chunk-size <n>` | 800 (tokens) | Target chunk size |
| `--overlap <n>` | 100 (tokens) | Token overlap between chunks |
| `--splitter <type>` | auto from extension | `recursive`, `markdown`, `pdf`, `html`, `code`, `jsonl`, `csv` |
| `--metadata <k=v,...>` | none | Static metadata attached to every chunk |
| `--plan` | off | Make one LLM call to tune the plan |
| `--plan-only` | off | Write the plan and stop; no embedding |
| `--plan <path>` | — | Reuse a saved plan (skips LLM) |
| `--batch-size <n>` | provider default | Batch size for embedding API calls |
| `--concurrency <n>` | 4 | Parallel embedding requests |
| `--force` | off | Ignore lockfile; re-embed and replace |
| `--dry-run` | off | Show what would happen; embed nothing |
| `--out-vectors <path>` | none | Also write vectors to a local `.jsonl` for inspection |
| `--yes` / `-y` | off | Non-interactive mode |
| `--verbose` | off | Debug logging |

## 7. Functional requirements

### 7.1 Must

- Parse every file type in 6.1 without external system dependencies (no system pdftotext, no system pandoc).
- Token-aware chunking using `js-tiktoken` (works offline, no API).
- Batch embedding requests to respect each provider's rate and batch limits.
- Retry with exponential backoff on transient errors (HTTP 429, 5xx, network).
- Stream-friendly: handle files > 100 MB without loading the whole thing in memory where the parser allows.
- Glob support: `auto-embed embed "./docs/**/*.md"`.
- Pretty progress UI (`@clack/prompts` + `ora`) matching auto-seed's look.
- Non-interactive mode triggered by `--yes` or by detecting non-TTY stdin.
- Mask API keys in all logs and error output.
- `~/.auto-embed/config.json` with `0600` permissions.
- Env vars override config: `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `VOYAGE_API_KEY`, `COHERE_API_KEY`, `PINECONE_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`, `DATABASE_URL`, `CHROMA_URL`, `AUTO_EMBED_PROVIDER`, `AUTO_EMBED_DB`, `AUTO_EMBED_MODEL`.

### 7.2 Should

- Auto-detect file type by extension first, then by content sniffing as a fallback.
- Print a one-line ingestion summary (`Embedded 142 chunks from handbook.pdf into pinecone://my-index/handbook in 4.2s, cost ~$0.0023`).
- Cost estimator: dry-run reports approximate USD cost based on token count and provider pricing.
- Warn loudly on collection/model dimension mismatch before making any API call.
- Resume on partial failure: if 80/100 batches succeeded, re-run picks up at batch 81.

### 7.3 Nice to have (post v1)

- `auto-embed query "..."` for quick retrieval testing against an ingested collection.
- Watch mode: `auto-embed embed ./docs --watch` re-embeds on file change.
- Plugin API for new vector DBs and parsers.
- `auto-embed db` subcommand (the database-row-ingest sibling).
- OCR fallback for scanned PDFs (via `tesseract.js`).
- Reranker integration (Cohere Rerank, Voyage Rerank) on the query side.

## 8. Non-functional requirements

- **Install size:** under 30 MB unpacked (excluding fastembed model, which is lazy-downloaded on first `--local` use).
- **Cold start:** under 500 ms for `--help` / `--version`.
- **Node compatibility:** Node ≥ 20. (Node 18 was originally targeted but dropped post-v1.0.0 — `cheerio` requires the `File` global which only exists from Node 20.)
- **Cross-platform:** Linux, macOS, Windows.
- **Test coverage:** core parsers, chunker, lockfile logic, and provider adapters mocked. Aim for ≥ 80% line coverage on `src/core/**`.
- **Security:** no API key ever written to a generated file or logged in full; lockfile contains no secrets.

## 9. Success metrics

- **TTHW (Time To Hello World):** from `npm i -g` to first successful ingestion under 60 seconds on a fresh machine with no prior setup (using `--local`).
- **Re-run cost:** re-embedding an unchanged file costs 0 API calls and exits in under 1 second.
- **Adoption proxy:** weekly npm downloads, GitHub stars, issue volume on parser-specific bugs (signals real-world file diversity).
- **Bug-free retrieval:** zero reports of silent vector corruption (mixed-dimension vectors in one collection) — guarded by the model-mismatch check.

## 10. Risks & open questions

| Risk | Mitigation |
|---|---|
| `unpdf` fails on weird PDFs (scanned, encrypted, malformed) | Detect → clear error message → suggest OCR (post-v1) or manual extraction |
| Embedding-provider rate limits hit on large ingests | Batching + concurrency + retry/backoff; document recommended `--concurrency` per provider |
| Lockfile drift between machines (CI vs laptop) | Lockfile is per-file and content-keyed; safe to commit or `.gitignore` — README recommends committing |
| Vector-DB schema drift (e.g. user changes index dimension externally) | Pre-flight check: query the collection's existing dimension before writing |
| `fastembed` model download (~30 MB) on first `--local` run feels slow | Print a clear "downloading model (one-time)…" with progress bar |
| npm name `auto-embed` may be taken | Verify before publish; fallback `@<scope>/auto-embed` with `bin: auto-embed` preserved |

### Open questions to resolve before build

1. Lockfile location default: next to the file, or always in `./.auto-embed/`? Leaning toward `./.auto-embed/<file-hash>.lock.json` for cleanliness.
2. Should `--collection` be required, or always derivable from filename? Leaning toward derivable (filename → kebab-case) with override.
3. Pricing data for cost estimator: hardcode (goes stale) or fetch (network dependency)? Leaning toward hardcoded with a `last-verified` date in the source.
4. Should `init` auto-detect existing env vars and offer to use them, instead of prompting for keys? Leaning yes — better UX.

## 11. Out of scope explicitly

- Anthropic embeddings (do not exist).
- OpenAI Assistants API / vector stores (different product).
- Building or hosting a vector DB ourselves.
- Multi-tenant or auth-scoped ingestion (single-user CLI).
- Web crawling / URL ingestion (use `curl > file.html` and feed the file).

## 12. Glossary

- **Chunk** — a sub-section of a file, sized to fit comfortably within the embedding model's context.
- **Embedding** — the dense vector produced by an embedding model for a chunk.
- **Collection** — generic term for the destination container in a vector DB (table in pgvector, index in Pinecone, collection in Qdrant/Chroma).
- **EmbedPlan** — the JSON document describing how to chunk and embed one file (default = heuristic; `--plan` = LLM-tuned).
- **Lockfile** — `.auto-embed.lock.json` recording what was last ingested for idempotent re-runs.
