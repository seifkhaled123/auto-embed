# auto-embed

Zero-config CLI that ingests files into a vector database for RAG projects. Parse, chunk, embed, upsert — one command.

> Work in progress. Tracking v1.0.0 against [PRD.md](./PRD.md) / [PLAN.md](./PLAN.md).

```bash
npx auto-embed init                              # one-time: pick provider + DB
npx auto-embed embed ./docs/handbook.pdf         # parse → chunk → embed → upsert
npx auto-embed embed "./docs/**/*.md" --collection handbook
```

Sibling of [`auto-seed`](https://www.npmjs.com/package/auto-seed): same opinionated, one-command philosophy.

## Status

See [PLAN.md](./PLAN.md) for the milestone sequence. M0 (scaffold) is in progress; the CLI exposes `--help` and `--version` but no commands are implemented yet.

## License

[MIT](./LICENSE)
