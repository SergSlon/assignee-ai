/**
 * Tests for resolve.ts multi-match guard (Story 48-11 #76).
 *
 * When RGTA returns multiple managed resources matching a bare name,
 * resolveResource must throw MultiMatchError (zero CCAPI calls).
 */

import { describe, it, expect, vi } from "vitest";

// Mock the AWS SDK clients before importing the module under test.
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => ({
  ResourceGroupsTaggingAPIClient: vi.fn(),
  GetResourcesCommand: vi.fn(),
}));

// Stub the destroy-strategies registry so getCloudControlIdentifier works.
vi.mock("../../services/destroy-strategies/index.js", () => ({
  destroyRegistry: { get: () => undefined },
}));

import { resolveResource, MultiMatchError } from "./resolve.js";
import type { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";

const TAG_KEY = "managed-by";
const TAG_VALUE = "assignee-ai";

function makeManagedMapping(arn: string) {
  return {
    ResourceARN: arn,
    Tags: [{ Key: TAG_KEY, Value: TAG_VALUE }],
  };
}

function makeMockTaggingClient(
  mappings: Array<{
    ResourceARN: string;
    Tags: Array<{ Key: string; Value: string }>;
  }>,
): ResourceGroupsTaggingAPIClient {
  return {
    send: vi.fn().mockResolvedValue({
      ResourceTagMappingList: mappings,
      PaginationToken: undefined,
    }),
  } as unknown as ResourceGroupsTaggingAPIClient;
}

describe("resolveResource — multi-match guard", () => {
  it("returns single match when only one resource matches a name", async () => {
    const client = makeMockTaggingClient([
      makeManagedMapping("arn:aws:s3:::my-bucket"),
    ]);

    const result = await resolveResource("my-bucket", client, "us-east-1");

    expect(result).not.toBeNull();
    expect(result!.arn).toBe("arn:aws:s3:::my-bucket");
    expect(result!.resourceType).toBe("AWS::S3::Bucket");
  });

  it("throws MultiMatchError when multiple resources match a bare name", async () => {
    // SQS queue ARNs share the same extracted identifier (queue name after last ":").
    // Two queues in different accounts with the same name produce a multi-match.
    const dualClient = makeMockTaggingClient([
      makeManagedMapping("arn:aws:sqs:us-east-1:111111111111:my-queue"),
      makeManagedMapping("arn:aws:sqs:us-east-1:222222222222:my-queue"),
    ]);

    await expect(
      resolveResource("my-queue", dualClient, "us-east-1"),
    ).rejects.toThrow(MultiMatchError);

    await expect(
      resolveResource("my-queue", dualClient, "us-east-1"),
    ).rejects.toThrow(
      /Multiple managed resources match 'my-queue'; specify ARN explicitly\. Matches: arn:aws:sqs:us-east-1:111111111111:my-queue, arn:aws:sqs:us-east-1:222222222222:my-queue/,
    );
  });

  it("multi-match error includes all matching ARNs", async () => {
    const client = makeMockTaggingClient([
      makeManagedMapping("arn:aws:sqs:us-east-1:111111111111:my-queue"),
      makeManagedMapping("arn:aws:sqs:us-east-1:222222222222:my-queue"),
      makeManagedMapping("arn:aws:sqs:us-east-1:333333333333:my-queue"),
    ]);

    try {
      await resolveResource("my-queue", client, "us-east-1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MultiMatchError);
      const msg = (err as MultiMatchError).message;
      expect(msg).toContain("arn:aws:sqs:us-east-1:111111111111:my-queue");
      expect(msg).toContain("arn:aws:sqs:us-east-1:222222222222:my-queue");
      expect(msg).toContain("arn:aws:sqs:us-east-1:333333333333:my-queue");
    }
  });

  it("zero CCAPI calls fire on multi-match (only RGTA)", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      ResourceTagMappingList: [
        makeManagedMapping("arn:aws:sqs:us-east-1:111111111111:my-queue"),
        makeManagedMapping("arn:aws:sqs:us-east-1:222222222222:my-queue"),
      ],
      PaginationToken: undefined,
    });
    const client = {
      send: sendMock,
    } as unknown as ResourceGroupsTaggingAPIClient;

    await expect(
      resolveResource("my-queue", client, "us-east-1"),
    ).rejects.toThrow(MultiMatchError);

    // Only RGTA GetResourcesCommand was sent — no CloudControl calls
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("ARN input bypasses multi-match guard (returns first match)", async () => {
    const arn = "arn:aws:s3:::my-bucket";
    const client = {
      send: vi.fn().mockResolvedValue({
        ResourceTagMappingList: [makeManagedMapping(arn)],
        PaginationToken: undefined,
      }),
    } as unknown as ResourceGroupsTaggingAPIClient;

    const result = await resolveResource(arn, client, "us-east-1");
    expect(result).not.toBeNull();
    expect(result!.arn).toBe(arn);
  });
});
