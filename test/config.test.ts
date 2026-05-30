import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configFilePath,
  flatten,
  getPath,
  loadConfig,
  resolveRuntime,
  saveConfig,
  setPath,
} from "../src/config/index.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const PROVIDER_ENV_NAMES = [
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "VOYAGE_API_KEY",
  "COHERE_API_KEY",
  "PINECONE_API_KEY",
  "QDRANT_API_KEY",
  "AUTO_EMBED_PROVIDER",
  "AUTO_EMBED_DB",
  "AUTO_EMBED_MODEL",
];
const ORIGINAL_PROVIDER_ENV: Record<string, string | undefined> = {};

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  for (const name of PROVIDER_ENV_NAMES) {
    ORIGINAL_PROVIDER_ENV[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  for (const name of PROVIDER_ENV_NAMES) {
    const prev = ORIGINAL_PROVIDER_ENV[name];
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

describe("configFilePath", () => {
  it("points inside the current HOME", () => {
    expect(configFilePath().startsWith(tmpHome)).toBe(true);
    expect(path.basename(configFilePath())).toBe("config.json");
  });
});

describe("loadConfig / saveConfig", () => {
  it("returns empty config when no file exists", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual({});
  });

  it("round-trips a config through disk", async () => {
    const before = {
      defaults: { provider: "openai" as const, db: "chroma" as const },
      apiKeys: { openai: "sk-secret-test" },
    };
    await saveConfig(before);
    const after = await loadConfig();
    expect(after).toEqual(before);
  });

  it("writes the config file with 0600 perms", async () => {
    await saveConfig({ defaults: { provider: "openai" } });
    if (process.platform === "win32") return;
    const mode = fs.statSync(configFilePath()).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("rejects invalid JSON with an actionable error", async () => {
    await fsp.mkdir(path.dirname(configFilePath()), { recursive: true });
    await fsp.writeFile(configFilePath(), "{ not json");
    await expect(loadConfig()).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a config that fails the schema", async () => {
    await fsp.mkdir(path.dirname(configFilePath()), { recursive: true });
    await fsp.writeFile(
      configFilePath(),
      JSON.stringify({ defaults: { provider: "bogus" } }),
    );
    await expect(loadConfig()).rejects.toThrow(/invalid/);
  });
});

describe("setPath / getPath", () => {
  it("sets and reads a dotted path", () => {
    const cfg = setPath({}, "defaults.provider", "openai");
    expect(getPath(cfg, "defaults.provider")).toBe("openai");
  });

  it("sets nested dbs.* paths", () => {
    const cfg = setPath({}, "dbs.pgvector.url", "postgres://x:y@h/d");
    expect(getPath(cfg, "dbs.pgvector.url")).toBe("postgres://x:y@h/d");
  });

  it("refuses unknown keys", () => {
    expect(() => setPath({}, "foo.bar", "x")).toThrow(/Unknown config key/);
  });

  it("returns undefined for missing path", () => {
    expect(getPath({}, "defaults.provider")).toBeUndefined();
  });
});

describe("flatten (mask-aware)", () => {
  it("masks API keys", () => {
    const cfg = setPath({}, "apiKeys.openai", "sk-supersecretkey1234");
    const flat = flatten(cfg);
    expect(flat["apiKeys.openai"]).not.toContain("supersecret");
    expect(flat["apiKeys.openai"]).toContain("…");
  });

  it("masks passwords in URLs", () => {
    const cfg = setPath({}, "dbs.pgvector.url", "postgres://u:topsecret@h/d");
    expect(flatten(cfg)["dbs.pgvector.url"]).not.toContain("topsecret");
  });

  it("returns plain values for non-secret paths", () => {
    const cfg = setPath({}, "defaults.provider", "openai");
    expect(flatten(cfg)["defaults.provider"]).toBe("openai");
  });
});

describe("resolveRuntime", () => {
  it("uses overrides over env over config over defaults", () => {
    const r = resolveRuntime(
      { defaults: { provider: "google" } },
      { provider: "voyage" },
      { VOYAGE_API_KEY: "v-key" },
    );
    expect(r.provider).toBe("voyage");
    expect(r.apiKey).toBe("v-key");
  });

  it("reads API key from env first", () => {
    const r = resolveRuntime(
      { apiKeys: { openai: "cfg-key" } },
      {},
      { OPENAI_API_KEY: "env-key" },
    );
    expect(r.apiKey).toBe("env-key");
  });

  it("falls back to config key when env is missing", () => {
    const r = resolveRuntime({ apiKeys: { openai: "cfg-key" } }, {}, {});
    expect(r.apiKey).toBe("cfg-key");
  });

  it("throws when no key is available for a non-local provider", () => {
    expect(() => resolveRuntime({}, { provider: "openai" }, {})).toThrow(/No API key/);
  });

  it("requires no key for local provider", () => {
    const r = resolveRuntime({}, { provider: "local" }, {});
    expect(r.apiKey).toBe("");
    expect(r.provider).toBe("local");
  });

  it("uses model override > env > config > provider default", () => {
    const a = resolveRuntime({}, { provider: "openai", model: "custom" }, { OPENAI_API_KEY: "k" });
    expect(a.model).toBe("custom");
    const b = resolveRuntime({}, { provider: "openai" }, { OPENAI_API_KEY: "k", AUTO_EMBED_MODEL: "envm" });
    expect(b.model).toBe("envm");
    const c = resolveRuntime({ models: { openai: "cfgm" } }, { provider: "openai" }, { OPENAI_API_KEY: "k" });
    expect(c.model).toBe("cfgm");
    const d = resolveRuntime({}, { provider: "openai" }, { OPENAI_API_KEY: "k" });
    expect(d.model).toBe("text-embedding-3-small");
  });
});
