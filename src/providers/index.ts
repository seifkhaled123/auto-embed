import { AutoEmbedError, ExitCode } from "../errors.js";
import { EmbeddingProviderName } from "../config/schema.js";
import { EmbeddingProvider } from "./types.js";

export type { EmbeddingProvider, EmbedResult, TokenUsage } from "./types.js";

export interface ResolveProviderInput {
  provider: EmbeddingProviderName;
  apiKey: string;
}

/**
 * Lazy-load the right adapter for the requested provider. Each adapter
 * lives in its own module so the others don't get pulled into the bundle on
 * cold start.
 */
export async function resolveProvider(
  input: ResolveProviderInput,
): Promise<EmbeddingProvider> {
  switch (input.provider) {
    case "openai": {
      const { createOpenAIProvider } = await import("./openai.js");
      return createOpenAIProvider({ apiKey: input.apiKey });
    }
    case "google": {
      const { createGoogleProvider } = await import("./google.js");
      return createGoogleProvider({ apiKey: input.apiKey });
    }
    case "voyage": {
      const { createVoyageProvider } = await import("./voyage.js");
      return createVoyageProvider({ apiKey: input.apiKey });
    }
    case "cohere": {
      const { createCohereProvider } = await import("./cohere.js");
      return createCohereProvider({ apiKey: input.apiKey });
    }
    case "local": {
      const { fastembedProvider } = await import("./fastembed.js");
      return fastembedProvider;
    }
    default:
      throw new AutoEmbedError(
        `Unknown provider: ${input.provider as string}`,
        ExitCode.UserConfig,
      );
  }
}
