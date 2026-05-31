import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmPlan, loadPlanFile, resolvePlannerProvider } from "../src/plan/llm.js";

const originalFetch = globalThis.fetch;

interface MockSpec {
  status?: number;
  body: unknown;
}

function mockFetch(responses: MockSpec[] | ((url: string, init: RequestInit | undefined) => MockSpec)) {
  const seq = Array.isArray(responses) ? responses : null;
  let i = 0;
  const fn = vi.fn(async (input: URL | Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const spec = seq ? seq[i++]! : (responses as (u: string, init?: RequestInit) => MockSpec)(url, init);
    return new Response(JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

let tmp: string;
let file: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-plan-"));
  file = path.join(tmp, "doc.md");
  await fsp.writeFile(file, "# Title\n\nHello world. This is a sample doc.\n");
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await fsp.rm(tmp, { recursive: true, force: true });
});

const VALID_PLAN = {
  splitter: "markdown" as const,
  chunkSize: 800,
  overlap: 100,
  collection: "doc",
  metadata: { doc_type: "test" },
};

describe("llmPlan via Anthropic", () => {
  it("posts to /v1/messages and returns a validated EmbedPlan", async () => {
    const fn = mockFetch((url, init) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-ant-test");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      return {
        body: {
          content: [{ type: "text", text: JSON.stringify(VALID_PLAN) }],
        },
      };
    });
    const plan = await llmPlan({
      sourcePath: file,
      embeddingModel: "text-embedding-3-small",
      provider: "anthropic",
      apiKey: "sk-ant-test",
    });
    expect(plan.version).toBe(1);
    expect(plan.splitter).toBe("markdown");
    expect(plan.chunkSize).toBe(800);
    expect(plan.collection).toBe("doc");
    expect(plan.embeddingModel).toBe("text-embedding-3-small");
    expect(plan.metadata).toEqual({ doc_type: "test" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("strips ```json fences when the model wraps its JSON", async () => {
    mockFetch([
      {
        body: {
          content: [
            {
              type: "text",
              text: "```json\n" + JSON.stringify(VALID_PLAN) + "\n```",
            },
          ],
        },
      },
    ]);
    const plan = await llmPlan({
      sourcePath: file,
      embeddingModel: "text-embedding-3-small",
      provider: "anthropic",
      apiKey: "sk-ant",
    });
    expect(plan.splitter).toBe("markdown");
  });

  it("retries once on invalid JSON and succeeds on the second attempt", async () => {
    const fn = mockFetch([
      { body: { content: [{ type: "text", text: "not json" }] } },
      { body: { content: [{ type: "text", text: JSON.stringify(VALID_PLAN) }] } },
    ]);
    const plan = await llmPlan({
      sourcePath: file,
      embeddingModel: "text-embedding-3-small",
      provider: "anthropic",
      apiKey: "sk-ant",
    });
    expect(plan.splitter).toBe("markdown");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws ProviderApi after a second invalid response", async () => {
    mockFetch([
      { body: { content: [{ type: "text", text: "garbage" }] } },
      { body: { content: [{ type: "text", text: "still garbage" }] } },
    ]);
    await expect(
      llmPlan({
        sourcePath: file,
        embeddingModel: "text-embedding-3-small",
        provider: "anthropic",
        apiKey: "sk-ant",
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("surfaces an HTTP error with a clean message", async () => {
    mockFetch([{ status: 401, body: { error: { message: "invalid api key" } } }]);
    await expect(
      llmPlan({
        sourcePath: file,
        embeddingModel: "text-embedding-3-small",
        provider: "anthropic",
        apiKey: "sk-bad",
      }),
    ).rejects.toThrow(/invalid api key/);
  });

  it("rejects metadata with non-string values via schema", async () => {
    mockFetch([
      {
        body: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...VALID_PLAN, metadata: { n: 42 } }),
            },
          ],
        },
      },
      { body: { content: [{ type: "text", text: JSON.stringify(VALID_PLAN) }] } },
    ]);
    const plan = await llmPlan({
      sourcePath: file,
      embeddingModel: "text-embedding-3-small",
      provider: "anthropic",
      apiKey: "sk-ant",
    });
    expect(plan.metadata).toEqual({ doc_type: "test" });
  });
});

describe("llmPlan via OpenAI", () => {
  it("posts to /v1/chat/completions and extracts choices[0]", async () => {
    mockFetch((url, init) => {
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-oa-test");
      return {
        body: { choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }] },
      };
    });
    const plan = await llmPlan({
      sourcePath: file,
      embeddingModel: "text-embedding-3-small",
      provider: "openai",
      apiKey: "sk-oa-test",
    });
    expect(plan.splitter).toBe("markdown");
  });
});

describe("llmPlan via Google", () => {
  it("posts to generateContent and reads candidates[0].content.parts[0].text", async () => {
    mockFetch((url) => {
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain(":generateContent");
      expect(url).toContain("key=g-test");
      return {
        body: {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(VALID_PLAN) }],
              },
            },
          ],
        },
      };
    });
    const plan = await llmPlan({
      sourcePath: file,
      embeddingModel: "text-embedding-3-small",
      provider: "google",
      apiKey: "g-test",
    });
    expect(plan.splitter).toBe("markdown");
  });
});

