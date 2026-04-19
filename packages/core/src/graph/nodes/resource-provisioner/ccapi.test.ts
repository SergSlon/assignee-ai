import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import type { ProvisioningPort } from "@/ports/provisioning-port.js";
import { ProvisioningErrorKind } from "@/ports/provisioning-port.js";
import {
  buildClientToken,
  createResourceWithCloudFrontRetry,
  CLOUDFRONT_S3_RETRY_WAIT_MS,
  waitForCloudFrontRetryDnsIfNeeded,
  waitForCloudFrontS3DnsIfNeeded,
} from "./ccapi.js";

function mockProvisioner(): ProvisioningPort & {
  createResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
    getRequestStatus: vi.fn(),
  } as unknown as ProvisioningPort & {
    createResource: ReturnType<typeof vi.fn>;
  };
}

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-ccapi-001",
    currentResourceIndex: 0,
    ...overrides,
  } as unknown as AgentState;
}

describe("resource-provisioner/ccapi", () => {
  describe("buildClientToken", () => {
    it("produces runId-<12hex> when index is 0 or undefined", async () => {
      const t1 = await buildClientToken("run-abc", 0);
      expect(t1).toMatch(/^run-abc-[0-9a-f]{12}$/);
      const t2 = await buildClientToken("run-abc", undefined);
      expect(t2).toMatch(/^run-abc-[0-9a-f]{12}$/);
    });

    it("includes -<index> when index > 0", async () => {
      const t = await buildClientToken("run-abc", 3);
      expect(t).toMatch(/^run-abc-3-[0-9a-f]{12}$/);
    });

    it("produces different tokens on consecutive calls (H11)", async () => {
      const a = await buildClientToken("run-abc", 0);
      const b = await buildClientToken("run-abc", 0);
      expect(a).not.toBe(b);
    });

    it("1000 sequential tokens are all unique (48-bit entropy smoke)", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        seen.add(await buildClientToken("run-abc", 0));
      }
      expect(seen.size).toBe(1000);
    });
  });

  describe("waitForCloudFrontRetryDnsIfNeeded", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    it("waits 30s on CloudFront retry with no requestToken", async () => {
      const state = baseState({
        retryCount: 1,
        resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
        requestToken: undefined,
      });
      const p = waitForCloudFrontRetryDnsIfNeeded(state);
      await vi.advanceTimersByTimeAsync(CLOUDFRONT_S3_RETRY_WAIT_MS);
      expect(await p).toBe(true);
      vi.useRealTimers();
    });

    it("no-ops when retryCount is 0", async () => {
      vi.useRealTimers();
      const state = baseState({
        retryCount: 0,
        resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      });
      expect(await waitForCloudFrontRetryDnsIfNeeded(state)).toBe(false);
    });

    it("no-ops for non-CloudFront resources", async () => {
      vi.useRealTimers();
      const state = baseState({
        retryCount: 1,
        resourceType: RESOURCE_TYPES.S3_BUCKET,
      });
      expect(await waitForCloudFrontRetryDnsIfNeeded(state)).toBe(false);
    });
  });

  describe("waitForCloudFrontS3DnsIfNeeded", () => {
    it("no-ops when resource is not CloudFront", async () => {
      await waitForCloudFrontS3DnsIfNeeded(
        baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      );
      // If this returned without hanging, the test passes.
      expect(true).toBe(true);
    });

    it("no-ops when no S3 bucket is in completedResources", async () => {
      await waitForCloudFrontS3DnsIfNeeded(
        baseState({
          resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
          completedResources: [],
        }),
      );
      expect(true).toBe(true);
    });
  });

  describe("createResourceWithCloudFrontRetry", () => {
    it("calls createResource exactly once on success", async () => {
      const p = mockProvisioner();
      p.createResource.mockResolvedValue([null, { requestToken: "rt-1" }]);
      const out = await createResourceWithCloudFrontRetry(
        p,
        baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
        RESOURCE_TYPES.S3_BUCKET,
        "{}",
        "run-1",
        0,
      );
      expect(p.createResource).toHaveBeenCalledTimes(1);
      expect(out.createErr).toBeNull();
      expect(out.createResult?.requestToken).toBe("rt-1");
    });

    it("does NOT retry for non-CloudFront errors", async () => {
      const p = mockProvisioner();
      p.createResource.mockResolvedValue([
        { kind: ProvisioningErrorKind.ALREADY_EXISTS, message: "already" },
        null,
      ]);
      await createResourceWithCloudFrontRetry(
        p,
        baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
        RESOURCE_TYPES.S3_BUCKET,
        "{}",
        "run-1",
        0,
      );
      expect(p.createResource).toHaveBeenCalledTimes(1);
    });

    it("retries CloudFront S3-DNS failure up to 3 times with fresh tokens", async () => {
      vi.useFakeTimers();
      const p = mockProvisioner();
      const dnsErr = {
        kind: ProvisioningErrorKind.SERVICE_ERROR,
        message: "origin does not refer to a valid S3 bucket",
      };
      p.createResource
        .mockResolvedValueOnce([dnsErr, null])
        .mockResolvedValueOnce([dnsErr, null])
        .mockResolvedValueOnce([null, { requestToken: "rt-final" }]);
      const task = createResourceWithCloudFrontRetry(
        p,
        baseState({
          resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
        }),
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
        "{}",
        "run-cf",
        0,
      );
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(10000);
      const out = await task;
      expect(p.createResource).toHaveBeenCalledTimes(3);
      expect(out.createErr).toBeNull();
      // Each attempt uses a fresh ClientToken.
      const tokens = p.createResource.mock.calls.map((c) => c[2]);
      expect(new Set(tokens).size).toBe(3);
      vi.useRealTimers();
    });

    it("stops retrying when error is no longer S3-DNS", async () => {
      vi.useFakeTimers();
      const p = mockProvisioner();
      p.createResource
        .mockResolvedValueOnce([
          {
            kind: ProvisioningErrorKind.SERVICE_ERROR,
            message: "origin does not refer to a valid S3 bucket",
          },
          null,
        ])
        .mockResolvedValueOnce([
          {
            kind: ProvisioningErrorKind.ALREADY_EXISTS,
            message: "already exists",
          },
          null,
        ]);
      const task = createResourceWithCloudFrontRetry(
        p,
        baseState({
          resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
        }),
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
        "{}",
        "run-cf",
        0,
      );
      await vi.advanceTimersByTimeAsync(5000);
      const out = await task;
      expect(p.createResource).toHaveBeenCalledTimes(2);
      expect(out.createErr?.kind).toBe(ProvisioningErrorKind.ALREADY_EXISTS);
      vi.useRealTimers();
    });
  });
});
