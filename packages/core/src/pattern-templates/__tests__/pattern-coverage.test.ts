/**
 * Guard 3 (CP-4 / PH1-D-2) — Pattern-coverage retention test.
 *
 * Fixture lists canonical AWS service compositions with sample intent
 * strings and asserts `defaultPatternRegistry.detect(intent)` returns
 * the expected `patternId`.
 *
 * Co-owned with CP-1 and CP-2 — those stories add their respective
 * fixtures to this same file. CP-4 ships the file scaffold + Lambda-bearing
 * fixtures. CP-1/CP-2 land their fixture entries in their own commits.
 *
 * Ensures that keyword-routing changes, pattern reorderings, or new
 * pattern registrations do NOT silently break existing intent-to-pattern
 * mappings. Any regression is caught at CI time with a descriptive
 * message naming the intent that broke.
 */

import { describe, it, expect } from "vitest";
import { defaultPatternRegistry } from "../index.js";
import { PatternId } from "../pattern-ids.js";

/** Fixture: intent string → expected patternId */
interface CoverageFixture {
  intent: string;
  expectedPatternId: string;
  description?: string;
}

/**
 * Lambda-bearing fixtures (CP-4 canonical set — Variations A, B, C, D).
 * CP-1/CP-2 append their own entries to this array in separate commits.
 */
const LAMBDA_FIXTURES: CoverageFixture[] = [
  // Variation A — lambda-with-exec-role
  {
    intent: "Create a Lambda function",
    expectedPatternId: PatternId.LAMBDA_WITH_EXEC_ROLE,
    description: "Variation A: bare Lambda intent → lambda-with-exec-role",
  },
  {
    intent: "create a lambda function for background processing",
    expectedPatternId: PatternId.LAMBDA_WITH_EXEC_ROLE,
    description: "Variation A: explicit 'lambda function' phrase",
  },
  {
    intent: "deploy a lambda for image resizing",
    expectedPatternId: PatternId.LAMBDA_WITH_EXEC_ROLE,
    description: "Variation A: deploy variant",
  },
  // Variation B — serverless-api
  {
    intent: "Serverless API with Lambda",
    expectedPatternId: PatternId.SERVERLESS_API,
    description: "Variation B: serverless API intent → serverless-api",
  },
  {
    intent: "create a serverless api",
    expectedPatternId: PatternId.SERVERLESS_API,
    description: "Variation B: plain serverless api",
  },
  {
    intent: "build a rest api with lambda",
    expectedPatternId: PatternId.SERVERLESS_API,
    description: "Variation B: REST API with Lambda",
  },
  // Variation C — scheduled-lambda
  {
    intent: "Scheduled Lambda every 5 minutes",
    expectedPatternId: PatternId.SCHEDULED_LAMBDA,
    description: "Variation C: scheduled lambda intent → scheduled-lambda",
  },
  {
    intent: "create a scheduled lambda for nightly cleanup",
    expectedPatternId: PatternId.SCHEDULED_LAMBDA,
    description: "Variation C: scheduled lambda with cron description",
  },
  {
    intent: "cron lambda every hour",
    expectedPatternId: PatternId.SCHEDULED_LAMBDA,
    description: "Variation C: cron lambda phrasing",
  },
  // Variation D — message-processing (story CP-4 canonical probe)
  {
    intent: "Lambda that processes SQS messages",
    expectedPatternId: PatternId.MESSAGE_PROCESSING,
    description:
      "Variation D: SQS lambda intent → message-processing (canonical reference)",
  },
  {
    intent: "create sqs lambda processor",
    expectedPatternId: PatternId.MESSAGE_PROCESSING,
    description: "Variation D: SQS Lambda processor",
  },
  {
    intent: "async message processing pipeline for orders",
    expectedPatternId: PatternId.MESSAGE_PROCESSING,
    description: "Variation D: async message processing pipeline",
  },
  // WebSocket API (also Lambda-bearing)
  {
    intent: "WebSocket API for realtime chat",
    expectedPatternId: PatternId.WEBSOCKET_API,
    description: "WebSocket API pattern detection",
  },
  {
    intent: "create a websocket api",
    expectedPatternId: PatternId.WEBSOCKET_API,
    description: "WebSocket API direct phrasing",
  },
];

describe("Guard 3 — Pattern coverage retention (CP-4 Lambda fixtures)", () => {
  for (const fixture of LAMBDA_FIXTURES) {
    it(`"${fixture.intent}" → "${fixture.expectedPatternId}"${fixture.description ? ` (${fixture.description})` : ""}`, () => {
      const detected = defaultPatternRegistry.detect(fixture.intent);
      expect(
        detected?.patternId,
        `Intent "${fixture.intent}" did not route to "${fixture.expectedPatternId}". ` +
          `Got: ${detected?.patternId ?? "null"}. ` +
          `Check pattern keyword lists and registration order in index.ts.`,
      ).toBe(fixture.expectedPatternId);
    });
  }

  it("non-Lambda, non-pattern intents still return null (baseline anti-regression)", () => {
    const noMatchIntents = [
      "create an S3 bucket",
      "add an IAM role",
      "provision an EC2 instance",
      "set up a KMS key",
    ];
    for (const intent of noMatchIntents) {
      expect(
        defaultPatternRegistry.detect(intent),
        `Expected null for "${intent}" but got a pattern`,
      ).toBeNull();
    }
  });

  it("all Lambda-bearing pattern IDs are registered in the default registry", () => {
    const lambdaPatternIds = [
      PatternId.LAMBDA_WITH_EXEC_ROLE,
      PatternId.SERVERLESS_API,
      PatternId.SCHEDULED_LAMBDA,
      PatternId.MESSAGE_PROCESSING,
      PatternId.WEBSOCKET_API,
    ];
    for (const patternId of lambdaPatternIds) {
      expect(
        defaultPatternRegistry.has(patternId),
        `Pattern "${patternId}" is not registered in defaultPatternRegistry`,
      ).toBe(true);
    }
  });
});
