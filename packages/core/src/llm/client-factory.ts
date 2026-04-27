/**
 * Per-provider Vercel AI SDK LanguageModel factory.
 *
 * Lifted from `apps/cli/src/services/llm-adapter/client-factory.ts` in
 * Story 50-4 Wave 5 Pass B. SRP: instantiate the right `@ai-sdk/*`
 * client for the parsed model. Lazy-loads each provider so unused SDKs
 * are not pulled into the runtime bundle.
 */
import type { LanguageModel } from "ai";
import { LlmError } from "../errors.js";
import { AWS_REGION } from "../config/constants/aws.js";
import { EnvVar } from "../constants/env-vars.js";
import { LlmProvider } from "../constants/llm-providers.js";
import { assertValidUrl } from "../utils/url-validator.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";
import type { ParsedModel } from "./model-parser.js";

/**
 * Create a Vercel AI SDK LanguageModel for the given parsed model.
 * Dynamically imports the provider package to avoid loading unused SDKs.
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped lookup. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 */
export async function createLanguageModel(
  parsed: ParsedModel,
  config?: ConfigPort,
): Promise<LanguageModel> {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  switch (parsed.provider) {
    case LlmProvider.ANTHROPIC: {
      const apiKey = effectiveConfig.get("ANTHROPIC_API_KEY");
      if (!apiKey) {
        throw new LlmError(
          `ANTHROPIC_API_KEY environment variable is required for ${LlmProvider.ANTHROPIC}/ models.`,
        );
      }
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({
        apiKey,
      });
      return anthropic(parsed.modelId);
    }

    case LlmProvider.OPENAI: {
      const apiKey = effectiveConfig.get("OPENAI_API_KEY");
      if (!apiKey) {
        throw new LlmError(
          `OPENAI_API_KEY environment variable is required for ${LlmProvider.OPENAI}/ models.`,
        );
      }
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey });
      return openai(parsed.modelId);
    }

    case LlmProvider.BEDROCK: {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      const bedrock = createAmazonBedrock({
        region: AWS_REGION,
        accessKeyId: effectiveConfig.get(EnvVar.OPERATOR_ACCESS_KEY),
        secretAccessKey: effectiveConfig.get(EnvVar.OPERATOR_SECRET_KEY),
      });
      return bedrock(parsed.modelId);
    }

    case LlmProvider.OLLAMA: {
      const baseURL =
        effectiveConfig.get("OLLAMA_BASE_URL") ?? "http://localhost:11434/v1";
      // W5-03 (P007-tech → L4-S09): validate OLLAMA_BASE_URL before use.
      // localhost http is allowed (that is the standard Ollama setup).
      assertValidUrl(baseURL, "OLLAMA_BASE_URL", { allowLocalhostHttp: true });
      const { createOpenAI } = await import("@ai-sdk/openai");
      const ollama = createOpenAI({
        baseURL,
        apiKey: LlmProvider.OLLAMA, // Ollama doesn't need a real key
      });
      return ollama(parsed.modelId);
    }

    case LlmProvider.GOOGLE: {
      const apiKey = effectiveConfig.get("GOOGLE_GENERATIVE_AI_API_KEY");
      if (!apiKey) {
        throw new LlmError(
          `GOOGLE_GENERATIVE_AI_API_KEY environment variable is required for ${LlmProvider.GOOGLE}/ models.`,
        );
      }
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({
        apiKey,
      });
      return google(parsed.modelId);
    }
  }
}