describe("resolvePlannerProvider", () => {
  const ENV_KEYS = [
    "AUTO_EMBED_PLAN_PROVIDER",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("prefers explicit AUTO_EMBED_PLAN_PROVIDER", () => {
    process.env.AUTO_EMBED_PLAN_PROVIDER = "openai";
    process.env.ANTHROPIC_API_KEY = "ant";
    process.env.OPENAI_API_KEY = "openai-key";
    const r = resolvePlannerProvider();
    expect(r.provider).toBe("openai");
    expect(r.apiKey).toBe("openai-key");
  });

  it("falls back to anthropic > openai > google", () => {
    process.env.OPENAI_API_KEY = "o";
    process.env.GOOGLE_API_KEY = "g";
    expect(resolvePlannerProvider().provider).toBe("openai");
    process.env.ANTHROPIC_API_KEY = "a";
    expect(resolvePlannerProvider().provider).toBe("anthropic");
  });

  it("throws when no keys are present", () => {
    expect(() => resolvePlannerProvider()).toThrow(/No LLM provider key/);
  });

  it("throws when the explicit provider's key is missing", () => {
    process.env.AUTO_EMBED_PLAN_PROVIDER = "anthropic";
    expect(() => resolvePlannerProvider()).toThrow(/API key is not set/);
  });
});

describe("loadPlanFile", () => {
  it("loads and validates a saved plan", async () => {
    const planPath = path.join(tmp, "plan.json");
    await fsp.writeFile(
      planPath,
      JSON.stringify({
        version: 1,
        splitter: "recursive",
        chunkSize: 500,
        overlap: 50,
        metadata: {},
        collection: "saved",
        embeddingModel: "voyage-3",
      }),
    );
    const plan = await loadPlanFile(planPath);
    expect(plan.collection).toBe("saved");
    expect(plan.splitter).toBe("recursive");
  });

  it("throws UserConfig on missing file", async () => {
    await expect(loadPlanFile(path.join(tmp, "nope.json"))).rejects.toThrow(/not found/);
  });

  it("throws UserConfig on malformed JSON", async () => {
    const planPath = path.join(tmp, "bad.json");
    await fsp.writeFile(planPath, "not json");
    await expect(loadPlanFile(planPath)).rejects.toThrow(/not valid JSON/);
  });

  it("throws UserConfig on schema-invalid plan", async () => {
    const planPath = path.join(tmp, "bad.json");
    await fsp.writeFile(planPath, JSON.stringify({ version: 2 }));
    await expect(loadPlanFile(planPath)).rejects.toThrow(/schema/);
  });
});
