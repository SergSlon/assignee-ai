/**
 * Epic 94 Wave 2 fixer e94.N5 — intent-parser pattern-precision coverage.
 *
 * Closes findings:
 *   - C-07: literal pattern-ID strings in user intent must route to the
 *     matching compound pattern by ID, bypassing negativeKeywords.
 *   - C-08: "Create an EFS mount target" must produce a singleton
 *     AWS::EFS::MountTarget, not the efs-with-vpc compound.
 *   - C-09: "Create an HTTP API Gateway" must produce a singleton
 *     AWS::ApiGatewayV2::Api, not the serverless-api compound.
 *   - D-05: "Create a logs group foo with 14 days retention" extracts
 *     RetentionInDays=14 onto elicitedOptions for the plan-stage
 *     comparator to raise to 30.
 *
 * Locks the new contract:
 *   1. Singleton overrides fire BEFORE compound detection and pin the
 *      resourceType to the explicit singleton type.
 *   2. Pattern-ID literal lookup fires BEFORE registry.detect() and
 *      skips negativeKeywords checks.
 *   3. Retention extraction writes an integer to elicitedOptions.
 */

import { describe, it, expect, vi } from "vitest";
import { PatternId, RESOURCE_TYPES, defaultPatternRegistry } from "@/index.js";
import { MockLlmAdapter } from "@/testing/index.js";
import type { AgentState } from "../../graph-state.js";
import {
  createIntentParserNode,
  extractAssertedValues,
} from "../intent-parser.js";
import {
  resolveCompoundPatternIdLiteral,
  resolveSingletonOverride,
} from "../../../intent/compound-keywords.js";

// Suppress logger output in the singleton-override path.
vi.mock("../../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    INTENT_PARSED: "intent_parsed",
  },
}));

