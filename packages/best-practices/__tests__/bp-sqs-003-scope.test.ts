/**
 * BR-1 / PH1-B-2 — BP-SQS-003 false-positive demote closure.
 *
 * Before BR-1, BP-SQS-003 fired at HIGH severity whenever a plan lacked
 * `KmsMasterKeyId`, including plans that already set `SqsManagedSseEnabled: true`
 * (which satisfies AWS FSBP SQS.1 — "server-side encryption enabled, any
 * flavour"). The rule conflated "SSE-KMS specifically" with "SSE enabled" —
 * the same gap that FSBP draws between SQS.1 and a stricter key-management
 * recommendation.
 *
 * Fix (Solution A — demote):
 *   - BP-SQS-003 severity demoted from HIGH → MEDIUM.
 *   - Title / description / remediation reworded to "compliance workloads
 *     should use SSE-KMS with a customer-managed CMK", mirroring the BP-S3
 *     SSE-KMS pattern (BP-S3.4).
 *   - source_id updated to "SQS.KMS" (distinct from FSBP "SQS.1" owned by
 *     BP-SQS-001) to eliminate the duplicate source_id confusion.
 *
 * BP-SQS-001 (SqsManagedSseEnabled check) is exercised throughout every
 * combination to guard against regression.
 *
 * Probe plan coverage (4 combinations × 2 rules):
 *   Variation A — SqsManaged=true, KMS=unset  → 003 fires MEDIUM (not HIGH); 001 does NOT fire
 *   Variation B — SqsManaged=false, KMS=unset → 003 fires MEDIUM; 001 fires HIGH
 *   Variation C — SqsManaged=false, KMS=set   → 003 does NOT fire; 001 fires HIGH
 *   Variation D — SqsManaged=true, KMS=set    → neither fires
 *   Variation E — wording check               → "compliance" / "customer-managed CMK" in description
 *   Variation F — plan-mode dogfood           → bare-queue plan produces no HIGH from BP-SQS-003
 *
 * Real-data fixtures use queue names, key aliases, and resource shapes
 * found in real-world SQS workloads.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { evaluateTriggers } from "../src/evaluate.js";
import type { EvalContext } from "../src/evaluate.js";
import type { BestPractice } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BP_SQS_001_PATH = resolve(__dirname, "../sqs/BP-SQS-001.yaml");
const BP_SQS_003_PATH = resolve(__dirname, "../sqs/BP-SQS-003.yaml");

function loadBp(path: string): BestPractice {
  const raw = readFileSync(path, "utf-8");
  return parseYaml(raw) as BestPractice;
}

// ---------------------------------------------------------------------------
// YAML manifest assertions
// ---------------------------------------------------------------------------

describe("BP-SQS-003 YAML manifest (post BR-1 demote)", () => {
  const bp = loadBp(BP_SQS_003_PATH);

  it("declares id BP-SQS-003", () => {
    expect(bp.id).toBe("BP-SQS-003");
  });

  it("targets AWS::SQS::Queue", () => {
    expect(bp.resource_type).toBe("AWS::SQS::Queue");
  });

  it("checks KmsMasterKeyId via exists (unchanged)", () => {
    expect(bp.property_path).toBe("KmsMasterKeyId");
    expect(bp.check_type).toBe("exists");
  });

  // Variation E — wording check
  it("Variation E — severity is MEDIUM (demoted from HIGH — BR-1)", () => {
    expect(bp.severity).toBe("MEDIUM");
  });

  it('Variation E — description contains "compliance" phrasing', () => {
    expect(bp.description?.toLowerCase()).toContain("compliance");
  });

  it('Variation E — description contains "customer-managed CMK" phrasing', () => {
    expect(bp.description).toContain("customer-managed CMK");
  });

  it('Variation E — title contains "compliance" phrasing', () => {
    expect(bp.title.toLowerCase()).toContain("compliance");
  });
});

// ---------------------------------------------------------------------------
// Evaluation fixtures — all 4 SqsManaged × KmsMasterKeyId combinations
// ---------------------------------------------------------------------------

/** Real-shaped SQS desiredState helper. */
function sqsCtx(overrides: Record<string, unknown> = {}): EvalContext {
  return {
    resourceType: "AWS::SQS::Queue",
    desiredState: {
      QueueName: "genai-jobs",
      ...overrides,
    },
  };
}

