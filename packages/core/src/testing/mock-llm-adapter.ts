/**
 * Test double for LlmPort — eliminates vi.mock("ai") module-system hooks in tests.
 * Pass structured fixture for generateStructured tests, text fixture for generateText tests.
 *
 * @example
 * ```typescript
 * // intent-parser test
 * const mock = new MockLlmAdapter({ resourceType: RESOURCE_TYPES.S3_BUCKET });
 * const node = createIntentParserNode({ llmClient: mock });
 *
 * // plan-generator test
 * const mock = new MockLlmAdapter(undefined, '{"BucketName":"my-bucket"}');
 * const node = createPlanGeneratorNode({ llmClient: mock });
 * ```
 */

import type { ZodSchema } from "zod";
import type { Result } from "../types/result.js";
import { LlmError } from "../errors.js";
import type { LlmPort } from "../ports/llm-port.js";

export class MockLlmAdapter implements LlmPort {
  constructor(
    private readonly structuredResponse: unknown = undefined,
    private readonly textResponse: string = "",
    private readonly shouldFail: boolean = false,
    private readonly failMessage: string = "Mock LLM failure",
  ) {}

  async generateStructured<T>(
    _prompt: string,
    _schema: ZodSchema<T>,
  ): Promise<Result<T, LlmError>> {
    if (this.shouldFail) {
      return [new LlmError(this.failMessage), null] as const;
    }
    return [null, this.structuredResponse as T] as const;
  }

  async generateText(_prompt: string): Promise<Result<string, LlmError>> {
    if (this.shouldFail) {
      return [new LlmError(this.failMessage), null] as const;
    }
    return [null, this.textResponse] as const;
  }
}
