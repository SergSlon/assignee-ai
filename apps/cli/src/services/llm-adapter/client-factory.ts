/**
 * Per-provider Vercel AI SDK LanguageModel factory.
 *
 * Extracted from llm-adapter.ts (Wave 6d F5). SRP: instantiate the right
 * `@ai-sdk/*` client for the parsed model. Lazy-loads each provider so
 * unused SDKs are not pulled into the runtime bundle.
 */
import type { LanguageModel } from "ai";
import { LlmError } from "@assignee/core";
import { AWS_REGION } from "../../config/constants.js";
import { EnvVar } from "../../constants/env-vars.js";
import { LlmProvider } from "../../constants/errors.js";
import type { ParsedModel } from "./model-parser.js";

/**
 * Create a Vercel AI SDK LanguageModel for the given parsed model.
 * Dynamically imports the provider package to avoid loading unused SDKs.
 */
export async function createLanguageModel(
  parsed: ParsedModel,
): Promise<LanguageModel> {
  switch (parsed.provider) {
    case LlmProvider.ANTHROPIC: {
      if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new LlmError(
          `ANTHROPIC_API_KEY environment variable is required for ${LlmProvider.ANTHROPIC}/ models.`,
        );
      }
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({
        apiKey: process.env["ANTHROPIC_API_KEY"],
      });
      return anthropic(parsed.modelId);
    }

    case LlmProvider.OPENAI: {
      if (!process.env["OPENAI_API_KEY"]) {
        throw new LlmError(
          `OPENAI_API_KEY environment variable is required for ${LlmProvider.OPENAI}/ models.`,
        );
      }
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
      return openai(parsed.modelId);
    }

    case LlmProvider.BEDROCK: {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      const bedrock = createAmazonBedrock({
        region: AWS_REGION,
        accessKeyId: process.env[EnvVar.OPERATOR_ACCESS_KEY],
        secretAccessKey: process.env[EnvVar.OPERATOR_SECRET_KEY],
      });
      return bedrock(parsed.modelId);
    }

    case LlmProvider.OLLAMA: {
      const baseURL =
        process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1";
      const { createOpenAI } = await import("@ai-sdk/openai");
      const ollama = createOpenAI({
        baseURL,
        apiKey: LlmProvider.OLLAMA, // Ollama doesn't need a real key
      });
      return ollama(parsed.modelId);
    }

    case LlmProvider.GOOGLE: {
      if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
        throw new LlmError(
          `GOOGLE_GENERATIVE_AI_API_KEY environment variable is required for ${LlmProvider.GOOGLE}/ models.`,
        );
      }
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({
        apiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
      });
      return google(parsed.modelId);
    }
  }
}