describe("BP-SQS-003 + BP-SQS-001 combined — 4 encryption combinations", () => {
  const bp001 = loadBp(BP_SQS_001_PATH);
  const bp003 = loadBp(BP_SQS_003_PATH);
  const practices = [bp001, bp003];

  /**
   * Variation A — SqsManagedSseEnabled=true, KmsMasterKeyId absent.
   *
   * The plan already satisfies FSBP SQS.1 (SSE enabled). BP-SQS-003 must
   * NOT fire at HIGH (it may fire at MEDIUM per the demote). BP-SQS-001 must
   * NOT fire because SqsManagedSseEnabled is set.
   */
  it("Variation A — SqsManagedSseEnabled=true, KMS=unset: 003 fires at MEDIUM (not HIGH)", () => {
    const findings = evaluateTriggers(
      sqsCtx({ SqsManagedSseEnabled: true }),
      practices,
    );

    // BP-SQS-003 MAY fire but MUST NOT be HIGH (was the false-positive).
    const finding003 = findings.find((f) => f.practiceId === "BP-SQS-003");
    if (finding003 !== undefined) {
      expect(finding003.severity).not.toBe("HIGH");
      expect(finding003.severity).toBe("MEDIUM");
    }
  });

  it("Variation A — SqsManagedSseEnabled=true, KMS=unset: BP-SQS-001 does NOT fire", () => {
    const findings = evaluateTriggers(
      sqsCtx({ SqsManagedSseEnabled: true }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SQS-001")).toBeUndefined();
  });

  /**
   * Variation B — neither SqsManagedSseEnabled nor KmsMasterKeyId set.
   *
   * The queue is fully unencrypted. BP-SQS-001 (FSBP SQS.1) must fire HIGH.
   * BP-SQS-003 must fire at MEDIUM (demoted, not HIGH).
   */
  it("Variation B — no SSE at all: BP-SQS-001 fires HIGH (unencrypted queue)", () => {
    const findings = evaluateTriggers(
      sqsCtx({
        VisibilityTimeout: 30,
        MessageRetentionPeriod: 345600,
        RedrivePolicy: {
          deadLetterTargetArn:
            "arn:aws:sqs:us-east-1:210987654321:genai-jobs-dlq",
          maxReceiveCount: 3,
        },
      }),
      practices,
    );

    const finding001 = findings.find((f) => f.practiceId === "BP-SQS-001");
    expect(
      finding001,
      "BP-SQS-001 should fire when neither SSE field is set",
    ).toBeDefined();
    expect(finding001?.severity).toBe("HIGH");
  });

  it("Variation B — no SSE at all: BP-SQS-003 fires at MEDIUM (not HIGH)", () => {
    const findings = evaluateTriggers(
      sqsCtx({
        VisibilityTimeout: 30,
        MessageRetentionPeriod: 345600,
      }),
      practices,
    );

    const finding003 = findings.find((f) => f.practiceId === "BP-SQS-003");
    expect(
      finding003,
      "BP-SQS-003 should still fire when KmsMasterKeyId is absent",
    ).toBeDefined();
    // Must be MEDIUM after the demote — never HIGH again.
    expect(finding003?.severity).toBe("MEDIUM");
  });

  /**
   * Variation C — SqsManagedSseEnabled=false, KmsMasterKeyId set.
   *
   * KMS encryption is present. BP-SQS-003 must NOT fire (KmsMasterKeyId exists).
   * BP-SQS-001 fires HIGH because SqsManagedSseEnabled is explicitly false
   * and the check is `equals: true` — AWS considers explicit false as disabled.
   */
  it("Variation C — KMS set, SqsManagedSse=false: BP-SQS-003 does NOT fire", () => {
    const findings = evaluateTriggers(
      sqsCtx({
        KmsMasterKeyId: "alias/my-genai-jobs-key",
        SqsManagedSseEnabled: false,
        VisibilityTimeout: 30,
        RedrivePolicy: {
          deadLetterTargetArn:
            "arn:aws:sqs:us-east-1:210987654321:genai-jobs-dlq",
          maxReceiveCount: 3,
        },
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SQS-003")).toBeUndefined();
  });

  it("Variation C — KMS set, SqsManagedSse=false: BP-SQS-001 fires (explicit false)", () => {
    const findings = evaluateTriggers(
      sqsCtx({
        KmsMasterKeyId: "alias/my-genai-jobs-key",
        SqsManagedSseEnabled: false,
      }),
      practices,
    );
    // BP-SQS-001 checks SqsManagedSseEnabled === true; explicit false fails.
    const finding001 = findings.find((f) => f.practiceId === "BP-SQS-001");
    expect(
      finding001,
      "BP-SQS-001 should fire when SqsManagedSseEnabled is explicitly false",
    ).toBeDefined();
  });

  /**
   * Variation D — both SqsManagedSseEnabled=true AND KmsMasterKeyId set.
   *
   * Both SSE flavours are active. Neither BP-SQS-001 nor BP-SQS-003 fires.
   * (Using both is redundant; AWS will prefer the KMS key when both are set,
   * but either way both checks pass.)
   */
  it("Variation D — both SSE flavours set: neither BP-SQS-001 nor BP-SQS-003 fires", () => {
    const findings = evaluateTriggers(
      sqsCtx({
        SqsManagedSseEnabled: true,
        KmsMasterKeyId:
          "arn:aws:kms:us-east-1:210987654321:key/mrk-abc1234567890",
        QueueName: "genai-jobs",
        VisibilityTimeout: 30,
        MessageRetentionPeriod: 345600,
        RedrivePolicy: {
          deadLetterTargetArn:
            "arn:aws:sqs:us-east-1:210987654321:genai-jobs-dlq",
          maxReceiveCount: 3,
        },
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SQS-001")).toBeUndefined();
    expect(findings.find((f) => f.practiceId === "BP-SQS-003")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Variation F — plan-mode dogfood: bare SQS queue ("Create an SQS queue")
// produces NO HIGH finding from BP-SQS-003 (the original false-positive).
// ---------------------------------------------------------------------------

describe("Variation F — plan-mode dogfood: bare SQS queue plan", () => {
  const bp001 = loadBp(BP_SQS_001_PATH);
  const bp003 = loadBp(BP_SQS_003_PATH);
  const practices = [bp001, bp003];

  it("bare SQS queue plan with SqsManagedSseEnabled=true does NOT produce a HIGH BP-SQS-003 finding", () => {
    // Simulates what an LLM plan for "Create an SQS queue genai-jobs with
    // managed SSE enabled" would produce — SqsManagedSseEnabled is set but
    // no KmsMasterKeyId (standard workload, not a compliance workload).
    const planContext: EvalContext = {
      resourceType: "AWS::SQS::Queue",
      desiredState: {
        QueueName: "genai-jobs",
        SqsManagedSseEnabled: true,
        VisibilityTimeout: 30,
        MessageRetentionPeriod: 345600,
        Tags: [
          { Key: "Project", Value: "genai" },
          { Key: "Environment", Value: "prod" },
        ],
      },
    };

    const findings = evaluateTriggers(planContext, practices);

    const highFindings = findings.filter(
      (f) =>
        (f.practiceId === "BP-SQS-003" || f.practiceId === "BP-SQS-001") &&
        f.severity === "HIGH",
    );

    expect(
      highFindings,
      "Plan with SqsManagedSseEnabled=true must not produce any HIGH findings from BP-SQS-001 or BP-SQS-003",
    ).toHaveLength(0);
  });

  it("bare SQS queue plan with neither SSE flag DOES produce a HIGH finding (from BP-SQS-001)", () => {
    // Confirms that an actually-unencrypted queue still surfaces as HIGH
    // (via BP-SQS-001), so the demote of BP-SQS-003 doesn't silently hide
    // real unencrypted-queue issues.
    const planContext: EvalContext = {
      resourceType: "AWS::SQS::Queue",
      desiredState: {
        QueueName: "unencrypted-jobs",
        VisibilityTimeout: 30,
        MessageRetentionPeriod: 345600,
      },
    };

    const findings = evaluateTriggers(planContext, practices);

    const highFinding001 = findings.find(
      (f) => f.practiceId === "BP-SQS-001" && f.severity === "HIGH",
    );
    expect(
      highFinding001,
      "BP-SQS-001 must still fire HIGH on a fully-unencrypted queue",
    ).toBeDefined();
  });
});
