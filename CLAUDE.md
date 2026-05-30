# CLAUDE.md — auto-embed

This file is auto-loaded by Claude Code on every session in this repo. Read it first, then [PRD.md](./PRD.md) for the product spec and [PLAN.md](./PLAN.md) for the implementation plan.

## What this project is

A zero-config CLI (`auto-embed`) that ingests files into vector databases for RAG projects. Sibling to [`auto-seed`](https://www.npmjs.com/package/auto-seed) — match its style, surface, and config model.

**Always check `~/dev/auto-seed`** for prior art before writing infra code (config loader, key masking, `init` flow, error formatting, CLI bootstrap). Reuse patterns, don't reinvent.

## Commands

```bash
bun run dev              # tsx src/index.ts (live)
bun run build            # tsup → dist/
bun run typecheck        # tsc --noEmit
bun run test             # vitest run
bun run test:watch       # vitest watch
node dist/index.js ...   # exercise the built CLI
```

`bun run typecheck && bun run test && bun run build` must be green before any commit.

## Tech stack (locked — do not swap)

- **Runtime:** Node ≥ 18, ESM only, TypeScript strict.
- **Build:** `tsup` → single ESM bundle in `dist/`.
- **CLI:** `commander` (args), `@clack/prompts` (interactive), `ora` (spinners), `picocolors` (color).
- **Validation:** `zod` v3 (NOT v4; stay aligned with auto-seed).
- **Tokens:** `js-tiktoken` (pure JS, no native deps).
- **Concurrency:** `p-limit`, `p-retry`.
- **Tests:** `vitest`.

See [PLAN.md § Dependencies](./PLAN.md#dependencies) for the full pinned list per area (parsers, providers, vector DBs).

## Code conventions

- ESM only. No CommonJS. No `require()`. Use `import` with explicit `.js` extensions in relative imports (TS source files import as `./foo.js`).
- `strict: true` in tsconfig. No `any` unless interfacing with an untyped library, and then with a `// eslint-disable-next-line` or a `as unknown as T` cast at the boundary only.
- Prefer named exports. One concern per file.
- No comments unless the WHY is non-obvious. Never describe what well-named code already says.
- No emojis in code, output, or docs unless the user asks.
- Errors throw a typed `AutoEmbedError` carrying an exit code (see [PLAN.md § Error format](./PLAN.md#error-format)). One-line message + optional `hint:` line. Stack traces only with `--verbose`.
- API keys are **always** masked via `src/config/mask.ts`. Never `console.log(key)`. Never write a key into a generated file or lockfile.
- Logging goes through a single helper module — never mix raw `console.log` with `picocolors`-formatted output ad-hoc.

## Strict layering

```
commands/ ──▶ embed/pipeline ──▶ parsers/  +  chunker/  ──▶  providers/  ──▶  vector-dbs/
                  │                                                            │
                  └────────────────── lockfile ◀───────────────────────────────┘
```

- `parsers/` knows nothing about chunking, embedding, or vector DBs.
- `chunker/` knows nothing about embedding or vector DBs.
- `providers/` knows nothing about vector DBs.
- `vector-dbs/` knows nothing about embedding providers.
- No circular deps. CI should fail if `madge --circular` finds one (add to test step).

## Anti-patterns Claude tends to fall into — avoid

1. **Do not depend on `langchain` / `@langchain/*`.** We intentionally avoid the bloat. Port the small bits we need (the recursive splitter is ~150 LOC).
2. **Do not use `pdf-parse`.** Known bug: it runs test code on import. Use `unpdf`.
3. **Do not depend on `node-fetch`.** Node 18+ has global `fetch`.
4. **Do not use `Date.now()` or `Math.random()` in chunk-ID derivation or plan-hash derivation.** These must be deterministic from content alone.
5. **Do not add features not in [PRD.md § Scope](./PRD.md#6-scope).** Explicitly excluded in v1: `auto-embed db` subcommand, retrieval/query, watch mode, OCR, multi-modal, reranking. If you find yourself wanting one, mark `// TODO(v2):` and stop.
6. **Do not use Anthropic for embeddings.** Anthropic does not ship embeddings. It appears only in the optional `--plan` LLM-tuning code path (alongside OpenAI and Google).
7. **Do not introduce a logger framework** (winston, pino). Use the one helper module.
8. **Do not auto-format with prettier in pre-commit** unless the user adds it. Auto-seed doesn't.
9. **Do not add a `--watch` flag, a query command, or DB-row ingestion** — explicitly v2.
10. **Do not load entire large files into memory** if the parser supports streaming (`unpdf` does for PDFs).
11. **Do not add backwards-compat shims, dead `// removed` comments, or speculative abstractions.** Three similar lines beats a premature abstraction.
12. **Do not write tests that hit real provider APIs by default.** Mock at the HTTP boundary. Integration tests are opt-in via `INTEGRATION=1`.

## File layout

Authoritative tree in [PLAN.md § Directory layout](./PLAN.md#directory-layout). When adding a new file, match the existing module's shape and locate it in the right layer above.

## Building one milestone at a time

Build strictly in milestone order (M0 → M7 in [PLAN.md](./PLAN.md)). Each milestone has explicit acceptance commands — run them, paste the output, confirm green before moving on. Do not start M4 work while M3 acceptance is failing.

If a task feels like it spans multiple milestones, you are probably about to violate scope. Stop and re-read the PRD.

## When the spec is ambiguous

Ask. Do not guess silently. The PRD has an "Open questions" section ([PRD.md § 10](./PRD.md#10-risks--open-questions)); if your question fits there, surface it before implementing one direction.
