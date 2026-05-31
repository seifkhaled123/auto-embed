# Example — ingest a README

The smallest possible flow. Embeds one markdown file locally into Chroma, then demonstrates idempotent re-runs.

## Run

```bash
# From the auto-embed repo root:
cd examples/ingest-readme

# First run: parses, chunks, embeds, upserts
npx @seifkhaled/auto-embed embed ./input.md --local

# Second run: zero API calls, exits in ~50ms
npx @seifkhaled/auto-embed embed ./input.md --local

# Edit a paragraph in input.md, run again — only the changed chunks re-embed
```

After the first run you'll see `.auto-embed/<hash>.lock.json` (commit it to share idempotency with CI) and `./chroma/` (the local Chroma data dir). The Chroma server stays running between invocations; stop it with `pkill -f "chroma run"`.

## What's inside `input.md`

A short markdown file with H1/H2/H3 sections, so the markdown splitter has something to do. Look at the chunk table with `--dry-run` to see how it's broken up.
