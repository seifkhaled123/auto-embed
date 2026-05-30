# Contributing to auto-embed

Thanks for taking the time to contribute! Pull requests are welcome. This document explains how to set up the project, the conventions the codebase follows, and what kinds of changes are most useful.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

## Ways to contribute

| Type | What's most useful |
|---|---|
| Bug reports | A minimal input file + the exact command + the error/exit code. |
| Feature requests | PRs are welcome. For larger or ambiguous features, open an issue first — some features are explicit non-goals (see [PRD.md](./PRD.md) § 5 & § 11). |
| Parser improvements | New file types, edge cases in existing parsers. Always include a tiny fixture under `test/fixtures/parsers/`. |
| Vector-DB adapters | Adding a new vector DB is a v2 plugin shape. Open an issue first. |
| Provider improvements | New embedding providers or batching / retry tweaks for existing ones. Include an HTTP-mocked test. |
| Docs | Examples, troubleshooting recipes, sample-of-the-week. |

## Project setup

Requirements:

- **Node.js ≥ 18**
- **Bun ≥ 1.0** (used for dev scripts and tests; the published artifact is plain Node-runnable ESM)

```bash
git clone https://github.com/seif-kh/auto-embed.git
cd auto-embed
bun install
bun run typecheck     # tsc --noEmit
bun run test          # vitest
bun run build         # tsup → dist/index.js
```

Sanity-check the built CLI:

```bash
node dist/index.js --help
node dist/index.js --version
```

## Architecture cheat-sheet

```
src/
├─ index.ts              CLI entry (commander wiring + top-level error handler)
├─ commands/             init, embed, plan, config, providers
├─ config/               ~/.auto-embed/config.json + env-var precedence + key masking
├─ parsers/              md / pdf / html / docx / csv / json / txt / code → ParsedDocument
├─ chunker/              token-aware recursive splitter, markdown header-aware, code-aware
├─ plan/                 EmbedPlan zod schema, heuristic plan, optional LLM-tuned plan
├─ providers/            EmbeddingProvider interface + OpenAI / Google / Voyage / Cohere / fastembed
├─ vector-dbs/           VectorDB interface + Chroma / pgvector / Pinecone / Qdrant
├─ embed/                batching + retry engine + pipeline orchestrator
├─ lockfile.ts           .auto-embed/<hash>.lock.json read/write/diff
├─ errors.ts             AutoEmbedError + ExitCode
└─ log.ts                single logging helper
```

Read [PRD.md](./PRD.md) for the spec and [PLAN.md](./PLAN.md) for the milestone sequence.

## Conventions

- **TypeScript strict, ESM only.** No CommonJS. No `require`. Relative imports use `.js` extensions in TS source.
- **`noUncheckedIndexedAccess` is on.** `arr[i]` is `T | undefined`; handle it.
- **Errors → `AutoEmbedError`.** Top-level handler prints a single line + an optional hint and sets the exit code. Stack traces print only with `--verbose`. Exit codes: `1` user/config, `2` parser, `3` provider API, `4` vector DB, `5` integrity (e.g. dim mismatch).
- **Determinism.** Chunk IDs and plan hashes are derived purely from content — no `Date.now()`, no `Math.random()`.
- **Lazy imports.** Parser, provider, and DB-adapter modules `await import('…')` at use time, not at top-level. Cold-start budget is 500 ms.
- **Mask keys.** Never `console.log` a key. Never write a key to a generated file or to the lockfile.
- **Tests, ideally first.** New parser cases need a fixture under `test/fixtures/parsers/`. New adapters need HTTP-mocked tests; opt-in integration tests live behind `INTEGRATION=1`.
- **Don't broaden the dependency tree casually.** Each runtime dep ships to every `npx auto-embed` user. See [CLAUDE.md](./CLAUDE.md) § "Anti-patterns" for things explicitly excluded (`langchain`, `pdf-parse`, `node-fetch`).

## Commit messages

This repo uses short, scoped messages. The convention is loose Conventional Commits:

```
feat(parsers): support .mdx via remark-mdx
fix(chunker): handle empty markdown sections without zero-length splits
docs(readme): clarify --local quick-start
test(lockfile): diff identical chunks → empty changeset
```

Keep the subject line under ~72 chars. Use the body for the *why* if it isn't obvious.

## Pull requests

- Contributions are welcome from new and returning contributors.
- Open a PR against `main`. Small, focused PRs review faster than big ones.
- The PR description should call out:
  - The user-visible behavior change
  - Anything that changes the on-disk file format (`config.json`, lockfile shape, EmbedPlan JSON shape)
  - Whether it adds a runtime dependency
- All of `bun run typecheck`, `bun run test`, and `bun run build` must pass.
- CI runs the same three commands; please run them locally first.

## Releasing

(Maintainer notes.)

1. Bump `package.json#version` and the `VERSION` constant in `src/index.ts`. Keep them in sync.
2. `bun run typecheck && bun run test && bun run build`
3. Tag: `git tag v<version> && git push --tags`
4. `npm publish` — `prepublishOnly` re-runs the three checks above.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
