/**
 * Epic 94 Wave 1 fixer e94.R2 — intent-parser pattern-detect name
 * preservation.
 *
 * Closes A-02 (HIGH regression): Epic 92 Wave 2.a introduced the
 * asserted-value pre-extraction call inside the pattern-detect branch
 * but passed an empty string for `resourceType`, which caused
 * `resolveNameField` to return `null` and silently drop the user's
 * `named <x>` token on every compound-pattern intent. This test
 * verifies that when the intent triggers `LAMBDA_WITH_EXEC_ROLE`, the
 * user-specified `FunctionName` is preserved in both
 * `elicitedOptions` and `presetFields`, and that unmapped-primary
 * patterns still parse cleanly.
 */

import { describe, it, expect, vi } from "vitest";
import { PatternId, RESOURCE_TYPES, defaultPatternRegistry } from "@/index.js";
import { MockLlmAdapter } from "@/testing/index.js";
import type { AgentState } from "../../graph-state.js";
import { createIntentParserNode } from "../intent-parser.js";

// Suppress logger output.
vi.mock("../../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    INTENT_PARSED: "intent_parsed",
  },
}));

describe("intentParserNode — compound-pattern name preservation (A-02)", () => {
  it("preserves user-specified FunctionName when LAMBDA_WITH_EXEC_ROLE pattern matches", async () => {
    // Mock LLM must be present (node factory requires llmClient), but
    // must never be called because pattern-detect short-circuits.
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a lambda named my-alpha-fn",
    } as AgentState;
    const result = await node(state);

    // Pattern detection fired — no LLM route, no error.
    expect(result.executionStatus).toBeUndefined();
    expect(result.resourcePattern?.patternId).toBe(
      PatternId.LAMBDA_WITH_EXEC_ROLE,
    );

    // The asserted FunctionName landed in elicitedOptions AND presetFields.
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ FunctionName: "my-alpha-fn" }),
    );
    expect(result.presetFields).toEqual(
      expect.objectContaining({ FunctionName: "my-alpha-fn" }),
    );
  });

  it("preserves FunctionName across all Lambda-primary compound patterns", async () => {
    // Each of these patterns resolves its primary resource to
    // AWS::Lambda::Function, so the `named <x>` token should map to
    // FunctionName in every case.
    const lambdaPrimaryCases: Array<{ intent: string; patternId: string }> = [
      {
        intent: "Create a lambda named my-alpha-fn",
        patternId: PatternId.LAMBDA_WITH_EXEC_ROLE,
      },
      {
        intent: "Create a serverless api named my-alpha-fn",
        patternId: PatternId.SERVERLESS_API,
      },
      {
        intent: "Create a scheduled lambda named my-alpha-fn",
        patternId: PatternId.SCHEDULED_LAMBDA,
      },
    ];

    for (const { intent, patternId } of lambdaPrimaryCases) {
      const mock = new MockLlmAdapter({
        resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      });
      const node = createIntentParserNode({ llmClient: mock });

      const result = await node({ userIntent: intent } as AgentState);

      // Sanity — the pattern registry is set up so these intents hit
      // the expected pattern (guards against accidental keyword drift).
      const detected = defaultPatternRegistry.detect(intent);
      expect(detected?.patternId).toBe(patternId);

      expect(result.resourcePattern?.patternId).toBe(patternId);
      expect(result.elicitedOptions).toEqual(
        expect.objectContaining({ FunctionName: "my-alpha-fn" }),
      );
    }
  });

  it("still parses cleanly for patterns without a primary name-bearing resource (EFS_WITH_VPC)", async () => {
    // Guards against the helper throwing or the branch failing when
    // the pattern maps to `null` (no single name field). No
    // FunctionName assertion — just ensure no error.
    //
    // Epic 96 W3.N3 (C-02): bare "create an efs file system" now
    // routes to the AWS::EFS::FileSystem singleton (NOT efs-with-vpc)
    // — firing the full 10-resource compound on a bare intent was
    // the Epic 95 C-02 finding. To still exercise the compound path
    // (which is what this test is guarding against a throw), use the
    // explicit VPC-qualified intent that survives the singleton-
    // override negative-phrase filter.
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const result = await node({
      userIntent: "Create an efs file system with a new VPC",
    } as AgentState);

    expect(result.executionStatus).toBeUndefined();
    expect(result.resourcePattern?.patternId).toBe(PatternId.EFS_WITH_VPC);
    // No FunctionName / BucketName / etc. keys expected.
    expect(result.elicitedOptions?.["FunctionName"]).toBeUndefined();
    expect(result.elicitedOptions?.["BucketName"]).toBeUndefined();
  });

  it("still parses cleanly when the user does not specify a name (no-op)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const result = await node({
      userIntent: "Create a lambda",
    } as AgentState);

    expect(result.executionStatus).toBeUndefined();
    expect(result.resourcePattern?.patternId).toBe(
      PatternId.LAMBDA_WITH_EXEC_ROLE,
    );
    // No `named <x>` token → no FunctionName key set.
    expect(result.elicitedOptions?.["FunctionName"]).toBeUndefined();
  });

  it("does NOT invoke the LLM when a pattern matches (pattern-detect short-circuit preserved)", async () => {
    // Regression guard: the bug-fix must not re-route pattern-matched
    // intents through the classifier. A throwing mock confirms the LLM
    // path was not entered.
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    });
    const generateStructuredSpy = vi.spyOn(mock, "generateStructured");
    const node = createIntentParserNode({ llmClient: mock });

    await node({
      userIntent: "Create a lambda named my-alpha-fn",
    } as AgentState);

    expect(generateStructuredSpy).not.toHaveBeenCalled();
  });
});
