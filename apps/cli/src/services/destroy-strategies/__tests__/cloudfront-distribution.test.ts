/**
 * Tests for cloudfront-distribution destroy strategy — happy path
 * (already-disabled fast-delete) + enabled/poll/delete + transient-
 * error backoff abort.
 *
 * @see Wave-6 F1b
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const hoisted = vi.hoisted(() => ({ mockCfSend: vi.fn() }));
vi.mock("@aws-sdk/client-cloudfront", () => {
  class CloudFrontClient {
    send = hoisted.mockCfSend;
    destroy = vi.fn();
  }
  function GetDistributionCommand(i: Record<string, unknown>) {
    return { _type: "GetDistribution", ...i };
  }
  function UpdateDistributionCommand(i: Record<string, unknown>) {
    return { _type: "UpdateDistribution", ...i };
  }
  function DeleteDistributionCommand(i: Record<string, unknown>) {
    return { _type: "DeleteDistribution", ...i };
  }
  return {
    CloudFrontClient,
    GetDistributionCommand,
    UpdateDistributionCommand,
    DeleteDistributionCommand,
  };
});

import { cloudfrontDistributionStrategy } from "@assignee/core";
import type { DestroyContext } from "@assignee/core";

const originalSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error simplified stub for tests
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});
afterAll(() => {
  globalThis.setTimeout = originalSetTimeout;
});

function makeCtx(): DestroyContext {
  return {
    resource: {
      arn: "arn:aws:cloudfront::123456789012:distribution/E123",
      resourceType: "AWS::CloudFront::Distribution",
      identifier: "E123",
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    warn: () => {},
  };
}

describe("cloudfrontDistributionStrategy", () => {
  it("fast-path: already-disabled distribution deletes in one Get + one Delete", async () => {
    hoisted.mockCfSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetDistribution") {
        return {
          Distribution: { DistributionConfig: { Enabled: false } },
          ETag: "etag-0",
        };
      }
      return {};
    });

    const outcome = await cloudfrontDistributionStrategy.destroy!(makeCtx());
    expect(outcome).toEqual({ success: true });
    const types = hoisted.mockCfSend.mock.calls.map((c) => c[0]._type);
    expect(types).toEqual(["GetDistribution", "DeleteDistribution"]);
  });

  it("disables an enabled distribution, polls until Deployed, then deletes", async () => {
    let pollN = 0;
    hoisted.mockCfSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetDistribution") {
        pollN++;
        // First call = initial fetch (enabled); next calls = poll status.
        if (pollN === 1) {
          return {
            Distribution: { DistributionConfig: { Enabled: true } },
            ETag: "etag-1",
          };
        }
        if (pollN < 3) {
          return { Distribution: { Status: "InProgress" }, ETag: "etag-2" };
        }
        return { Distribution: { Status: "Deployed" }, ETag: "etag-3" };
      }
      if (cmd._type === "UpdateDistribution") return {};
      if (cmd._type === "DeleteDistribution") return {};
      return {};
    });

    const outcome = await cloudfrontDistributionStrategy.destroy!(makeCtx());
    expect(outcome).toEqual({ success: true });
    const types = hoisted.mockCfSend.mock.calls.map((c) => c[0]._type);
    // Get -> Update -> Get (InProgress) -> Get (InProgress) -> Get (Deployed) -> Delete
    expect(types[0]).toBe("GetDistribution");
    expect(types[1]).toBe("UpdateDistribution");
    expect(types[types.length - 1]).toBe("DeleteDistribution");
  });

  it("aborts after 5 consecutive transient poll errors", async () => {
    let pollN = 0;
    hoisted.mockCfSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetDistribution") {
        pollN++;
        if (pollN === 1) {
          return {
            Distribution: { DistributionConfig: { Enabled: true } },
            ETag: "etag-1",
          };
        }
        throw new Error("ThrottlingException");
      }
      if (cmd._type === "UpdateDistribution") return {};
      return {};
    });

    const outcome = await cloudfrontDistributionStrategy.destroy!(makeCtx());
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("5 consecutive transient errors");
    expect(outcome.error).toContain("ThrottlingException");
  });
});
