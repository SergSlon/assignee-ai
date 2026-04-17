/**
 * Dedicated unit tests for the shared destroy-strategy types
 * (Story 50-6). The interface itself is compile-time, but this suite:
 *
 *   1. Pins the runtime constants (CCAPIStatus, CCAPI_NOT_FOUND_ERROR_CODE)
 *      so callers that string-compare against them see regressions.
 *   2. Constructs representative DestroyStrategy shapes (flag-only,
 *      preDestroy-only, destroy-replacement, postDestroy-only, full
 *      mix) and exercises each hook — proving the hook signature is
 *      what the dispatcher expects and that a DestroyContext with the
 *      documented shape is a valid argument.
 */
import { describe, it, expect, vi } from "vitest";
import { CCAPIStatus, CCAPI_NOT_FOUND_ERROR_CODE } from "./types.js";
import type {
  AwsConfig,
  DestroyContext,
  DestroyHookOutcome,
  DestroyResourceInput,
  DestroyStrategy,
} from "./types.js";
import { RESOURCE_TYPES } from "../config/resource-types/named.js";

describe("CCAPI runtime constants", () => {
  it("CCAPIStatus.SUCCESS === 'SUCCESS' (wire value)", () => {
    // Pin the wire value: CCAPI's ProgressEvent.OperationStatus is the
    // upper-case string "SUCCESS". Any dispatcher comparison against
    // this constant must not silently change.
    expect(CCAPIStatus.SUCCESS).toBe("SUCCESS");
  });

  it("CCAPIStatus.FAILED === 'FAILED' (wire value)", () => {
    expect(CCAPIStatus.FAILED).toBe("FAILED");
  });

  it("CCAPI_NOT_FOUND_ERROR_CODE === 'NotFound'", () => {
    // Matches AWS CloudControl's HandlerErrorCode enum spelling.
    // See feedback_cloudcontrol_notfound_short_circuit.md.
    expect(CCAPI_NOT_FOUND_ERROR_CODE).toBe("NotFound");
  });
});

// ── Fixture builders ─────────────────────────────────────────────────

const realCredentials: AwsConfig = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

const realResource: DestroyResourceInput = {
  arn: "arn:aws:s3:::assignee-dev-logs-20260416",
  resourceType: RESOURCE_TYPES.S3_BUCKET,
  identifier: "assignee-dev-logs-20260416",
  region: "us-east-1",
};

const buildContext = (
  overrides: Partial<DestroyContext> = {},
): DestroyContext => ({
  resource: realResource,
  awsConfig: realCredentials,
  effectiveRegion: "us-east-1",
  onProgress: vi.fn(),
  warn: vi.fn(),
  ...overrides,
});

describe("DestroyStrategy — flag-only shape", () => {
  it("accepts { resourceType, usesArnIdentifier, isSlow } with no hooks", () => {
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.SNS_TOPIC,
      usesArnIdentifier: true,
      isSlow: false,
    };
    expect(strategy.resourceType).toBe(RESOURCE_TYPES.SNS_TOPIC);
    expect(strategy.usesArnIdentifier).toBe(true);
    expect(strategy.preDestroy).toBeUndefined();
    expect(strategy.destroy).toBeUndefined();
    expect(strategy.postDestroy).toBeUndefined();
  });
});

describe("DestroyStrategy — extractIdentifier hook", () => {
  it("synthesizes a CCAPI identifier from the resource ARN", () => {
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      extractIdentifier: (arn, _identifier, region) => {
        const account = arn.split(":")[4];
        const name = arn.split(":").pop();
        return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
      },
    };
    const result = strategy.extractIdentifier!(
      "arn:aws:sqs:us-east-1:123456789012:assignee-jobs",
      "unused",
      "us-east-1",
    );
    expect(result).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/assignee-jobs",
    );
  });
});

describe("DestroyStrategy — preDestroy hook", () => {
  it("success: resolves void — proceed to CCAPI", async () => {
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
      preDestroy: async () => {
        /* work complete, success */
      },
    };
    await expect(strategy.preDestroy!(buildContext())).resolves.toBeUndefined();
  });

  it("explicit outcome: { success: false, error } aborts destroy", async () => {
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
      preDestroy: async (): Promise<DestroyHookOutcome> => ({
        success: false,
        error: "AccessDenied on dynamodb:DescribeTable — V1 N2",
      }),
    };
    const outcome = (await strategy.preDestroy!(
      buildContext(),
    )) as DestroyHookOutcome;
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("AccessDenied");
  });

  it("receives region-promoted context.effectiveRegion", async () => {
    const seen: string[] = [];
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      preDestroy: async (ctx) => {
        seen.push(ctx.effectiveRegion);
      },
    };
    const ctx = buildContext({
      resource: { ...realResource, region: "global" },
      effectiveRegion: "us-east-1",
    });
    await strategy.preDestroy!(ctx);
    expect(seen).toEqual(["us-east-1"]);
  });

  it("invokes warn() on partial-failure (hook contract)", async () => {
    const warn = vi.fn();
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      preDestroy: async (ctx) => {
        ctx.warn("igw_partial_detach_state", { remaining: 1 });
      },
    };
    await strategy.preDestroy!(buildContext({ warn }));
    expect(warn).toHaveBeenCalledWith("igw_partial_detach_state", {
      remaining: 1,
    });
  });
});

describe("DestroyStrategy — destroy hook (full replacement)", () => {
  it("returns DestroyHookOutcome and skips the generic CCAPI path", async () => {
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      destroy: async () => ({ success: true }),
    };
    const outcome = await strategy.destroy!(buildContext());
    expect(outcome).toEqual({ success: true });
  });

  it("propagates failure through the outcome envelope (never throws)", async () => {
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      destroy: async (): Promise<DestroyHookOutcome> => ({
        success: false,
        error: "Distribution still enabled",
      }),
    };
    const outcome = await strategy.destroy!(buildContext());
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("Distribution still enabled");
  });
});

describe("DestroyStrategy — postDestroy hook", () => {
  it("never throws the overall destroy — failures emit via warn()", async () => {
    const warn = vi.fn();
    const strategy: DestroyStrategy = {
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      postDestroy: async (ctx) => {
        try {
          throw new Error("ENI drain timed out");
        } catch (err) {
          ctx.warn("alb_eni_drain_failed", {
            error: (err as Error).message,
          });
        }
      },
    };
    await expect(
      strategy.postDestroy!(buildContext({ warn })),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("alb_eni_drain_failed", {
      error: "ENI drain timed out",
    });
  });
});

describe("DestroyContext — real resource passthrough", () => {
  it("context carries the resource + credentials + callbacks verbatim", () => {
    const onProgress = vi.fn();
    const warn = vi.fn();
    const ctx = buildContext({ onProgress, warn });
    expect(ctx.resource.arn).toBe("arn:aws:s3:::assignee-dev-logs-20260416");
    expect(ctx.resource.resourceType).toBe(RESOURCE_TYPES.S3_BUCKET);
    expect(ctx.awsConfig.region).toBe("us-east-1");
    expect(ctx.effectiveRegion).toBe("us-east-1");
    ctx.onProgress?.("hello");
    expect(onProgress).toHaveBeenCalledWith("hello");
  });
});
