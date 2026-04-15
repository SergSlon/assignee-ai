/**
 * Tests for resource-resolver.ts
 *
 * @see Story 18.5
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock AWS SDK ────────────────────────────────────────────────────────────
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  class MockResourceGroupsTaggingAPIClient {
    send = mockSend;
  }
  return {
    ResourceGroupsTaggingAPIClient: MockResourceGroupsTaggingAPIClient,
    GetResourcesCommand: vi.fn(),
  };
});

// Mock the IAM role inventory helper so RGTA-only tests don't try to
// construct a real IAMClient and hit real AWS during test runs.
// vi.hoisted is required because vi.mock is hoisted above const decls
// — naked top-level consts would not be initialized when the factory
// runs.
const { mockFetchManagedIamRoles, mockGetManagedIamRoleByArn } = vi.hoisted(
  () => ({
    mockFetchManagedIamRoles: vi.fn(),
    mockGetManagedIamRoleByArn: vi.fn(),
  }),
);
vi.mock("./iam-role-inventory.js", () => ({
  fetchManagedIamRoles: mockFetchManagedIamRoles,
  getManagedIamRoleByArn: mockGetManagedIamRoleByArn,
  IAM_ROLE_RESOURCE_TYPE: "AWS::IAM::Role",
}));

import {
  resolveResource,
  type ResolvedResource,
  type Resolution,
} from "./resource-resolver.js";

/**
 * Story 48.6: resolveResource now returns a discriminated union
 * (`ResolvedResource | AmbiguousResolution | null`). The legacy suite
 * below only exercises single-match and null paths; this helper narrows
 * the union to a concrete ResolvedResource so existing `.arn` / `.identifier`
 * assertions type-check. Asserts loudly on an unexpected ambiguous result
 * (protects against silent regressions in the single-match contract).
 */
function expectSingle(result: Resolution): ResolvedResource {
  if (result === null) {
    throw new Error("expected a ResolvedResource, got null");
  }
  if ("kind" in result && result.kind === "ambiguous") {
    throw new Error(
      `expected a single match, got ambiguous with ${result.matches.length} matches`,
    );
  }
  return result as ResolvedResource;
}

// Create a mock tagging client (the constructor is mocked, so it uses mockSend)
const taggingClient = new (
  await import("@aws-sdk/client-resource-groups-tagging-api")
).ResourceGroupsTaggingAPIClient({});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty IAM inventory. Specific IAM tests override.
  mockFetchManagedIamRoles.mockResolvedValue([]);
  mockGetManagedIamRoleByArn.mockResolvedValue(null);
});