describe("intent-parser pattern precision (e94.N5)", () => {
  // -------------------------------------------------------------------
  // C-07 — pattern-ID literal lookup
  // -------------------------------------------------------------------
  describe("C-07: pattern-ID literal exact match", () => {
    const literals: Array<{ literal: string; patternId: string }> = [
      { literal: "static-website", patternId: PatternId.STATIC_WEBSITE },
      { literal: "serverless-api", patternId: PatternId.SERVERLESS_API },
      { literal: "scheduled-lambda", patternId: PatternId.SCHEDULED_LAMBDA },
      { literal: "websocket-api", patternId: PatternId.WEBSOCKET_API },
      { literal: "efs-with-vpc", patternId: PatternId.EFS_WITH_VPC },
      {
        literal: "lambda-with-exec-role",
        patternId: PatternId.LAMBDA_WITH_EXEC_ROLE,
      },
    ];

    for (const { literal, patternId } of literals) {
      it(`resolves "${literal}" in intent to ${patternId}`, () => {
        const intent = `Create a ${literal} pattern`;
        expect(resolveCompoundPatternIdLiteral(intent)).toBe(patternId);
      });

      it(`routes "Create a ${literal} pattern" to the ${patternId} compound in the node`, async () => {
        const mock = new MockLlmAdapter({
          resourceType: RESOURCE_TYPES.S3_BUCKET,
        });
        const node = createIntentParserNode({ llmClient: mock });
        const state = {
          userIntent: `Create a ${literal} pattern`,
        } as AgentState;
        const result = await node(state);
        // Pattern dispatch short-circuits — the LLM must not have been
        // called and the result carries the pattern, not a resourceType.
        expect(result.executionStatus).toBeUndefined();
        expect(result.resourcePattern?.patternId).toBe(patternId);
      });
    }

    it("returns null when no pattern-ID literal is present", () => {
      expect(
        resolveCompoundPatternIdLiteral("Create an S3 bucket named foo"),
      ).toBeNull();
    });

    it("is token-bounded — embedded substrings do NOT match", () => {
      // `my-static-website-module` should NOT match `static-website`
      // because the literal is surrounded by other hyphenated tokens.
      expect(
        resolveCompoundPatternIdLiteral(
          "deploy my-static-website-module to us-east-1",
        ),
      ).toBeNull();
    });

    it("is case-insensitive", () => {
      expect(
        resolveCompoundPatternIdLiteral("Create a STATIC-WEBSITE pattern"),
      ).toBe(PatternId.STATIC_WEBSITE);
    });

    it("bypasses negativeKeywords — `standalone serverless-api` still routes to the compound", async () => {
      // `serverless-api` carries a `standalone` negativeKeyword in the
      // registry. The literal fast-path ignores that filter.
      const registryHit = defaultPatternRegistry.detect(
        "Create a standalone serverless-api",
      );
      expect(registryHit).toBeNull();
      const literalHit = resolveCompoundPatternIdLiteral(
        "Create a standalone serverless-api",
      );
      expect(literalHit).toBe(PatternId.SERVERLESS_API);
    });
  });

  // -------------------------------------------------------------------
  // C-08 — singleton EFS MountTarget
  // -------------------------------------------------------------------
  describe("C-08: `Create an EFS mount target` → singleton MountTarget", () => {
    it("resolveSingletonOverride picks EFS::MountTarget for the phrase", () => {
      expect(resolveSingletonOverride("Create an EFS mount target")).toBe(
        "AWS::EFS::MountTarget",
      );
    });

    it("matches hyphenated and compact forms", () => {
      expect(resolveSingletonOverride("Create an EFS mount-target")).toBe(
        "AWS::EFS::MountTarget",
      );
      expect(resolveSingletonOverride("Create an EFS MountTarget")).toBe(
        "AWS::EFS::MountTarget",
      );
    });

    it("intent-parser node returns the singleton type, NOT the efs-with-vpc compound", async () => {
      // MockLlm set to a different type to prove the override — not the
      // LLM — made the decision.
      const mock = new MockLlmAdapter({
        resourceType: RESOURCE_TYPES.S3_BUCKET,
      });
      const node = createIntentParserNode({ llmClient: mock });
      const state = {
        userIntent: "Create an EFS mount target",
      } as AgentState;
      const result = await node(state);
      expect(result.executionStatus).toBeUndefined();
      expect(result.resourceType).toBe("AWS::EFS::MountTarget");
      // The singleton path must NOT set a resourcePattern — compound
      // dispatch is bypassed.
      expect(result.resourcePattern).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // C-02 (Epic 96 W3.N3) — singleton EFS FileSystem
  // -------------------------------------------------------------------
  describe("C-02: `Create an EFS file system` → singleton AWS::EFS::FileSystem", () => {
    it("resolveSingletonOverride picks EFS::FileSystem for plain phrasing", () => {
      expect(resolveSingletonOverride("Create an EFS file system")).toBe(
        "AWS::EFS::FileSystem",
      );
    });

    it("matches filesystem / file-system / FS variants (case-insensitive)", () => {
      expect(resolveSingletonOverride("Create an EFS filesystem")).toBe(
        "AWS::EFS::FileSystem",
      );
      expect(resolveSingletonOverride("create an efs file-system")).toBe(
        "AWS::EFS::FileSystem",
      );
      expect(resolveSingletonOverride("Create an EFS FS")).toBe(
        "AWS::EFS::FileSystem",
      );
      expect(resolveSingletonOverride("Provision elastic file system")).toBe(
        "AWS::EFS::FileSystem",
      );
    });

    it("VPC qualifiers DISQUALIFY the singleton override (compound routing preserved)", () => {
      // Every negative-phrase form must flip the cue to null so the
      // efs-with-vpc compound takes the intent.
      for (const vpcPhrase of [
        "with vpc",
        "with a vpc",
        "and vpc",
        "and a vpc",
        "and new vpc",
        "and a new vpc",
        "in vpc",
        "in a vpc",
        "in new vpc",
        "in a new vpc",
        "plus vpc",
        "plus a vpc",
      ]) {
        const intent = `Create an EFS file system ${vpcPhrase}`;
        expect(resolveSingletonOverride(intent)).toBeNull();
      }
    });

    it("does NOT match bare 'efs' alone — must name the concrete resource", () => {
      // The cue is intentionally scoped to phrases that name EFS as a
      // filesystem / FS — a generic "create efs" is ambiguous and
      // falls through to the compound, which is the safe default for
      // beginners who need the full scaffolding.
      expect(resolveSingletonOverride("Create an EFS")).toBeNull();
      expect(resolveSingletonOverride("Please set up efs")).toBeNull();
    });

    it("mount-target cue still wins over filesystem cue (C-08 ordering preserved)", () => {
      // 'EFS mount target' mentions "efs" but the C-08 cue appears
      // first in the array and its phrases match — so the override
      // resolves to AWS::EFS::MountTarget, not AWS::EFS::FileSystem.
      expect(resolveSingletonOverride("Create an EFS mount target")).toBe(
        "AWS::EFS::MountTarget",
      );
    });

    it("intent-parser node returns AWS::EFS::FileSystem, NOT the efs-with-vpc compound", async () => {
      const mock = new MockLlmAdapter({
        resourceType: RESOURCE_TYPES.S3_BUCKET,
      });
      const node = createIntentParserNode({ llmClient: mock });
      const state = {
        userIntent: "Create an EFS file system",
      } as AgentState;
      const result = await node(state);
      expect(result.executionStatus).toBeUndefined();
      expect(result.resourceType).toBe("AWS::EFS::FileSystem");
      // Compound dispatch must be bypassed.
      expect(result.resourcePattern).toBeUndefined();
    });

    it("intent-parser node preserves compound routing for `EFS file system with a new VPC`", async () => {
      const mock = new MockLlmAdapter({
        resourceType: RESOURCE_TYPES.S3_BUCKET,
      });
      const node = createIntentParserNode({ llmClient: mock });
      const state = {
        userIntent: "Create an EFS file system with a new VPC",
      } as AgentState;
      const result = await node(state);
      expect(result.executionStatus).toBeUndefined();
      // Compound path: resourcePattern is populated with the full
      // ArchitecturePattern object — assert on .patternId.
      expect(result.resourcePattern?.patternId).toBe(PatternId.EFS_WITH_VPC);
    });
  });

  // -------------------------------------------------------------------
  // C-09 — singleton HTTP API Gateway
  // -------------------------------------------------------------------
  describe("C-09: `Create an HTTP API Gateway` → singleton ApiGatewayV2::Api", () => {
    it("resolveSingletonOverride picks ApiGatewayV2::Api for the phrase", () => {
      expect(resolveSingletonOverride("Create an HTTP API Gateway")).toBe(
        "AWS::ApiGatewayV2::Api",
      );
    });

    it("WebSocket context DISQUALIFIES the HTTP API override", () => {
      // User asked for a WebSocket API Gateway — that's a different
      // resource family (PROTOCOL=WEBSOCKET on the same type, but
      // semantically different). Override must skip so the registry
      // routes to the websocket-api pattern.
      expect(
        resolveSingletonOverride("Create a WebSocket HTTP API Gateway"),
      ).toBeNull();
    });

    it("intent-parser node returns ApiGatewayV2::Api, NOT the serverless-api compound", async () => {
      const mock = new MockLlmAdapter({
        resourceType: RESOURCE_TYPES.S3_BUCKET,
      });
      const node = createIntentParserNode({ llmClient: mock });
      const state = {
        userIntent: "Create an HTTP API Gateway",
      } as AgentState;
      const result = await node(state);
      expect(result.executionStatus).toBeUndefined();
      expect(result.resourceType).toBe("AWS::ApiGatewayV2::Api");
      expect(result.resourcePattern).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // D-05 — retention extraction
  // -------------------------------------------------------------------
  describe("D-05: RetentionInDays extraction for LogGroup intents", () => {
    it("extracts RetentionInDays=14 from natural-language clause", () => {
      const { elicited } = extractAssertedValues(
        "Create a logs group foo with 14 days retention",
        RESOURCE_TYPES.LOGS_LOG_GROUP,
      );
      expect(elicited["RetentionInDays"]).toBe(14);
    });

    it("accepts `retention of 7 days` alternate phrasing", () => {
      const { elicited } = extractAssertedValues(
        "Create a logs group with retention of 7 days",
        RESOURCE_TYPES.LOGS_LOG_GROUP,
      );
      expect(elicited["RetentionInDays"]).toBe(7);
    });

    it("does not extract retention for non-LogGroup resource types", () => {
      const { elicited } = extractAssertedValues(
        "Create an S3 bucket with 14 days retention",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(elicited["RetentionInDays"]).toBeUndefined();
    });

    it("does not extract when `retention` keyword is absent", () => {
      const { elicited } = extractAssertedValues(
        "Create a logs group",
        RESOURCE_TYPES.LOGS_LOG_GROUP,
      );
      expect(elicited["RetentionInDays"]).toBeUndefined();
    });

    it("rejects zero / negative retention (guard against malformed clauses)", () => {
      const { elicited } = extractAssertedValues(
        "Create a logs group with 0 days retention",
        RESOURCE_TYPES.LOGS_LOG_GROUP,
      );
      expect(elicited["RetentionInDays"]).toBeUndefined();
    });
  });
});
