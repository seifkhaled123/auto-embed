# Local embeddings (fastembed)

## Quick start

```bash
npx auto-embed embed ./docs/handbook.md --local
# equivalent to: --provider local --db chroma --collection <derived>
```

No API key. Embeddings run on-device via [`fastembed`](https://github.com/Anush008/fastembed-js) (ONNX Runtime + a small BGE model).

## Models

| Model | Dimensions | Approx. size |
|---|---|---|
| `BAAI/bge-small-en-v1.5` | 384 | 30 MB |
| `BAAI/bge-base-en-v1.5` | 768 | 110 MB |
| `BAAI/bge-small-en` | 384 | 30 MB |
| `BAAI/bge-base-en` | 768 | 110 MB |
| `sentence-transformers/all-MiniLM-L6-v2` | 384 | 80 MB |
| `intfloat/multilingual-e5-large` | 1024 | 530 MB |

The model is downloaded to a local cache on first use. Subsequent runs reuse it.

## Config keys

| Path | Env var | Notes |
|---|---|---|
| `models.local` | `AUTO_EMBED_MODEL` | switch the local model with `--model` |

## Gotchas

- onnxruntime-node ships native binaries; if `bun install` / `npm install` warns about untrusted scripts, allow them (`bun pm trust --all`). Without the postinstall, the model can't load.
- The first `--local` run pays a one-time model download cost (~30 MB for the default model). Subsequent runs reuse the cache.
- Cold-start latency is ~1–2 seconds for ONNX session creation; the same process embeds subsequent batches at full speed.
