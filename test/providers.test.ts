import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCohereProvider } from "../src/providers/cohere.js";
import { createGoogleProvider } from "../src/providers/google.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createVoyageProvider } from "../src/providers/voyage.js";
import { resolveProvider } from "../src/providers/index.js";

const originalFetch = globalThis.fetch;

interface MockResponse {
  status?: number;
  body: unknown;
}

function mockFetch(handler: (url: string, init: RequestInit | undefined) => MockResponse | Promise<MockResponse>) {
  const fn = vi.fn(async (input: URL | Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = await handler(url, init);
    const status = r.status ?? 200;
    return new Response(JSON.stringify(r.body), {
      status,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("openai", () => {
  it("posts to /embeddings with the model and returns ordered vectors", async () => {
    const fn = mockFetch((url, init) => {
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-secret-key");
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("text-embedding-3-small");
      expect(body.input).toEqual(["hello", "world"]);
      return {
        body: {
          data: [
            { embedding: [0.2, 0.3], index: 1 },
            { embedding: [0.0, 0.1], index: 0 },
          ],
          usage: { prompt_tokens: 5, total_tokens: 7 },
        },
      };
    });
    const provider = createOpenAIProvider({ apiKey: "sk-secret-key" });
    const result = await provider.embed(["hello", "world"]);
    expect(result.vectors).toEqual([[0.0, 0.1], [0.2, 0.3]]);
    expect(result.usage).toEqual({ promptTokens: 5, totalTokens: 7 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flags 429 errors as retryable and 400 as non-retryable", async () => {
    mockFetch(() => ({ status: 429, body: { error: { message: "rate limited" } } }));
    const provider = createOpenAIProvider({ apiKey: "sk" });
    await expect(provider.embed(["x"])).rejects.toMatchObject({
      message: /rate limited/,
      retryable: true,
      status: 429,
    });
    mockFetch(() => ({ status: 400, body: { error: { message: "bad input" } } }));
    await expect(provider.embed(["x"])).rejects.toMatchObject({
      message: /bad input/,
      retryable: false,
      status: 400,
    });
  });

  it("never leaks the API key in error messages", async () => {
    mockFetch(() => ({ status: 401, body: { error: { message: "unauthorized" } } }));
    const provider = createOpenAIProvider({ apiKey: "sk-VERY-SECRET-KEY" });
    try {
      await provider.embed(["x"]);
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("VERY-SECRET-KEY");
      expect(msg).not.toContain("sk-VERY");
    }
  });

  it("throws AutoEmbedError when API key missing", () => {
    expect(() => createOpenAIProvider({ apiKey: "" })).toThrow(/API key is required/);
  });

  it("returns the canonical model dimension", () => {
    const provider = createOpenAIProvider({ apiKey: "sk" });
    expect(provider.dimensions("text-embedding-3-small")).toBe(1536);
  });

  it("returns empty vectors for empty input without calling the API", async () => {
    const fn = mockFetch(() => ({ body: {} }));
    const provider = createOpenAIProvider({ apiKey: "sk" });
    const r = await provider.embed([]);
    expect(r.vectors).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("google", () => {
  it("posts to batchEmbedContents with text parts", async () => {
    const fn = mockFetch((url, init) => {
      expect(url).toContain("https://generativelanguage.googleapis.com/v1beta/models/");
      expect(url).toContain(":batchEmbedContents");
      expect(url).toContain("key=key-secret");
      const body = JSON.parse(init?.body as string);
      expect(body.requests).toHaveLength(2);
      expect(body.requests[0].content.parts[0].text).toBe("a");
      return {
        body: {
          embeddings: [{ values: [1, 2] }, { values: [3, 4] }],
        },
      };
    });
    const provider = createGoogleProvider({ apiKey: "key-secret" });
    const r = await provider.embed(["a", "b"]);
    expect(r.vectors).toEqual([[1, 2], [3, 4]]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rejects when count of embeddings != count of texts", async () => {
    mockFetch(() => ({ body: { embeddings: [{ values: [1, 2] }] } }));
    const provider = createGoogleProvider({ apiKey: "k" });
    await expect(provider.embed(["a", "b"])).rejects.toThrow(/expected 2 embeddings/);
  });
});

describe("voyage", () => {
  it("posts to /v1/embeddings and sorts by index", async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("voyage-3");
      return {
        body: {
          data: [
            { embedding: [0.9], index: 2 },
            { embedding: [0.1], index: 0 },
            { embedding: [0.5], index: 1 },
          ],
        },
      };
    });
    const provider = createVoyageProvider({ apiKey: "vk" });
    const r = await provider.embed(["x", "y", "z"]);
    expect(r.vectors).toEqual([[0.1], [0.5], [0.9]]);
  });
});

describe("cohere", () => {
  it("posts to /v2/embed and reads embeddings.float", async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("embed-english-v3.0");
      expect(body.embedding_types).toEqual(["float"]);
      return {
        body: {
          embeddings: { float: [[1, 0], [0, 1]] },
          meta: { billed_units: { input_tokens: 42 } },
        },
      };
    });
    const provider = createCohereProvider({ apiKey: "ck" });
    const r = await provider.embed(["a", "b"]);
    expect(r.vectors).toEqual([[1, 0], [0, 1]]);
    expect(r.usage.totalTokens).toBe(42);
  });
});

describe("resolveProvider registry", () => {
  beforeEach(() => {
    // ensure global env doesn't break tests
    delete process.env.OPENAI_API_KEY;
  });

  it("returns a provider for each cloud name", async () => {
    expect((await resolveProvider({ provider: "openai", apiKey: "k" })).name).toBe("openai");
    expect((await resolveProvider({ provider: "google", apiKey: "k" })).name).toBe("google");
    expect((await resolveProvider({ provider: "voyage", apiKey: "k" })).name).toBe("voyage");
    expect((await resolveProvider({ provider: "cohere", apiKey: "k" })).name).toBe("cohere");
  });
});
