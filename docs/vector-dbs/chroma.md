# Chroma

## Quick start (local, zero setup)

```bash
npx auto-embed embed ./docs/handbook.md --local
# spawns `chroma run --path ./chroma` in the background on first use,
# leaves it running so subsequent invocations reuse it.
```

## Quick start (remote server)

```bash
CHROMA_URL=https://chroma.internal:8000 \
  npx auto-embed embed ./docs/handbook.md --db chroma
```

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `dbs.chroma.url` | `CHROMA_URL` | http(s) URL **or** a local filesystem path (`./chroma`) |

## Gotchas

- `--local` defaults the URL to `./chroma` and auto-spawns the Chroma server bundled in `node_modules/.bin/chroma`. The server keeps running after the CLI exits so the next run reuses it — stop it with `pkill -f "chroma run"`.
- Chroma rejects nested objects in metadata. Auto-embed flattens arrays to `/`-joined strings and serialises objects to JSON before upserting.
- The collection's dimension is **not stored explicitly** in Chroma v3; the integrity guard relies on the lockfile + the embedding provider's declared dimension. If you upsert from outside auto-embed against the same collection, keep dimensions consistent yourself.
- For `--local` to work in CI, the runner needs the `chromadb` postinstall scripts allowed. With Bun: `bun pm trust --all`. With npm: nothing extra (npm runs postinstalls by default).
