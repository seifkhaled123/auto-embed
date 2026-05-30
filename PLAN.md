# auto-embed — Implementation Plan

**Target:** v1.0.0 on npm
**Estimated total build time:** ~3 weeks (1 dev, focused)
**Companion to:** [PRD.md](./PRD.md)

This plan is sequenced so each milestone produces a working, demoable slice. You can ship to npm at any milestone from M4 onward and the tool still works end-to-end — every later milestone widens coverage rather than gating usability.

---

## Directory layout

```
auto-embed/
├── src/
│   ├── index.ts                    # CLI entry, commander setup, dispatch
│   ├── commands/
│   │   ├── init.ts                 # interactive setup
│   │   ├── embed.ts                # main pipeline command
│   │   ├── plan.ts                 # alias for `embed --plan-only`
│   │   ├── config.ts               # get|set|list|path
│   │   └── providers.ts            # list provider + key status
│   ├── config/
│   │   ├── index.ts                # load/save, env-var override
│   │   ├── schema.ts               # zod config schema
│   │   └── mask.ts                 # API key masking helpers
│   ├── log.ts                      # single logger module — all output goes here
│   ├── errors.ts                   # AutoEmbedError + ExitCode enum
│   ├── parsers/
│   │   ├── index.ts                # dispatch by extension + content sniff
│   │   ├── text.ts                 # .txt
│   │   ├── markdown.ts             # .md, .mdx (unified + remark)
│   │   ├── pdf.ts                  # .pdf (unpdf)
│   │   ├── html.ts                 # .html, .htm (cheerio)
│   │   ├── docx.ts                 # .docx (mammoth → markdown)
│   │   ├── csv.ts                  # .csv
│   │   ├── json.ts                 # .json, .jsonl
│   │   └── code.ts                 # .ts, .js, .py, .go, .rs, .java
│   ├── chunker/
│   │   ├── index.ts                # dispatch by EmbedPlan.splitter
│   │   ├── recursive.ts            # token-aware recursive char splitter
│   │   ├── markdown.ts             # header-aware splitter
│   │   ├── code.ts                 # language-tuned separators
│   │   └── tokens.ts               # js-tiktoken wrapper
│   ├── plan/
│   │   ├── schema.ts               # zod EmbedPlan schema
│   │   ├── heuristic.ts            # extension → plan (no LLM)
│   │   └── llm.ts                  # optional --plan (one LLM call)
│   ├── providers/                  # embedding providers
│   │   ├── index.ts                # registry, dispatch
│   │   ├── types.ts                # EmbeddingProvider interface
│   │   ├── openai.ts
│   │   ├── google.ts
│   │   ├── voyage.ts
│   │   ├── cohere.ts
│   │   └── fastembed.ts            # local, no API key
│   ├── vector-dbs/
│   │   ├── index.ts                # registry, dispatch
│   │   ├── types.ts                # VectorDB interface
│   │   ├── chroma.ts
│   │   ├── pgvector.ts
│   │   ├── pinecone.ts
│   │   └── qdrant.ts
│   ├── embed/
│   │   ├── engine.ts               # batching, concurrency, retry
│   │   └── pipeline.ts             # parse → chunk → embed → upsert orchestration
│   └── lockfile.ts                 # .auto-embed.lock.json read/write/diff
├── test/
│   ├── fixtures/
│   │   ├── parsers/                # one tiny sample per file type (see below)
│   │   ├── plans/                  # golden EmbedPlan JSONs
│   │   └── lockfiles/              # golden lockfile JSONs for diff tests
│   ├── parsers.test.ts
│   ├── chunker.test.ts
│   ├── lockfile.test.ts
│   ├── plan.test.ts
│   ├── providers.test.ts           # HTTP-mocked
│   └── cli.test.ts                 # spawns dist/index.js
├── dist/                           # tsup output, gitignored
├── PRD.md
├── PLAN.md
├── CLAUDE.md
├── README.md
├── package.json
├── tsup.config.ts
├── tsconfig.json
└── vitest.config.ts
```

## Dependencies

Pinned to the major versions verified at design time. When installing, use these majors; do not jump to a newer major without retesting.

### Runtime (always loaded)

```
commander          ^14
@clack/prompts     ^1
ora                ^9
picocolors         ^1
zod                ^3.25     # NOT v4 — stay aligned with auto-seed
js-tiktoken        ^1
p-limit            ^6
p-retry            ^7
```

