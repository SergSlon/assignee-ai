/**
 * RecordingLlmAdapter — pass-through LlmPort that records every call.
 *
 * Lifted from `apps/cli/src/utils/recorder/llm-recorder.ts` in Story 50-4
 * Wave 5 Pass A.
 */
import type { ZodSchema } from "zod";
import type { LlmPort } from "../../ports/llm-port.js";
import type { Result } from "../../types/result.js";
import type { LlmError } from "../../errors.js";
import { UNKNOWN_FALLBACK } from "../../config/cfn-keys/defaults.js";
import type { RecordingInterceptor } from "./session.js";

/**
 * Wraps an LlmPort to record all generateText and generateStructured calls.
 * Pass-through: the inner adapter handles all actual LLM communication.
 */
export class RecordingLlmAdapter implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly recorder: RecordingInterceptor,
    private readonly modelName: string = UNKNOWN_FALLBACK,
  ) {}

  async generateText(
    prompt: string,
    options?: { maxTokens?: number },
  ): Promise<Result<string, LlmError>> {
    const start = Date.now();
    const result = await this.inner.generateText(prompt, options);
    const [err, text] = result;
    this.recorder.recordCall({
      type: "llm",
      method: "generateText",
      prompt,
      ...(err ? { error: String(err) } : { response: text }),
      model: this.modelName,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
    return result;
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: { maxTokens?: number },
  ): Promise<Result<T, LlmError>> {
    const start = Date.now();
    const result = await this.inner.generateStructured(prompt, schema, options);
    const [err, output] = result;
    this.recorder.recordCall({
      type: "llm",
      method: "generateStructured",
      prompt,
      ...(err ? { error: String(err) } : { response: output }),
      model: this.modelName,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
    return result;
  }
}
