# Security Policy

## Supported versions

`auto-embed` is pre-1.0. Once `1.0.0` ships, only the latest minor of the `1.x` line will receive security fixes.

| Version | Supported |
|---|---|
| 0.x     | ✅ (development) |

## Reporting a vulnerability

Public issues and pull requests are welcome for normal bugs, documentation fixes, and feature work.

For suspected security vulnerabilities, please email first instead of opening a public issue or PR that includes exploit details. This gives the project time to investigate and prepare a fix before the vulnerability is public.

Email **seif.kh021@gmail.com** with:

- A short description of the issue and its impact.
- Steps to reproduce (a minimal file / command / config snippet if possible).
- The version of `auto-embed` you observed it on (`auto-embed --version`).
- Your Node.js version and OS.

You should expect:

- An acknowledgement within **3 business days**.
- A fix or written triage plan within **14 days** for confirmed issues.
- Credit in the release notes (unless you ask to remain anonymous).

If the issue is in a third-party dependency, I'll forward it upstream and track the patch.

## Threat model & what counts

`auto-embed` is a **developer CLI**. It:

- Reads input files from the local working directory.
- Reads API keys from `~/.auto-embed/config.json` or environment variables.
- Makes outbound HTTPS calls to the configured embedding provider and vector DB.
- Writes a per-file lockfile to `./.auto-embed/`.

In-scope concerns:

| Category | Examples |
|---|---|
| Secret handling | API keys leaking into logs, generated files, or error messages. `~/.auto-embed/config.json` permissions weakening. |
| Path traversal | A file argument or `--out-vectors` argument escaping the intended directory. |
| Supply chain | A vulnerable transitive dependency that becomes reachable via `auto-embed`. |
| Lockfile tampering | A malicious lockfile that causes the tool to skip embedding it should perform, or delete chunks it shouldn't. |

Out of scope:

- Reports that boil down to "if a malicious user runs my CLI with a malicious file, bad things happen." Treat input files as content you trust enough to feed to a parser.
- Vulnerabilities in third-party embedding providers or vector DBs themselves. (Please report those to the provider.)
- Anything that requires write access to `~/.auto-embed/` or the local source tree by an attacker who already has shell access.

## Safe-handling guidelines (for users)

- Prefer **environment variables** (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, `VOYAGE_API_KEY`, `COHERE_API_KEY`, `PINECONE_API_KEY`, `QDRANT_API_KEY`, `DATABASE_URL`, `CHROMA_URL`) in CI; the config file is a developer-machine convenience.
- The config file is created with mode `0600`. If you copy it across machines, preserve that mode (`chmod 600 ~/.auto-embed/config.json`).
- Never commit `~/.auto-embed/config.json` or any `.env*` file to source control.
- Lockfiles in `./.auto-embed/` contain no secrets and are safe to commit. Treat them like `package-lock.json`.

## Hardening notes

- API keys are **never** included in generated files or in `console.log` output. They are masked (`sk-…abcd`) in `config list` / `config get` and in all error output.
- File writes are atomic where possible (write-to-temp + `rename`).
- Embedding-provider responses are validated before write; malformed JSON or unexpected shapes trigger exit code `3` with no partial writes.
- The dimension-mismatch guard refuses to write vectors into a collection whose existing dimension differs from the configured model.

## Public security disclosures

None yet. This section will be updated when the first one lands.