### Parsers (lazy-imported inside each parser module)

```
unified            ^11
remark-parse       ^11
mdast-util-to-string ^4
unpdf              ^1        # NOT pdf-parse
cheerio            ^1
mammoth            ^1
```

### Embedding providers (lazy-imported per provider)

```
openai             ^6
@google/genai      ^2
cohere-ai          ^7
voyageai           latest    # verify at install time
fastembed          ^1
```

### Vector DBs (lazy-imported per adapter)

```
chromadb                      ^1
pg                            ^8
@pinecone-database/pinecone   ^6
@qdrant/js-client-rest        ^1
```

### Optional `--plan` LLM clients (only loaded when `--plan` is passed)

```
@anthropic-ai/sdk  ^0.98     # already proven in auto-seed
```
OpenAI and Google clients are reused from the embedding providers list.

### Dev

```
tsup               ^8
tsx                ^4
typescript         ^5.9
vitest             ^4
@types/node        ^25
@types/pg          ^8
madge              ^8         # circular-dep check in CI
```

**Lazy-import discipline:** parser, provider, and DB modules must `await import('…')` at use time, not at top-level. This keeps cold-start time under the 500 ms budget and prevents `--help` from loading `mammoth`.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│                            CLI (commander)                          │
│  init │ embed │ plan │ config │ providers                           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │       Pipeline Orchestrator │
                │  resolves: plan → execute   │
                └──┬────────┬────────┬────────┘
                   │        │        │
        ┌──────────▼──┐ ┌───▼────┐ ┌─▼──────────┐
        │   Parsers   │ │Chunker │ │  Lockfile  │
        │ md/pdf/html │ │ token- │ │  manager   │
        │ docx/csv/.. │ │ aware  │ │ (idempot.) │
        └──────┬──────┘ └───┬────┘ └────────────┘
               │            │
               └─────┬──────┘
                     │ Document[]
                ┌────▼────────────┐
                │  Embed Engine   │
                │ batch · retry · │
                │ rate-limit      │
                └────┬────────────┘
                     │ (id, vector, metadata)[]
                ┌────▼────────────┐
                │  VectorDB       │
                │  Adapter        │
                │ (pgvector,      │
                │  pinecone,      │
                │  qdrant,        │
                │  chroma)        │
                └─────────────────┘
```

### Internal type contracts (sketch)

```ts
type ParsedDocument = {
  sourcePath: string;
  contentType: 'markdown' | 'pdf' | 'html' | 'docx' | 'text' | 'json' | 'csv' | 'code';
  sections: Array<{ text: string; meta: Record<string, unknown> }>;
};

type Chunk = {
  id: string;              // sha256(sourcePath + index + chunkerVersion + text)[:16]
  text: string;
  meta: Record<string, unknown>;
};

type Embedded = Chunk & { vector: number[]; model: string; dim: number };

interface EmbeddingProvider {
  name: string;
  defaultModel: string;
  embed(texts: string[], opts?: { model?: string }): Promise<{ vectors: number[][]; usage: TokenUsage }>;
  dimensions(model: string): number;
}

interface VectorDB {
  name: string;
  ensureCollection(name: string, dim: number): Promise<void>;
  describeCollection(name: string): Promise<{ dim: number } | null>;
  upsert(collection: string, rows: Embedded[]): Promise<void>;
  deleteByIds(collection: string, ids: string[]): Promise<void>;
}

