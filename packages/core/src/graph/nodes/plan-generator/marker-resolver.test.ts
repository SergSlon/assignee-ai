/**
 * Unit tests for plan-generator/marker-resolver.ts — focuses on the two
 * resolution modes (apply vs plan) and the AZ-lookup port (DIP).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { markerRef, markerAz, markerRegion } from "@/index.js";
import type { ResourceResult } from "@/index.js";
import {
  resolveCompoundMarkers,
  resolvePlaceholderMarkers,
  __resetAzCacheForTests,
  type AzLookup,
} from "./marker-resolver.js";

const fakeAzLookup: AzLookup = async () => [
  "us-east-1a",
  "us-east-1b",
  "us-east-1c",
];

describe("marker-resolver direct import", () => {
  beforeEach(() => __resetAzCacheForTests());

  describe("resolvePlaceholderMarkers (plan mode, sync)", () => {
    it("replaces REF markers with '(from <id>)'", () => {
      const state: Record<string, unknown> = { VpcId: markerRef("vpc") };
      resolvePlaceholderMarkers(state, "us-east-1");
      expect(state["VpcId"]).toBe("(from vpc)");
    });

    it("replaces AZ markers with deterministic region+letter placeholders", () => {
      const state: Record<string, unknown> = { AZ: markerAz(1) };
      resolvePlaceholderMarkers(state, "us-east-1");
      expect(state["AZ"]).toBe("us-east-1b");
    });

    it("leaves non-marker strings untouched", () => {
      const state: Record<string, unknown> = { Name: "real-value" };
      resolvePlaceholderMarkers(state, "us-east-1");
      expect(state["Name"]).toBe("real-value");
    });
  });

  describe("resolveCompoundMarkers (apply mode, async)", () => {
    it("replaces REF markers with completedResources.resourceArn", async () => {
      const completed: ResourceResult[] = [
        {
          resourceId: "vpc",
          resourceType: "AWS::EC2::VPC",
          executionStatus: "SUCCESS" as never,
          resourceArn: "vpc-0abc123",
        } as never,
      ];
      const state: Record<string, unknown> = { VpcId: markerRef("vpc") };
      await resolveCompoundMarkers(state, {
        completedResources: completed,
        region: "us-east-1",
        currentResourceId: "subnet",
        azLookup: fakeAzLookup,
      });
      expect(state["VpcId"]).toBe("vpc-0abc123");
    });

    it("uses the injected AzLookup port (DIP)", async () => {
      const state: Record<string, unknown> = { AZ: markerAz(2) };
      await resolveCompoundMarkers(state, {
        completedResources: [],
        region: "us-east-1",
        currentResourceId: "r",
        azLookup: fakeAzLookup,
      });
      expect(state["AZ"]).toBe("us-east-1c");
    });

    it("resolves embedded region markers in composite strings", async () => {
      const state: Record<string, unknown> = {
        Endpoint: `my-thing.${markerRegion()}.amazonaws.com`,
      };
      await resolveCompoundMarkers(state, {
        completedResources: [],
        region: "eu-west-2",
        currentResourceId: "r",
        azLookup: fakeAzLookup,
      });
      expect(state["Endpoint"]).toBe("my-thing.eu-west-2.amazonaws.com");
    });

    it("throws an actionable error when a REF target is missing", async () => {
      const state: Record<string, unknown> = { VpcId: markerRef("missing") };
      await expect(
        resolveCompoundMarkers(state, {
          completedResources: [],
          region: "us-east-1",
          currentResourceId: "subnet",
          azLookup: fakeAzLookup,
        }),
      ).rejects.toThrow(/no completed resource with resourceId "missing"/);
    });
  });
});