describe("resolveResource", () => {
  describe("ARN input", () => {
    it("resolves an S3 bucket by ARN", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "environment", Value: "poc" },
            ],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "arn:aws:s3:::my-bucket",
        taggingClient,
        "us-east-1",
      );

      const single = expectSingle(result);
      expect(single.arn).toBe("arn:aws:s3:::my-bucket");
      expect(single.resourceType).toBe("AWS::S3::Bucket");
      expect(single.identifier).toBe("my-bucket");
      expect(single.tags["managed-by"]).toBe("assignee-ai");
    });

    it("resolves a Lambda function by ARN", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:lambda:us-east-1:123456789:function:my-func",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "arn:aws:lambda:us-east-1:123456789:function:my-func",
        taggingClient,
        "us-east-1",
      );

      const single = expectSingle(result);
      expect(single.resourceType).toBe("AWS::Lambda::Function");
      expect(single.identifier).toBe("my-func");
      expect(single.region).toBe("us-east-1");
    });

    it("returns null for ARN not tagged as managed", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "arn:aws:s3:::unmanaged-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).toBeNull();
    });

    // Wave 10 P1-1 / test-arch F2: closes the "no test exercises
    // resolveByArn against an IAM role ARN" gap. Wave 6 added the IAM
    // short-circuit branch but no test had ever invoked it via the
    // public resolveResource entrypoint. The IAM helper itself is
    // mocked — these tests pin the routing decision (does an IAM ARN
    // hit the IAM helper instead of falling through to RGTA?).
    it("resolves an IAM role by ARN via the IAM helper short-circuit", async () => {
      const iamArn = "arn:aws:iam::112233445566:role/my-app-role";
      mockGetManagedIamRoleByArn.mockResolvedValueOnce({
        arn: iamArn,
        roleName: "my-app-role",
        createdDate: "2026-04-07T18:00:00.000Z",
        tags: { "managed-by": "assignee-ai" },
      });

      const result = await resolveResource(iamArn, taggingClient, "us-east-1");

      expect(mockGetManagedIamRoleByArn).toHaveBeenCalledWith(iamArn);
      // IAM short-circuit must NOT fall through to RGTA scan.
      expect(mockSend).not.toHaveBeenCalled();
      const single = expectSingle(result);
      expect(single.resourceType).toBe("AWS::IAM::Role");
      expect(single.identifier).toBe("my-app-role");
      expect(single.arn).toBe(iamArn);
    });

    it("returns null when IAM role ARN does not resolve to a managed role", async () => {
      mockGetManagedIamRoleByArn.mockResolvedValueOnce(null);

      const result = await resolveResource(
        "arn:aws:iam::112233445566:role/external-app-role",
        taggingClient,
        "us-east-1",
      );

      expect(mockGetManagedIamRoleByArn).toHaveBeenCalled();
      // Must NOT fall through to RGTA — IAM ARNs are short-circuited
      // either way (RGTA does not return IAM roles, so the fallback
      // would only burn an API call for a guaranteed-empty result).
      expect(mockSend).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    // Wave 10 P0-1: GovCloud / China IAM role ARNs must take the same
    // short-circuit. The previous regex was `/^arn:aws:iam::\d+:role\//`
    // which silently rejected aws-us-gov / aws-cn ARNs as "not an IAM
    // role" and fell through to the RGTA scan (which also doesn't
    // return IAM roles), giving a guaranteed null even when the role
    // existed. Pin both partitions.
    it("routes a GovCloud (aws-us-gov) IAM role ARN to the IAM helper", async () => {
      const govArn = "arn:aws-us-gov:iam::112233445566:role/my-gov-role";
      mockGetManagedIamRoleByArn.mockResolvedValueOnce({
        arn: govArn,
        roleName: "my-gov-role",
        createdDate: "2026-04-07T18:00:00.000Z",
        tags: { "managed-by": "assignee-ai" },
      });

      const result = await resolveResource(
        govArn,
        taggingClient,
        "us-gov-west-1",
      );

      expect(mockGetManagedIamRoleByArn).toHaveBeenCalledWith(govArn);
      expect(mockSend).not.toHaveBeenCalled();
      const single = expectSingle(result);
      expect(single.resourceType).toBe("AWS::IAM::Role");
    });

    it("routes a China (aws-cn) IAM role ARN to the IAM helper", async () => {
      const cnArn = "arn:aws-cn:iam::112233445566:role/my-china-role";
      mockGetManagedIamRoleByArn.mockResolvedValueOnce({
        arn: cnArn,
        roleName: "my-china-role",
        createdDate: "2026-04-07T18:00:00.000Z",
        tags: { "managed-by": "assignee-ai" },
      });

      const result = await resolveResource(cnArn, taggingClient, "cn-north-1");

      expect(mockGetManagedIamRoleByArn).toHaveBeenCalledWith(cnArn);
      expect(mockSend).not.toHaveBeenCalled();
      const single = expectSingle(result);
      expect(single.resourceType).toBe("AWS::IAM::Role");
    });
  });

  describe("name input", () => {
    it("resolves a resource by name", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
          {
            ResourceARN: "arn:aws:lambda:us-east-1:123:function:other-func",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "my-bucket",
        taggingClient,
        "us-east-1",
      );

      const single = expectSingle(result);
      expect(single.arn).toBe("arn:aws:s3:::my-bucket");
      expect(single.identifier).toBe("my-bucket");
    });

    it("returns null for non-existent name", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::other-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "nonexistent",
        taggingClient,
        "us-east-1",
      );

      expect(result).toBeNull();
    });

    it("handles pagination", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::bucket-1",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: "next-page",
      });
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::target-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "target-bucket",
        taggingClient,
        "us-east-1",
      );

      const single = expectSingle(result);
      expect(single.arn).toBe("arn:aws:s3:::target-bucket");
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  // ── SSM Parameter regression suite (P0-3 destroy resolver fix) ─────────
  describe("SSM Parameter", () => {
    // Real-shaped ARNs harvested from actual AWS responses.
    const bareArn = "arn:aws:ssm:us-east-1:112233445566:parameter/smoke-test-x";
    const nestedArn =
      "arn:aws:ssm:us-east-1:112233445566:parameter/myapp/database/host";
    const secretArn =
      "arn:aws:ssm:us-east-1:112233445566:parameter/myapp/secret-token";
    const managedTags = [{ Key: "managed-by", Value: "assignee-ai" }];

    function mockTagging(arns: string[]): void {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: arns.map((arn) => ({
          ResourceARN: arn,
          Tags: managedTags,
        })),
        PaginationToken: undefined,
      });
    }

    it("resolves bare SSM parameter name (as typed from list output)", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "smoke-test-x",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.arn).toBe(bareArn);
      expect(single.resourceType).toBe("AWS::SSM::Parameter");
      // Canonical SSM identifier has a leading slash — CloudControl requires it.
      expect(single.identifier).toBe("/smoke-test-x");
    });

    it("resolves SSM parameter with leading slash (canonical form)", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "/smoke-test-x",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.arn).toBe(bareArn);
      expect(single.identifier).toBe("/smoke-test-x");
    });

    it("resolves nested SSM parameter path with leading slash", async () => {
      mockTagging([nestedArn]);
      const result = await resolveResource(
        "/myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.arn).toBe(nestedArn);
      expect(single.identifier).toBe("/myapp/database/host");
    });

    it("resolves nested SSM parameter path without leading slash", async () => {
      mockTagging([nestedArn]);
      const result = await resolveResource(
        "myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.arn).toBe(nestedArn);
      expect(single.identifier).toBe("/myapp/database/host");
    });

    it("resolves SSM parameter by full ARN", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(bareArn, taggingClient, "us-east-1");
      const single = expectSingle(result);
      expect(single.arn).toBe(bareArn);
      expect(single.resourceType).toBe("AWS::SSM::Parameter");
      expect(single.identifier).toBe("/smoke-test-x");
      expect(single.region).toBe("us-east-1");
    });

    it("resolves nested SSM parameter by full ARN", async () => {
      mockTagging([nestedArn]);
      const result = await resolveResource(
        nestedArn,
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.identifier).toBe("/myapp/database/host");
    });

    it("returns null when bare name has no matching managed resource", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "not-there",
        taggingClient,
        "us-east-1",
      );
      expect(result).toBeNull();
    });

    it("returns null when slash-prefixed name does not match any resource", async () => {
      mockTagging([bareArn]);
      const result = await resolveResource(
        "/nonexistent",
        taggingClient,
        "us-east-1",
      );
      expect(result).toBeNull();
    });

    it("picks the right SSM parameter among multiple managed resources", async () => {
      mockTagging([
        "arn:aws:ssm:us-east-1:112233445566:parameter/other-param",
        bareArn,
        "arn:aws:s3:::some-bucket",
      ]);
      const result = await resolveResource(
        "smoke-test-x",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.arn).toBe(bareArn);
    });

    it("resolves SSM parameter across pagination", async () => {
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN:
              "arn:aws:ssm:us-east-1:112233445566:parameter/first-page-param",
            Tags: managedTags,
          },
        ],
        PaginationToken: "next-page",
      });
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [{ ResourceARN: nestedArn, Tags: managedTags }],
        PaginationToken: undefined,
      });
      const result = await resolveResource(
        "/myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.arn).toBe(nestedArn);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("SecureString variant: managed-by tag is all that matters to the resolver", async () => {
      // SecureString parameters surface with the same ARN shape. The
      // resolver does not care about Type — it keys on ARN + managed tag.
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: secretArn,
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "ParameterType", Value: "SecureString" },
            ],
          },
        ],
        PaginationToken: undefined,
      });
      const result = await resolveResource(
        "/myapp/secret-token",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.arn).toBe(secretArn);
      expect(single.identifier).toBe("/myapp/secret-token");
      expect(single.tags["ParameterType"]).toBe("SecureString");
    });

    it("SecureString variant resolves by bare name", async () => {
      mockTagging([secretArn]);
      const result = await resolveResource(
        "myapp/secret-token",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.identifier).toBe("/myapp/secret-token");
    });

    it("StringList variant resolves by bare name", async () => {
      const stringListArn =
        "arn:aws:ssm:us-east-1:112233445566:parameter/app/feature-flags";
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: stringListArn,
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "ParameterType", Value: "StringList" },
            ],
          },
        ],
        PaginationToken: undefined,
      });
      const result = await resolveResource(
        "app/feature-flags",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.identifier).toBe("/app/feature-flags");
      expect(single.tags["ParameterType"]).toBe("StringList");
    });

    it("returns the SSM region extracted from the ARN", async () => {
      const euArn =
        "arn:aws:ssm:eu-west-1:112233445566:parameter/eu-app/config";
      mockTagging([euArn]);
      const result = await resolveResource(
        "/eu-app/config",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.region).toBe("eu-west-1");
    });

    it("does not confuse SSM parameter with an unrelated S3 bucket of the same basename", async () => {
      mockTagging([
        "arn:aws:s3:::database-host",
        "arn:aws:ssm:us-east-1:112233445566:parameter/myapp/database/host",
      ]);
      // "database/host" has a slash, so it cannot collide with the bucket name "database-host".
      const result = await resolveResource(
        "myapp/database/host",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.resourceType).toBe("AWS::SSM::Parameter");
    });

    it("does not match a slash-prefixed query against a non-SSM resource", async () => {
      // "/my-bucket" with a leading slash should not match an S3 bucket named "my-bucket".
      mockTagging(["arn:aws:s3:::my-bucket"]);
      const result = await resolveResource(
        "/my-bucket",
        taggingClient,
        "us-east-1",
      );
      expect(result).toBeNull();
    });

    it("deeply nested SSM path resolves by bare input", async () => {
      const deepArn =
        "arn:aws:ssm:us-east-1:112233445566:parameter/company/team/service/env/var";
      mockTagging([deepArn]);
      const result = await resolveResource(
        "company/team/service/env/var",
        taggingClient,
        "us-east-1",
      );
      const single = expectSingle(result);
      expect(single.identifier).toBe("/company/team/service/env/var");
    });
  });

  // ─── Story 48.6: multi-match disambiguation ───────────────────────────────
  describe("multi-match by name (Story 48.6)", () => {
    it("returns AmbiguousResolution when two managed resources share a name", async () => {
      // Real-shaped RGTA payload: two S3 buckets, both named via the
      // matchesName helper via extractIdentifierFromArn. Both are valid
      // candidates — the resolver MUST surface both, not silently first-pick.
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "env", Value: "prod" },
            ],
          },
          {
            ResourceARN: "arn:aws:s3:::my-bucket",
            Tags: [
              { Key: "managed-by", Value: "assignee-ai" },
              { Key: "env", Value: "staging" },
            ],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "my-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).not.toBeNull();
      expect(result && "kind" in result && result.kind).toBe("ambiguous");
      if (result && "kind" in result && result.kind === "ambiguous") {
        expect(result.input).toBe("my-bucket");
        expect(result.matches).toHaveLength(2);
        expect(result.matches[0]?.tags["env"]).toBe("prod");
        expect(result.matches[1]?.tags["env"]).toBe("staging");
      }
    });

    it("collects matches across pagination before deciding ambiguity", async () => {
      // Multi-match spanning pages — the resolver MUST finish pagination
      // before returning so an early-pagination first-pick bug cannot hide
      // a late-pagination duplicate. Real RGTA shape with PaginationToken.
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN:
              "arn:aws:lambda:us-east-1:112233445566:function:my-func",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: "page-2",
      });
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN:
              "arn:aws:lambda:us-west-2:112233445566:function:my-func",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "my-func",
        taggingClient,
        "us-east-1",
      );

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(result && "kind" in result && result.kind).toBe("ambiguous");
      if (result && "kind" in result && result.kind === "ambiguous") {
        expect(result.matches).toHaveLength(2);
        expect(result.matches.map((m) => m.region).sort()).toEqual([
          "us-east-1",
          "us-west-2",
        ]);
      }
    });

    it("returns a single ResolvedResource (not ambiguous) when only one match exists", async () => {
      // Fast-path regression: single hit must remain a plain ResolvedResource
      // so legacy callers that predate Story 48.6 don't accidentally take
      // the new union branch.
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [
          {
            ResourceARN: "arn:aws:s3:::only-bucket",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "only-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).not.toBeNull();
      expect(result && "kind" in result).toBe(false);
      const single = expectSingle(result);
      expect(single.arn).toBe("arn:aws:s3:::only-bucket");
    });
  });

  describe("non-managed resources", () => {
    it("returns null when resource has no managed-by tag", async () => {
      // The tagging API query already filters by managed-by=assignee-ai,
      // so non-managed resources won't appear in results
      mockSend.mockResolvedValueOnce({
        ResourceTagMappingList: [],
        PaginationToken: undefined,
      });

      const result = await resolveResource(
        "unmanaged-bucket",
        taggingClient,
        "us-east-1",
      );

      expect(result).toBeNull();
    });
  });
});