type EmbedPlan = {
  version: 1;
  splitter: 'recursive' | 'markdown' | 'pdf' | 'html' | 'code' | 'jsonl' | 'csv';
  chunkSize: number;
  overlap: number;
  metadata: Record<string, string>;
  collection: string;
  embeddingModel: string;
};
```

### Concrete zod schemas

`src/plan/schema.ts`:
```ts
export const EmbedPlanSchema = z.object({
  version: z.literal(1),
  splitter: z.enum(['recursive','markdown','pdf','html','code','jsonl','csv']),
  chunkSize: z.number().int().positive(),
  overlap: z.number().int().nonnegative(),
  metadata: z.record(z.string()),
  collection: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/),
  embeddingModel: z.string().min(1),
});
export type EmbedPlan = z.infer<typeof EmbedPlanSchema>;
```

`src/lockfile.ts`:
```ts
export const LockfileSchema = z.object({
  version: z.literal(1),
  sourcePath: z.string(),
  sourceHash: z.string().length(64),       // sha256 hex
  chunkerVersion: z.string(),              // bump on any chunker algo change
  embeddingProvider: z.string(),
  embeddingModel: z.string(),
  dimensions: z.number().int().positive(),
  collection: z.string(),
  vectorDb: z.string(),
  planHash: z.string().length(64),         // sha256 of canonical-JSON EmbedPlan
  chunks: z.array(z.object({
    id: z.string().length(16),             // sha256(...)[:16]
    meta: z.record(z.unknown()),
  })),
  timestamp: z.string().datetime(),
});
export type Lockfile = z.infer<typeof LockfileSchema>;
```

Lockfile location: `./.auto-embed/<sha256(absolutePath)[:16]>.lock.json`. Directory is created on first write. Recommend in README that users **commit** `.auto-embed/` to share idempotency state with CI.

### Recursive chunker algorithm

Port of LangChain's `RecursiveCharacterTextSplitter`, no dep. Pseudocode:

```
recursiveSplit(text, separators, chunkSize, overlap):
  # separators tried in order; first one present in text is used
  for i, sep in enumerate(separators):
    if sep == '' or sep in text:
      parts = text.split(sep) if sep else list(text)
      out, buf, bufTok = [], [], 0
      for p in parts:
        pTok = tokenCount(p)
        if pTok > chunkSize:
          if buf: out.push(joinAndOverlap(buf, sep))
          buf, bufTok = [], 0
          out.push(...recursiveSplit(p, separators[i+1:], chunkSize, overlap))
        elif bufTok + pTok + tokenCount(sep) > chunkSize:
          out.push(joinAndOverlap(buf, sep))
          buf, bufTok = [p], pTok
        else:
          buf.push(p); bufTok += pTok + tokenCount(sep)
      if buf: out.push(buf.join(sep))
      return mergeShortNeighbors(out, chunkSize)
  return [text]

joinAndOverlap(buf, sep):
  # carry last `overlap` tokens of the joined buf as a prefix on the next chunk
  # (the carry is applied by the caller in the next iteration)
