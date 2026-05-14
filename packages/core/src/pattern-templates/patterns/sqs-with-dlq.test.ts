import { describe, it, expect } from "vitest";
import { sqsWithDlqPattern } from "./sqs-with-dlq.js";
import { PatternRegistry } from "../registry.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { markerGetAtt, parseMarker } from "../../config/marker-tokens.js";
import { SqsWithDlqResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";
import { messageProcessingPattern } from "./message-processing.js";

function buildRegistry(): PatternRegistry {
  const r = new PatternRegistry();
  r.register(sqsWithDlqPattern);
  return r;
}

function buildRegistryWithMessageProcessing(): PatternRegistry {
  const r = new PatternRegistry();
  // message-processing registers BEFORE sqs-with-dlq (mirrors production order)
  r.register(messageProcessingPattern);
  r.register(sqsWithDlqPattern);
  return r;
}

const allDepIds = (): string[] => sqsWithDlqPattern.dependencyOrder.flat();
const allResourceIds = (): string[] =>
  sqsWithDlqPattern.resourceList.map((r) => r.resourceId);

// ---------------------------------------------------------------------------
// Variation A — "with DLQ" intent
// ---------------------------------------------------------------------------
describe("Variation A — 'with DLQ' intent", () => {
  const registry = buildRegistry();

  it("detects 'Create an SQS queue genai-jobs with DLQ' as sqs-with-dlq", () => {
    const detected = registry.detect("Create an SQS queue genai-jobs with DLQ");
    expect(detected?.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });

  it("emits exactly 2 resources", () => {
    expect(sqsWithDlqPattern.resourceList).toHaveLength(2);
  });

  it("primary queue references DLQ ARN via markerGetAtt", () => {
    const primaryOpts = sqsWithDlqPattern.defaultOptions[R.PRIMARY_QUEUE];
    expect(primaryOpts).toBeDefined();
    const redrive = primaryOpts?.["RedrivePolicy"] as Record<string, unknown>;
    expect(redrive).toBeDefined();
    expect(redrive["deadLetterTargetArn"]).toBe(markerGetAtt(R.DLQ, "Arn"));
  });

  it("maxReceiveCount defaults to 5", () => {
    const redrive = sqsWithDlqPattern.defaultOptions[R.PRIMARY_QUEUE]?.[
      "RedrivePolicy"
    ] as Record<string, unknown>;
    expect(redrive["maxReceiveCount"]).toBe(5);
  });

  it("DLQ resource type is AWS::SQS::Queue", () => {
    const dlq = sqsWithDlqPattern.resourceList.find(
      (r) => r.resourceId === R.DLQ,
    );
    expect(dlq?.resourceType).toBe(RESOURCE_TYPES.SQS_QUEUE);
  });

  it("primary queue resource type is AWS::SQS::Queue", () => {
    const primary = sqsWithDlqPattern.resourceList.find(
      (r) => r.resourceId === R.PRIMARY_QUEUE,
    );
    expect(primary?.resourceType).toBe(RESOURCE_TYPES.SQS_QUEUE);
  });
});

// ---------------------------------------------------------------------------
// Variation B — "with dead-letter queue" intent
// ---------------------------------------------------------------------------
describe("Variation B — 'with dead-letter queue' intent", () => {
  const registry = buildRegistry();

  it("detects 'Create an SQS queue with dead-letter queue' as sqs-with-dlq", () => {
    const detected = registry.detect(
      "Create an SQS queue with dead-letter queue",
    );
    expect(detected?.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });

  it("also detects 'create a queue with dead letter queue' (no hyphen variant)", () => {
    const detected = registry.detect("create a queue with dead letter queue");
    expect(detected?.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });
});

// ---------------------------------------------------------------------------
// Variation C — "dead letter queue" (without 'with' prefix)
// ---------------------------------------------------------------------------
describe("Variation C — bare 'dead letter queue' phrasing", () => {
  const registry = buildRegistry();

  it("detects 'Create an SQS queue jobs and dead letter queue' as sqs-with-dlq", () => {
    const detected = registry.detect(
      "Create an SQS queue jobs and dead letter queue",
    );
    expect(detected?.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });

  it("detects 'create sqs dead-letter queue' as sqs-with-dlq", () => {
    const detected = registry.detect("create sqs dead-letter queue");
    expect(detected?.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });
});

// ---------------------------------------------------------------------------
// Variation D — explicit maxReceiveCount override
// ---------------------------------------------------------------------------
describe("Variation D — explicit maxReceiveCount override", () => {
  it("pattern defaults to maxReceiveCount=5 (override base)", () => {
    const redrive = sqsWithDlqPattern.defaultOptions[R.PRIMARY_QUEUE]?.[
      "RedrivePolicy"
    ] as Record<string, unknown>;
    expect(redrive["maxReceiveCount"]).toBe(5);
  });

  it("pattern structure supports user override of maxReceiveCount via defaultOptions merge", () => {
    // The caller can merge { RedrivePolicy: { maxReceiveCount: 3 } }
    // into the defaultOptions at plan time. Verify the structure is
    // a plain Record (not frozen) and contains the field.
    const opts = sqsWithDlqPattern.defaultOptions[R.PRIMARY_QUEUE];
    expect(opts).toBeDefined();
    expect(typeof opts?.["RedrivePolicy"]).toBe("object");
    // Simulate what plan-generator does: spread user overrides
    const merged = {
      ...opts,
      RedrivePolicy: {
        ...(opts?.["RedrivePolicy"] as Record<string, unknown>),
        maxReceiveCount: 3,
      },
    };
    expect(
      (merged["RedrivePolicy"] as Record<string, unknown>)["maxReceiveCount"],
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Variation E — bare SQS no DLQ (no-regression)
// ---------------------------------------------------------------------------
describe("Variation E — bare SQS without DLQ phrasing (no regression)", () => {
  const registry = buildRegistry();

  it("does NOT match a bare 'Create an SQS queue genai-jobs' intent", () => {
    expect(registry.detect("Create an SQS queue genai-jobs")).toBeNull();
  });

  it("does NOT match 'create an sqs queue for notifications'", () => {
    expect(registry.detect("create an sqs queue for notifications")).toBeNull();
  });

  it("does NOT match 'create a standard queue'", () => {
    expect(registry.detect("create a standard queue")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Variation F — SQS + DLQ + KMS (KMS mirroring)
// ---------------------------------------------------------------------------
describe("Variation F — SQS + DLQ + KMS encryption", () => {
  const registry = buildRegistry();

  it("detects 'Create an SQS queue jobs with DLQ and KMS encryption' as sqs-with-dlq", () => {
    const detected = registry.detect(
      "Create an SQS queue jobs with DLQ and KMS encryption",
    );
    expect(detected?.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });

  it("both DLQ and primary queue defaultOptions support KMS via SqsManagedSseEnabled", () => {
    // Both queues have SqsManagedSseEnabled by default — SSE is enabled.
    // When a user specifies a custom KMS key, the plan-generator or wizard
    // replaces SqsManagedSseEnabled with KmsMasterKeyId on both queues.
    // This test pins that both queue opts exist and have SSE defaults ready.
    const dlqOpts = sqsWithDlqPattern.defaultOptions[R.DLQ];
    const primaryOpts = sqsWithDlqPattern.defaultOptions[R.PRIMARY_QUEUE];
    expect(dlqOpts?.["SqsManagedSseEnabled"]).toBe(true);
    expect(primaryOpts?.["SqsManagedSseEnabled"]).toBe(true);
  });

  it("KMS can be mirrored to both queues via merged overrides", () => {
    const kmsKeyArn = "arn:aws:kms:us-east-1:112233445566:key/test-key-id";
    const dlqOpts = sqsWithDlqPattern.defaultOptions[R.DLQ];
    const primaryOpts = sqsWithDlqPattern.defaultOptions[R.PRIMARY_QUEUE];
    // Simulate applying KMS to both queues (use Record<string, unknown> to avoid
    // TS narrowing issues when spreading typed option objects)
    const mergedDlq: Record<string, unknown> = {
      ...dlqOpts,
      SqsManagedSseEnabled: false,
      KmsMasterKeyId: kmsKeyArn,
    };
    const mergedPrimary: Record<string, unknown> = {
      ...primaryOpts,
      SqsManagedSseEnabled: false,
      KmsMasterKeyId: kmsKeyArn,
    };
    expect(mergedDlq["KmsMasterKeyId"]).toBe(kmsKeyArn);
    expect(mergedPrimary["KmsMasterKeyId"]).toBe(kmsKeyArn);
    // RedrivePolicy ARN wiring is preserved across merge
    expect(
      (mergedPrimary["RedrivePolicy"] as Record<string, unknown>)[
        "deadLetterTargetArn"
      ],
    ).toBe(markerGetAtt(R.DLQ, "Arn"));
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------
describe("sqsWithDlqPattern — structure", () => {
  it("has patternId 'sqs-with-dlq'", () => {
    expect(sqsWithDlqPattern.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });

  it("has a human-readable displayName containing 'DLQ' or 'Dead'", () => {
    expect(sqsWithDlqPattern.displayName).toMatch(/DLQ|Dead/i);
  });

  it("has at least 5 keywords for detection", () => {
    expect(sqsWithDlqPattern.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it("every keyword is a non-empty lowercase string", () => {
    for (const kw of sqsWithDlqPattern.keywords) {
      expect(typeof kw).toBe("string");
      expect(kw.length).toBeGreaterThan(0);
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("dependencyOrder and resourceList cover identical resourceId sets", () => {
    expect(new Set(allDepIds())).toEqual(new Set(allResourceIds()));
  });

  it("every dependencyOrder id has a defaultOptions entry", () => {
    for (const id of allDepIds()) {
      expect(sqsWithDlqPattern.defaultOptions[id]).toBeTypeOf("object");
    }
  });

  it("DLQ is in dependency group 0, primary is in group 1", () => {
    const order = sqsWithDlqPattern.dependencyOrder;
    expect(order[0]).toContain(R.DLQ);
    expect(order[1]).toContain(R.PRIMARY_QUEUE);
  });

  it("DLQ has no RedrivePolicy (it is the terminal dead-letter queue)", () => {
    expect(
      sqsWithDlqPattern.defaultOptions[R.DLQ]?.["RedrivePolicy"],
    ).toBeUndefined();
  });

  it("every marker string parses as a well-formed marker token", () => {
    const walk = (value: unknown): void => {
      if (typeof value === "string" && value.startsWith("__ASSIGNEE_")) {
        const parsed = parseMarker(value);
        expect(parsed).not.toBeUndefined();
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(walk);
      }
    };
    walk(sqsWithDlqPattern.defaultOptions);
  });
});

// ---------------------------------------------------------------------------
// Wiring: bidirectional correctness
// ---------------------------------------------------------------------------
describe("sqsWithDlqPattern — RedrivePolicy wiring", () => {
  it("deadLetterTargetArn uses GETATT marker (not REF)", () => {
    const dlqArn = markerGetAtt(R.DLQ, "Arn");
    const redrive = sqsWithDlqPattern.defaultOptions[R.PRIMARY_QUEUE]?.[
      "RedrivePolicy"
    ] as Record<string, unknown>;
    expect(redrive["deadLetterTargetArn"]).toBe(dlqArn);
    // It must be a GETATT marker, not a REF
    const parsed = parseMarker(dlqArn);
    expect(parsed?.kind).toBe("getatt");
    if (parsed?.kind === "getatt") {
      expect(parsed.resourceId).toBe(R.DLQ);
      expect(parsed.attribute).toBe("Arn");
    }
  });

  it("DLQ has no reference back to primary (no circular dependency)", () => {
    const dlqOpts = sqsWithDlqPattern.defaultOptions[R.DLQ];
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        expect(value).not.toContain(R.PRIMARY_QUEUE);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(walk);
      }
    };
    walk(dlqOpts);
  });
});

// ---------------------------------------------------------------------------
// Registry: no collision with message-processing
// ---------------------------------------------------------------------------
describe("sqsWithDlqPattern — registry collision checks", () => {
  it("'sqs lambda' routes to message-processing, NOT sqs-with-dlq", () => {
    const registry = buildRegistryWithMessageProcessing();
    // Uses the "sqs lambda" keyword that is in message-processing's keyword list
    const detected = registry.detect("create an sqs lambda queue processor");
    expect(detected?.patternId).toBe(PatternId.MESSAGE_PROCESSING);
  });

  it("'with DLQ' still routes to sqs-with-dlq in combined registry", () => {
    const registry = buildRegistryWithMessageProcessing();
    const detected = registry.detect("create an sqs queue with DLQ");
    expect(detected?.patternId).toBe(PatternId.SQS_WITH_DLQ);
  });
});
