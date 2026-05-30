# AGENTS.md

Working notes for `auto-embed` — a zero-config CLI that ingests files into vector databases for RAG projects.

Read `CLAUDE.md` first for binding conventions, then `PRD.md` (spec) and `PLAN.md` (milestone sequence).

## Build / run / test

- Build: `bun run build` (tsup → `dist/index.js`). Run after every change.
- Dev (no build): `bun run dev -- <args>` (tsx runs `src/index.ts`).
- Typecheck: `bun run typecheck`. Tests: `bun run test` (vitest).
- All three of `typecheck`, `test`, `build` must be green before any commit.

## Pipeline

```
parse → chunk → embed → upsert
                  │
                  └─▶ lockfile (idempotency)
```

1. **Parsers** (`src/parsers/*`) → `ParsedDocument` (one per file type). No knowledge of chunking or DBs.
2. **Chunker** (`src/chunker/*`) — token-aware recursive split, header-aware for markdown, language-tuned for code. Output: `Chunk[]` with deterministic IDs.
3. **Providers** (`src/providers/*`) — embedding-provider adapters. OpenAI, Google, Voyage, Cohere, fastembed (local).
4. **Vector DBs** (`src/vector-dbs/*`) — Chroma, pgvector, Pinecone, Qdrant.
5. **Pipeline** (`src/embed/pipeline.ts`) — orchestrates the above; reads/writes the lockfile.

Strict layering, no circular deps. See `CLAUDE.md` § Strict layering.

## Conventions (short list — full list in `CLAUDE.md`)

- ESM only. TS strict. Relative imports use `.js` extensions.
- Lazy-import parsers / providers / DB clients at use time, not top-level (cold-start budget: 500 ms).
- Errors at the boundary throw `AutoEmbedError` (`src/errors.ts`) with an `ExitCode`. One-line message + optional `hint:` line.
- All logging goes through `src/log.ts`. Never mix raw `console.log` with `picocolors` ad-hoc.
- API keys are always masked. Never write a key to a generated file or to the lockfile.
- Determinism: no `Date.now()` / `Math.random()` in chunk-ID or plan-hash derivation.
- Build one milestone at a time. See `PLAN.md`.

## Anti-patterns

See `CLAUDE.md` § "Anti-patterns Claude tends to fall into — avoid". The big ones:

- No `langchain`, `pdf-parse`, or `node-fetch`. Use `js-tiktoken` for tokens, `unpdf` for PDFs, global `fetch`.
- No Anthropic for embeddings — Anthropic does not ship embeddings.
- No features outside `PRD.md` § 6. `// TODO(v2):` and stop.