```

Default separators by `splitter`:

| Splitter | Separators (in order) |
|---|---|
| `recursive` | `['\n\n', '\n', '. ', ' ', '']` |
| `markdown` | (header-aware pre-split by H1/H2/H3, then recursive within each section) |
| `code` | `['\nclass ', '\nfunction ', '\ndef ', '\n\n', '\n', ' ', '']` |
| `csv` | row-based, one chunk per row, header prepended to each |
| `jsonl` | line-based, one chunk per line |

**Chunker version constant:** `export const CHUNKER_VERSION = '1';` in `src/chunker/index.ts`. Bump to `'2'` on **any** algorithm change. The lockfile-mismatch check uses this string equality.

### Error format

`src/errors.ts`:
```ts
export enum ExitCode {
  Success = 0,
  UserConfig = 1,
  Parser = 2,
  ProviderApi = 3,
  VectorDb = 4,
  Integrity = 5,
}
export class AutoEmbedError extends Error {
  constructor(message: string, public exitCode: ExitCode, public hint?: string) {
    super(message);
  }
}
```

Top-level catch in `src/index.ts`:
- print `pc.red('✖')` + message on stderr
- if `hint`: print `pc.dim('  hint: ' + hint)` on stderr
- if `--verbose`: print stack trace
- `process.exit(err.exitCode)`

All thrown errors at the boundary must be `AutoEmbedError`. Wrap unexpected errors in `new AutoEmbedError(String(err), ExitCode.UserConfig, 'unexpected error; re-run with --verbose')`.

### Test fixtures to create (M2/M3)

Tiny, hand-authored files committed to the repo:

| Fixture | Notes |
|---|---|
| `test/fixtures/parsers/sample.md` | H1, H2, H3, code block, bulleted list, ~400 words |
| `test/fixtures/parsers/sample.pdf` | 3 pages, ASCII text only, no images/encryption |
| `test/fixtures/parsers/sample.html` | `<nav>`, `<main>`, `<aside>`, `<footer>` — only `<main>` should survive |
| `test/fixtures/parsers/sample.docx` | 2 headings, 3 paragraphs |
| `test/fixtures/parsers/sample.csv` | 10 rows, header row, mixed-type columns |
| `test/fixtures/parsers/sample.json` | array of 5 objects with nested fields |
| `test/fixtures/parsers/sample.jsonl` | 5 lines, one JSON object each |
| `test/fixtures/parsers/sample.txt` | ~500 words of plain prose, no structure |
| `test/fixtures/parsers/sample.ts` | small TS file with one class and two functions |
| `test/fixtures/plans/markdown.golden.json` | expected heuristic plan for `sample.md` |
| `test/fixtures/lockfiles/initial.json` | known-good lockfile shape for diff tests |

---

## Milestones

### M0 — Repo scaffold (½ day)

**Goal:** working `npx`-able skeleton that prints `--help`.

- Copy `package.json` / `tsup.config.ts` / `tsconfig.json` / `vitest.config.ts` from `auto-seed`.
- Update `name`, `bin`, `keywords`, `description`.
- `src/index.ts` with `commander` + stub subcommands.
- CI: GitHub Actions running `typecheck` + `test` + `build` on Node 18 / 20 / 22.
- License, README stub, AGENTS.md, CODE_OF_CONDUCT.md, SECURITY.md, CONTRIBUTING.md (copy from auto-seed, adjust).

**Acceptance:**
```bash
bun run typecheck
bun run build
node dist/index.js --help | grep -q "Commands:"
node dist/index.js --version
```
All four must succeed with exit 0.

---

### M1 — Config + `init` + `providers` (1 day)

**Goal:** users can configure providers and DBs interactively.

- `src/config/` — read/write `~/.auto-embed/config.json` (0600), schema in zod, env-var override.
- Reuse auto-seed's masking helpers (paste-by-reference, don't duplicate).
- `auto-embed init`: clack-prompt flow → pick embedding provider → paste key → pick vector DB → paste connection → save.
- `auto-embed config get|set|list|path` (mirror auto-seed).
- `auto-embed providers`: list all providers, show `OK`/`missing key` per row.

**Acceptance:**
```bash
OPENAI_API_KEY=sk-test node dist/index.js providers   # shows openai: OK
node dist/index.js config path                        # prints ~/.auto-embed/config.json
node dist/index.js config set defaults.provider openai
node dist/index.js config get defaults.provider      # prints "openai"
stat -c '%a' ~/.auto-embed/config.json               # prints 600
```

---

### M2 — Parsers (2–3 days)

**Goal:** turn any supported file into a `ParsedDocument`.

Build in this order (each independently testable):

1. `src/parsers/text.ts` — `.txt`, `.json`, `.jsonl`, `.csv`, code files (built-ins).
2. `src/parsers/markdown.ts` — `unified` + `remark-parse`, walk AST, emit sections keyed by header path.
3. `src/parsers/pdf.ts` — `unpdf`, page-by-page text + page-number metadata.
4. `src/parsers/html.ts` — `cheerio`, strip nav/aside/footer/script, extract semantic blocks.
5. `src/parsers/docx.ts` — `mammoth` → MD → reuse markdown parser.

`src/parsers/index.ts` — dispatcher: filename → parser, with content-sniff fallback.

**Tests:** golden-file tests under `test/fixtures/` (one tiny sample per type).

**Acceptance:**
```bash
bun run test test/parsers.test.ts                    # all green
```
Coverage on `src/parsers/**` ≥ 80%. Each parser has at least one golden-file test.

---

### M3 — Chunker + Lockfile + dry-run (2 days)

**Goal:** parsed documents become deterministic chunks with stable IDs; dry-run shows the plan.

- `src/chunker/recursive.ts` — token-aware recursive char splitter (port of LangChain's algorithm, ~150 LOC, no LangChain dep).
- `src/chunker/markdown.ts` — header-aware splitter on top of recursive.
- `src/chunker/code.ts` — language-aware separators (functions, classes, blank lines).
- `src/chunker/index.ts` — dispatches by `splitter` field on `EmbedPlan`.
- `src/lockfile.ts` — read/write `.auto-embed.lock.json`; compute file hash; diff old vs new chunk IDs.
- `src/plan/heuristic.ts` — build an `EmbedPlan` from file extension alone (no LLM).
- `auto-embed embed --dry-run` — runs parse + chunk, prints a table of chunks with IDs, sizes, metadata.
- `auto-embed plan <file>` — writes the heuristic plan to `plan.json`.

**Acceptance:**
```bash
bun run test test/chunker.test.ts test/lockfile.test.ts test/plan.test.ts
node dist/index.js embed test/fixtures/parsers/sample.md --dry-run | grep -E "chunks?"
# determinism check: same input → same chunk IDs
H1=$(node dist/index.js embed test/fixtures/parsers/sample.md --dry-run | sha256sum)
H2=$(node dist/index.js embed test/fixtures/parsers/sample.md --dry-run | sha256sum)
[ "$H1" = "$H2" ]                                    # exits 0
node dist/index.js plan test/fixtures/parsers/sample.md  # writes plan.json
```

---

### M4 — Embedding providers + `--local` end-to-end (3 days)

**Goal:** chunks become vectors. First "real" pipeline.

- `src/providers/openai.ts`, `google.ts`, `voyage.ts`, `cohere.ts`, `fastembed.ts` — each implements `EmbeddingProvider`.
- `src/embed/engine.ts` — batching, concurrency limit (`p-limit`), exponential backoff retry on 429/5xx.
- First vector-DB adapter: `src/vector-dbs/chroma.ts` (easiest local target).
- Wire up `auto-embed embed file.md --local` → fastembed + Chroma local → writes vectors to `./chroma/`.

**Ship checkpoint.** At this point the tool is end-to-end functional with `--local`. This is the smallest publishable version — could ship to npm as `0.1.0` here. **Continue, do not actually publish until M7.**

**Acceptance:**
```bash
node dist/index.js embed README.md --local                    # first run: embeds
node dist/index.js embed README.md --local | grep -q "up to date"   # second run: idempotent
ls .auto-embed/*.lock.json                                    # lockfile exists
# editing the file invalidates the lockfile:
echo "new paragraph" >> README.md
node dist/index.js embed README.md --local | grep -E "embedded [0-9]+ chunks?"
```

---

### M5 — Remaining vector-DB adapters (2–3 days)

**Goal:** parity across all v1 vector DBs.

- `src/vector-dbs/pgvector.ts` — `pg` driver, `CREATE TABLE IF NOT EXISTS`, ON CONFLICT upsert, dimension check via `information_schema`.
- `src/vector-dbs/pinecone.ts` — `@pinecone-database/pinecone`, ensure index, batched upsert, describe-index dimension check.
- `src/vector-dbs/qdrant.ts` — `@qdrant/js-client-rest`, ensure collection, upsert, get-collection dimension check.
- `src/vector-dbs/index.ts` — registry, `--db` flag dispatch.
- Pre-flight dimension-mismatch guard wired into the orchestrator (block before any API call).

**Tests:** mock each client; one integration test per DB behind `INTEGRATION=1` env (devs can spin up locally; CI runs only the mock layer).

**Acceptance (unit, always run):**
```bash
bun run test test/vector-dbs                                  # mocked clients
```
**Acceptance (integration, opt-in — requires real instances):**
```bash
# pgvector via local Postgres
INTEGRATION=1 DATABASE_URL=postgres://localhost/test bun run test test/vector-dbs/pgvector.int.test.ts
# qdrant via docker run -p 6333:6333 qdrant/qdrant
INTEGRATION=1 QDRANT_URL=http://localhost:6333 bun run test test/vector-dbs/qdrant.int.test.ts
# pinecone / chroma similarly
```
**Dimension-mismatch guard:**
```bash
node dist/index.js embed sample.md --local                    # writes 384-dim vectors
node dist/index.js embed sample.md --provider openai          # must exit 5 with hint, no API call made
```

---

### M6 — Optional `--plan` (LLM-tuned) + polish (1–2 days)

**Goal:** the optional LLM planner from PRD §6.4.

- `src/plan/llm.ts` — single LLM call (Anthropic/OpenAI/Google, reuse auto-seed's provider abstraction), zod-validated `EmbedPlan` output.
- `--plan` flag wired in; `--plan <file>` loads existing.
- `--plan-only` writes the plan and exits.
- Cost estimator on `--dry-run`: token count × provider price → USD.
- Pretty output: ingestion summary line, error taxonomy with exit codes (mirror auto-seed):
  - `0` success
  - `1` user/config error
  - `2` parser error
  - `3` provider API error
  - `4` vector DB error
  - `5` integrity error (dim mismatch, etc.)

**Acceptance:**
```bash
ANTHROPIC_API_KEY=sk-ant-... node dist/index.js embed sample.md --plan --dry-run
# output includes the LLM-tuned plan JSON and an estimated USD cost
node dist/index.js embed sample.md --plan-only --out plan.json
node dist/index.js embed sample.md --plan plan.json --local    # reuses plan, no LLM call
# exit code tests:
node dist/index.js embed nonexistent.md ; [ $? -eq 1 ]
node dist/index.js embed test/fixtures/parsers/broken.pdf ; [ $? -eq 2 ]
```

---

### M7 — Docs, examples, release prep (1–2 days)

**Goal:** ready for `npm publish`.

- Full README (mirror auto-seed's structure; PRD § flow → quick start → flags → config → "How it works" → exit codes → notes).
- `docs/` with one short page per vector DB and per provider (env vars, gotchas).
- `examples/` — small repo snippets: ingest-readme, ingest-pdf-corpus, ingest-csv-faq.
- `.npmignore` / `files` in `package.json` cleaned.
- Verify npm name availability; reserve fallback scope.
- Manual smoke test on a fresh machine + fresh Node install.
- Cut `v1.0.0`, tag, `npm publish`.

**Acceptance:**
```bash
npm pack                                                      # produces auto-embed-1.0.0.tgz
du -sh auto-embed-1.0.0.tgz                                   # well under 30MB
cd /tmp && mkdir smoke && cd smoke
npm i ../path/to/auto-embed-1.0.0.tgz
npx auto-embed --version                                      # prints 1.0.0
npx auto-embed embed ./README.md --local                      # end-to-end smoke
# only when the above is green:
npm publish --access public
```

---

## Critical-path dependency graph

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5 ──▶ M6 ──▶ M7
                              │
                              └──▶ (publishable here as 0.1.0)
```

Nothing is parallelizable for a solo dev — each milestone is a prerequisite for the next.

## Test strategy

- **Unit:** every parser, chunker, lockfile-diff function. Golden fixtures under `test/fixtures/`. Target ≥ 80% line coverage on `src/core/**`.
- **Provider adapters:** mocked at the HTTP layer with `msw` or hand-rolled fetch stubs.
- **Vector DB adapters:** mocked clients for unit; opt-in integration suite (`INTEGRATION=1 bun run test`) for real-instance verification.
- **CLI:** spawn `dist/index.js` in a subprocess against `test/fixtures/projects/`, assert stdout/exit codes.
- **Determinism:** "run twice, hash output" tests on chunker, lockfile, plan generation.

## Risk register (matches PRD §10)

| Risk | Likelihood | Impact | Mitigation phase |
|---|---|---|---|
| Weird PDFs break `unpdf` | High | Medium | M2: detect + clear error; OCR backlog post-v1 |
| Provider rate limits during big ingests | Medium | High | M4: batching + concurrency + retry |
| Lockfile churn in git | Medium | Low | README recommends commit; lockfile is small + content-keyed |
| Dimension mismatch corrupts collection | Low | **Critical** | M5: pre-flight `describeCollection` check, refuse without `--force` |
| fastembed download (~30 MB) feels slow | Medium | Low | M4: prominent progress bar, document one-time cost |
| npm name taken | Low | Medium | M7: verify early, fallback to scoped name |

## Out of scope reminders (from PRD §5, restated for build discipline)

- No `auto-embed db` subcommand in v1.
- No retrieval / query side.
- No multi-modal.
- No OCR.
- No reranking.
- No watch mode.

These get a `// TODO(v2):` marker if they come up during implementation. Do not start them.

## Definition of Done for v1.0.0

- All v1 file types ingest successfully on fixture corpus.
- All 4 vector DBs upsert against real instances (manual verification).
- All 5 providers embed successfully (manual verification).
- `npx auto-embed embed README.md --local` works on a clean Node 18/20/22 install.
- Re-running an unchanged file makes zero API calls.
- Changing one paragraph of a 100-page PDF re-embeds only the chunks that contain that paragraph.
- Switching embedding model on the same collection is blocked with an actionable error.
- README quick-start path verified end-to-end on macOS, Linux, Windows.
- Package size < 30 MB unpacked.
- CI green on Node 18, 20, 22.
