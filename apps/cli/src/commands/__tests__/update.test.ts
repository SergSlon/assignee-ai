/**
 * Tests for `assignee update <target> --source <dir>` (new command).
 *
 * Coverage:
 * - Commander flag registration (every flag in the recon spec).
 * - arg-parser classifyTarget happy paths (UUID / ARN / bare bucket).
 * - arg-parser USAGE_ERROR when --source missing or empty.
 * - arg-parser comma-split for --invalidation-paths.
 * - resolveUpdateTarget: provision-store hit / ListDistributions fallback /
 *   multi-match disambiguation throw.
 * - runUpdate: end-to-end orchestration with all SDK calls mocked, asserting
 *   upload + invalidation + final summary.
 *
 * All mocks use realistic AWS shapes (per feedback_real_data_mocks_all_cases).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";

// ── Hoisted mock refs (must be declared before any imports of the SUT) ──
const { mockS3Send, mockCfSend } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockCfSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = mockS3Send;
  }
  function PutObjectCommand(input: unknown) {
    return { _type: "PutObjectCommand", ...(input as object) };
  }
  function ListObjectsV2Command(input: unknown) {
    return { _type: "ListObjectsV2Command", ...(input as object) };
  }
  function DeleteObjectsCommand(input: unknown) {
    return { _type: "DeleteObjectsCommand", ...(input as object) };
  }
  function PutBucketPolicyCommand(input: unknown) {
    return { _type: "PutBucketPolicyCommand", ...(input as object) };
  }
  function GetBucketPolicyCommand(input: unknown) {
    return { _type: "GetBucketPolicyCommand", ...(input as object) };
  }
  return {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    PutBucketPolicyCommand,
    GetBucketPolicyCommand,
  };
});

vi.mock("@aws-sdk/client-cloudfront", () => {
  class CloudFrontClient {
    send = mockCfSend;
  }
  function CreateInvalidationCommand(input: unknown) {
    return { _type: "CreateInvalidationCommand", input };
  }
  function GetInvalidationCommand(input: unknown) {
    return { _type: "GetInvalidationCommand", input };
  }
  function ListDistributionsCommand(input: unknown) {
    return { _type: "ListDistributionsCommand", input };
  }
  return {
    CloudFrontClient,
    CreateInvalidationCommand,
    GetInvalidationCommand,
    ListDistributionsCommand,
  };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  process.env["AWS_REGION"] = "us-east-1";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

import { updateCommand } from "../update.js";
import { classifyTarget, resolveUpdateArgs } from "../update/arg-parser.js";
import { resolveUpdateTarget } from "../update/resolve-target.js";
import { runUpdate } from "../update/action.js";
import { AssigneeError } from "@assignee/core";
import { ErrorCode } from "../../constants/errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Commander flag surface — every flag in the recon spec must register.
// ─────────────────────────────────────────────────────────────────────────────

describe("updateCommand — flag surface", () => {
  // `updateCommand` is a singleton; cloning its options shape via parseOptions
  // is awkward because the action runs. Instead we drive a fresh Command
  // with the same shape — mirrors the apply.test.ts convention.
  function createTestCommand(): Command {
    return new Command("update")
      .argument("<target>", "Bucket name, S3 ARN, or runId")
      .option("-s, --source <path>", "Source directory")
      .option("--delete", "Delete remote orphans")
      .option("--invalidation-paths <paths>", "Comma-separated paths")
      .option("--no-invalidation", "Skip invalidation")
      .option("--wait", "Wait for completion")
      .option("-y, --yes", "Skip prompt")
      .option("-o, --output <format>", "Output format", "text")
      .option("--json", "Shorthand for --output json");
  }

  it("registers --source / -s", () => {
    const cmd = createTestCommand();
    const opt = cmd.options.find((o) => o.long === "--source");
    expect(opt?.long).toBe("--source");
    expect(opt?.short).toBe("-s");
  });

  it("registers --delete / --invalidation-paths / --no-invalidation / --wait", () => {
    const cmd = createTestCommand();
    expect(cmd.options.find((o) => o.long === "--delete")).toBeDefined();
    expect(
      cmd.options.find((o) => o.long === "--invalidation-paths"),
    ).toBeDefined();
    expect(
      cmd.options.find((o) => o.long === "--no-invalidation"),
    ).toBeDefined();
    expect(cmd.options.find((o) => o.long === "--wait")).toBeDefined();
  });

  it("registers -y / --yes and -o / --output / --json", () => {
    const cmd = createTestCommand();
    expect(cmd.options.find((o) => o.long === "--yes")?.short).toBe("-y");
    expect(cmd.options.find((o) => o.long === "--output")?.short).toBe("-o");
    expect(cmd.options.find((o) => o.long === "--json")).toBeDefined();
  });

  it("the real updateCommand exposes all flags", () => {
    const names = updateCommand.options.map((o) => o.long);
    expect(names).toContain("--source");
    expect(names).toContain("--delete");
    expect(names).toContain("--invalidation-paths");
    expect(names).toContain("--no-invalidation");
    expect(names).toContain("--wait");
    expect(names).toContain("--yes");
    expect(names).toContain("--output");
    expect(names).toContain("--json");
  });

  it("requires <target> argument (Commander argument config)", () => {
    // commander 13 exposes .registeredArguments; older alias was ._args.
    const args =
      (
        updateCommand as unknown as {
          registeredArguments?: Array<{ _name?: string; required?: boolean }>;
        }
      ).registeredArguments ?? [];
    expect(args).toHaveLength(1);
    expect(args[0]?._name).toBe("target");
    expect(args[0]?.required).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyTarget — runId / arn / bucket discrimination.
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyTarget", () => {
  it("recognises a v4 UUID as a runId", () => {
    const out = classifyTarget("3b1f5d9e-2c7a-4d6f-9b9c-1a2b3c4d5e6f");
    expect(out.kind).toBe("runId");
    expect(out.bucketName).toBe("");
  });

  it("strips arn:aws:s3::: prefix and returns the bucket name", () => {
    const out = classifyTarget("arn:aws:s3:::my-marketing-site");
    expect(out.kind).toBe("arn");
    expect(out.bucketName).toBe("my-marketing-site");
  });

  it("supports GovCloud partition: arn:aws-us-gov:s3:::", () => {
    const out = classifyTarget("arn:aws-us-gov:s3:::gov-bucket");
    expect(out.kind).toBe("arn");
    expect(out.bucketName).toBe("gov-bucket");
  });

  it("treats any other string as a bare bucket name", () => {
    expect(classifyTarget("my-bucket")).toEqual({
      kind: "bucket",
      bucketName: "my-bucket",
    });
  });

  it("trims whitespace before classification", () => {
    expect(classifyTarget("  my-bucket  ").bucketName).toBe("my-bucket");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveUpdateArgs — flag/positional validation.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveUpdateArgs", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "update-args-test-"));
    writeFileSync(join(tmpDir, "index.html"), "<h1>hello</h1>");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("throws USAGE_ERROR when target is missing", () => {
    expect(() => resolveUpdateArgs(undefined, { source: tmpDir })).toThrow(
      AssigneeError,
    );
    try {
      resolveUpdateArgs(undefined, { source: tmpDir });
    } catch (err) {
      expect((err as AssigneeError).code).toBe(ErrorCode.USAGE_ERROR);
    }
  });

  it("throws USAGE_ERROR when --source is missing", () => {
    expect(() => resolveUpdateArgs("my-bucket", {})).toThrow(AssigneeError);
    try {
      resolveUpdateArgs("my-bucket", {});
    } catch (err) {
      expect((err as AssigneeError).code).toBe(ErrorCode.USAGE_ERROR);
    }
  });

  it("throws USAGE_ERROR when --source is empty string", () => {
    expect(() => resolveUpdateArgs("my-bucket", { source: "   " })).toThrow(
      AssigneeError,
    );
  });

  it("defaults invalidationPaths to ['/*'] when --invalidation-paths is absent", () => {
    const args = resolveUpdateArgs("my-bucket", { source: tmpDir });
    expect(args.invalidationPaths).toEqual(["/*"]);
  });

  it("comma-splits --invalidation-paths and trims each entry", () => {
    const args = resolveUpdateArgs("my-bucket", {
      source: tmpDir,
      invalidationPaths: "/index.html, /css/*, /js/main.js",
    });
    expect(args.invalidationPaths).toEqual([
      "/index.html",
      "/css/*",
      "/js/main.js",
    ]);
  });

  it("drops whitespace-only entries from --invalidation-paths but keeps the valid ones", () => {
    const args = resolveUpdateArgs("my-bucket", {
      source: tmpDir,
      invalidationPaths: " ,/index.html,  ,/css/*",
    });
    expect(args.invalidationPaths).toEqual(["/index.html", "/css/*"]);
  });

  it("throws USAGE_ERROR when --invalidation-paths is empty string", () => {
    expect(() =>
      resolveUpdateArgs("my-bucket", {
        source: tmpDir,
        invalidationPaths: "",
      }),
    ).toThrow(/--invalidation-paths cannot be empty/);
    try {
      resolveUpdateArgs("my-bucket", {
        source: tmpDir,
        invalidationPaths: "",
      });
    } catch (err) {
      expect((err as AssigneeError).code).toBe(ErrorCode.USAGE_ERROR);
    }
  });

  it("throws USAGE_ERROR when --invalidation-paths is just commas", () => {
    expect(() =>
      resolveUpdateArgs("my-bucket", {
        source: tmpDir,
        invalidationPaths: ",",
      }),
    ).toThrow(/--invalidation-paths cannot be empty/);
  });

  it("throws USAGE_ERROR when --invalidation-paths is whitespace + commas only", () => {
    expect(() =>
      resolveUpdateArgs("my-bucket", {
        source: tmpDir,
        invalidationPaths: " , , ",
      }),
    ).toThrow(/--invalidation-paths cannot be empty/);
  });

  it("normalises --json → jsonMode true", () => {
    const a = resolveUpdateArgs("my-bucket", { source: tmpDir, json: true });
    expect(a.jsonMode).toBe(true);
  });

  it("normalises --output json → jsonMode true", () => {
    const a = resolveUpdateArgs("my-bucket", {
      source: tmpDir,
      output: "json",
    });
    expect(a.jsonMode).toBe(true);
  });

  it("propagates --delete, --no-invalidation, --wait, --yes flags", () => {
    const a = resolveUpdateArgs("my-bucket", {
      source: tmpDir,
      delete: true,
      noInvalidation: true,
      wait: true,
      yes: true,
    });
    expect(a.deleteOrphans).toBe(true);
    expect(a.noInvalidation).toBe(true);
    expect(a.wait).toBe(true);
    expect(a.yes).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveUpdateTarget — provision-store + ListDistributions fallback.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveUpdateTarget", () => {
  const RUN_ID = "11111111-2222-4333-8444-555555555555";

  it("returns bucket + region + linked distribution when both are in the provision store", async () => {
    const target = await resolveUpdateTarget("marketing-site", {
      skipCloudFrontLookup: true,
      loadProvisions: async () => [
        {
          keyKind: "arn" as const,
          key: "arn:aws:s3:::marketing-site",
          resourceType: "AWS::S3::Bucket",
          region: "eu-west-1",
          createdDate: "2026-04-01T00:00:00Z",
          estimatedMonthlyCost: "$0.50",
          runId: RUN_ID,
        },
        {
          keyKind: "primaryIdentifier" as const,
          key: "E1A2B3C4D5E6F7",
          resourceType: "AWS::CloudFront::Distribution",
          region: "us-east-1",
          createdDate: "2026-04-01T00:00:00Z",
          estimatedMonthlyCost: "$0.10",
          runId: RUN_ID,
        },
      ],
    });

    expect(target.bucketName).toBe("marketing-site");
    expect(target.region).toBe("eu-west-1");
    expect(target.distributionId).toBe("E1A2B3C4D5E6F7");
  });

  it("resolves by runId and finds the paired S3 bucket entry", async () => {
    const target = await resolveUpdateTarget(RUN_ID, {
      skipCloudFrontLookup: true,
      loadProvisions: async () => [
        {
          keyKind: "arn" as const,
          key: "arn:aws:s3:::my-runid-bucket",
          resourceType: "AWS::S3::Bucket",
          region: "us-west-2",
          createdDate: "2026-04-01T00:00:00Z",
          estimatedMonthlyCost: "$0.50",
          runId: RUN_ID,
        },
      ],
    });
    expect(target.bucketName).toBe("my-runid-bucket");
    expect(target.region).toBe("us-west-2");
  });

  it("throws USAGE_ERROR when runId has no matching S3 bucket entry", async () => {
    await expect(
      resolveUpdateTarget(RUN_ID, {
        skipCloudFrontLookup: true,
        loadProvisions: async () => [], // no records at all
      }),
    ).rejects.toThrow(AssigneeError);
  });

  it("falls back to ListDistributions when no sibling distribution is in the store", async () => {
    const target = await resolveUpdateTarget("orphan-bucket", {
      loadProvisions: async () => [], // no provision records at all
      listDistributions: async () => [
        {
          Id: "E9X8Y7Z6W5V4U3",
          ARN: "arn:aws:cloudfront::112233445566:distribution/E9X8Y7Z6W5V4U3",
          DomainName: "d12345abcdefg.cloudfront.net",
          Origins: {
            Items: [{ DomainName: "orphan-bucket.s3.us-east-1.amazonaws.com" }],
          },
        },
      ],
    });
    expect(target.distributionId).toBe("E9X8Y7Z6W5V4U3");
    expect(target.cloudFrontDomainName).toBe("d12345abcdefg.cloudfront.net");
  });

  it("throws USAGE_ERROR with candidate list when 2+ distributions front the same bucket", async () => {
    await expect(
      resolveUpdateTarget("shared-bucket", {
        loadProvisions: async () => [],
        listDistributions: async () => [
          {
            Id: "EAAAA0000111",
            DomainName: "da.cloudfront.net",
            Origins: {
              Items: [
                { DomainName: "shared-bucket.s3.us-east-1.amazonaws.com" },
              ],
            },
          },
          {
            Id: "EBBBB0000222",
            DomainName: "db.cloudfront.net",
            Origins: {
              Items: [{ DomainName: "shared-bucket.s3.amazonaws.com" }],
            },
          },
        ],
      }),
    ).rejects.toThrow(/2 CloudFront distributions front s3:\/\/shared-bucket/);
  });

  it("returns no distributionId when ListDistributions finds zero matches (caller decides)", async () => {
    const target = await resolveUpdateTarget("lonely-bucket", {
      loadProvisions: async () => [],
      listDistributions: async () => [
        {
          Id: "EUNRELATED",
          DomainName: "du.cloudfront.net",
          Origins: {
            Items: [
              { DomainName: "some-other-bucket.s3.us-east-1.amazonaws.com" },
            ],
          },
        },
      ],
    });
    expect(target.distributionId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runUpdate — end-to-end orchestration with all SDK calls mocked.
// ─────────────────────────────────────────────────────────────────────────────

describe("runUpdate — end-to-end", () => {
  const RUN_ID = "11111111-2222-4333-8444-555555555555";

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "update-e2e-"));
    writeFileSync(join(tmpDir, "index.html"), "<h1>new</h1>");
    writeFileSync(join(tmpDir, "styles.css"), "body { color: red; }");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  /**
   * Build a fresh ResolveOptions stub that fakes the provision store
   * + ListDistributions for one e2e test invocation. No global mocks
   * touched — every value is injected via the action's `resolveOptions`
   * test seam.
   */
  function fakeResolveOptions(opts?: {
    cloudFrontDomainName?: string;
    noDistribution?: boolean;
  }): import("../update/resolve-target.js").ResolveOptions {
    const domain = opts?.cloudFrontDomainName ?? "d12345abcdefg.cloudfront.net";
    return {
      loadProvisions: async () => [
        {
          keyKind: "arn" as const,
          key: "arn:aws:s3:::e2e-bucket",
          resourceType: "AWS::S3::Bucket",
          region: "us-east-1",
          createdDate: "2026-04-01T00:00:00Z",
          estimatedMonthlyCost: "$0.50",
          runId: RUN_ID,
        },
        ...(opts?.noDistribution
          ? []
          : [
              {
                keyKind: "primaryIdentifier" as const,
                key: "E1A2B3C4D5E6F7",
                resourceType: "AWS::CloudFront::Distribution",
                region: "us-east-1",
                createdDate: "2026-04-01T00:00:00Z",
                estimatedMonthlyCost: "$0.10",
                runId: RUN_ID,
              },
            ]),
      ],
      loadRawProvisions: async () => [
        {
          runId: RUN_ID,
          resourceType: "AWS::S3::Bucket",
          resourceArn: "arn:aws:s3:::e2e-bucket",
          region: "us-east-1",
        },
        ...(opts?.noDistribution
          ? []
          : [
              {
                runId: RUN_ID,
                resourceType: "AWS::CloudFront::Distribution",
                resourceArn: "E1A2B3C4D5E6F7",
                region: "us-east-1",
                cloudFrontDomainName: domain,
              },
            ]),
      ],
      // ListDistributions fallback should never run when the provision
      // store carries the distribution — wire it to throw so any
      // accidental call fails loudly.
      listDistributions: async () => {
        throw new Error("ListDistributions should not be called in this test");
      },
    };
  }

  it("uploads files, invalidates CloudFront, returns success summary", async () => {
    // PUT × 2 (index.html + styles.css).
    mockS3Send.mockResolvedValue({
      ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    // CreateInvalidation response.
    mockCfSend.mockResolvedValueOnce({
      Invalidation: {
        Id: "I3OK4N7R6Z9W2",
        Status: "InProgress",
      },
      $metadata: { httpStatusCode: 201, requestId: "req-create-inv" },
    });

    const result = await runUpdate(
      "e2e-bucket",
      { source: tmpDir, yes: true },
      {
        confirm: async () => true,
        resolveOptions: fakeResolveOptions(),
      },
    );

    expect(result.target.bucketName).toBe("e2e-bucket");
    expect(result.target.distributionId).toBe("E1A2B3C4D5E6F7");
    expect(result.target.cloudFrontDomainName).toBe(
      "d12345abcdefg.cloudfront.net",
    );
    expect(result.upload.uploaded).toBe(2);
    expect(result.upload.failed).toBe(0);
    expect(result.upload.deleted).toBe(0);
    expect(result.invalidation?.invalidationId).toBe("I3OK4N7R6Z9W2");
    expect(result.invalidation?.status).toBe("InProgress");
  });

  it("respects --no-invalidation and skips CloudFront entirely", async () => {
    mockS3Send.mockResolvedValue({
      ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });

    const result = await runUpdate(
      "e2e-bucket",
      { source: tmpDir, noInvalidation: true, yes: true },
      { resolveOptions: fakeResolveOptions() },
    );

    expect(result.invalidation).toBeUndefined();
    expect(mockCfSend).not.toHaveBeenCalled();
  });

  it("polls for completion when --wait is set", async () => {
    mockS3Send.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    mockCfSend
      .mockResolvedValueOnce({
        Invalidation: { Id: "I-WAIT", Status: "InProgress" },
        $metadata: { httpStatusCode: 201, requestId: "req-create" },
      })
      // First poll: Completed.
      .mockResolvedValueOnce({
        Invalidation: {
          Id: "I-WAIT",
          Status: "Completed",
          CreateTime: new Date("2026-05-09T12:02:00Z"),
        },
        $metadata: { httpStatusCode: 200, requestId: "req-get" },
      });

    const result = await runUpdate(
      "e2e-bucket",
      { source: tmpDir, wait: true, yes: true },
      { resolveOptions: fakeResolveOptions() },
    );

    expect(result.invalidation?.invalidationId).toBe("I-WAIT");
    expect(result.invalidation?.status).toBe("Completed");
  });

  it("throws USAGE_ERROR when --no-invalidation is OFF but no distribution can be resolved", async () => {
    // ListDistributions fallback returns zero matches → resolver
    // leaves distributionId undefined. Action layer then throws.
    await expect(
      runUpdate(
        "lonely-bucket",
        { source: tmpDir, yes: true },
        {
          resolveOptions: {
            loadProvisions: async () => [],
            loadRawProvisions: async () => [],
            listDistributions: async () => [],
          },
        },
      ),
    ).rejects.toThrow(/No CloudFront distribution linked/);
  });

  it("USER_CANCELLED when confirm callback returns false", async () => {
    // The confirm gate fires when not --yes and stdin is a TTY. We force
    // stdin.isTTY for this test, then make confirm return false.
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      await expect(
        runUpdate(
          "e2e-bucket",
          { source: tmpDir },
          {
            confirm: async () => false,
            resolveOptions: fakeResolveOptions(),
          },
        ),
      ).rejects.toThrow(AssigneeError);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTty,
        configurable: true,
      });
    }
  });

  it("warns to stderr when --wait and --no-invalidation are both set", async () => {
    mockS3Send.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      await runUpdate(
        "e2e-bucket",
        { source: tmpDir, wait: true, noInvalidation: true, yes: true },
        { resolveOptions: fakeResolveOptions() },
      );
    } finally {
      process.stderr.write = origWrite;
    }
    const combined = writes.join("");
    expect(combined).toContain(
      "Warning: --wait is ignored when --no-invalidation is set",
    );
  });

  it("does NOT warn when only --wait is set (invalidation runs)", async () => {
    mockS3Send.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    mockCfSend
      .mockResolvedValueOnce({
        Invalidation: { Id: "I-WAIT2", Status: "InProgress" },
        $metadata: { httpStatusCode: 201, requestId: "req-create" },
      })
      .mockResolvedValueOnce({
        Invalidation: {
          Id: "I-WAIT2",
          Status: "Completed",
          CreateTime: new Date("2026-05-09T12:02:00Z"),
        },
        $metadata: { httpStatusCode: 200, requestId: "req-get" },
      });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      await runUpdate(
        "e2e-bucket",
        { source: tmpDir, wait: true, yes: true },
        { resolveOptions: fakeResolveOptions() },
      );
    } finally {
      process.stderr.write = origWrite;
    }
    const combined = writes.join("");
    expect(combined).not.toContain(
      "Warning: --wait is ignored when --no-invalidation is set",
    );
  });

  it("suppresses the --wait/--no-invalidation warn in JSON mode", async () => {
    mockS3Send.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      await runUpdate(
        "e2e-bucket",
        {
          source: tmpDir,
          wait: true,
          noInvalidation: true,
          yes: true,
          json: true,
        },
        { resolveOptions: fakeResolveOptions() },
      );
    } finally {
      process.stderr.write = origWrite;
    }
    const combined = writes.join("");
    expect(combined).not.toContain(
      "Warning: --wait is ignored when --no-invalidation is set",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Commander binding contract — `--no-invalidation` populates
// `opts.invalidation = false`, NOT `opts.noInvalidation`. This locks the
// CLI-vs-action shape mismatch that the in-process tests above can't catch.
// ─────────────────────────────────────────────────────────────────────────────

describe("update Commander binding", () => {
  /**
   * Build a fresh `update` command identical to the real one but with
   * a stub `.action` so we can assert exactly what Commander hands to
   * `updateAction`. Mirrors the `createTestCommand()` pattern used by
   * the flag-surface block above.
   */
  function buildCommandWithSpy(
    spy: (target: string, opts: Record<string, unknown>) => void,
  ): Command {
    return new Command("update")
      .argument("<target>")
      .option("-s, --source <path>", "Source directory")
      .option("--delete", "Delete remote orphans")
      .option("--invalidation-paths <paths>", "Comma-separated paths")
      .option("--no-invalidation", "Skip invalidation")
      .option("--wait", "Wait for completion")
      .option("-y, --yes", "Skip prompt")
      .option("-o, --output <format>", "Output format", "text")
      .option("--json", "Shorthand for --output json")
      .action(spy);
  }

  it("`--no-invalidation` produces opts.invalidation === false (no `noInvalidation` key)", async () => {
    let captured: Record<string, unknown> | undefined;
    const cmd = buildCommandWithSpy((_t, opts) => {
      captured = opts;
    });
    await cmd.parseAsync(
      [
        "node",
        "assignee",
        "update",
        "my-bucket",
        "--source",
        "/tmp/fake",
        "--no-invalidation",
        "--yes",
      ],
      { from: "user" },
    );
    expect(captured).toBeDefined();
    expect(captured?.["invalidation"]).toBe(false);
    // Commander never populates the `noInvalidation` key for `--no-X` flags.
    expect(captured?.["noInvalidation"]).toBeUndefined();
  });

  it("absence of `--no-invalidation` produces opts.invalidation === true (default)", async () => {
    let captured: Record<string, unknown> | undefined;
    const cmd = buildCommandWithSpy((_t, opts) => {
      captured = opts;
    });
    await cmd.parseAsync(
      [
        "node",
        "assignee",
        "update",
        "my-bucket",
        "--source",
        "/tmp/fake",
        "--yes",
      ],
      { from: "user" },
    );
    expect(captured?.["invalidation"]).toBe(true);
  });

  it("resolveUpdateArgs maps Commander's invalidation:false → noInvalidation:true", () => {
    // This is the contract the action layer relies on. Commander
    // hands us `{ invalidation: false }`; we must surface
    // `noInvalidation: true` through the resolved args.
    const tmp = mkdtempSync(join(tmpdir(), "update-binding-"));
    writeFileSync(join(tmp, "index.html"), "<h1>x</h1>");
    try {
      const args = resolveUpdateArgs("my-bucket", {
        source: tmp,
        invalidation: false,
      });
      expect(args.noInvalidation).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveUpdateArgs maps Commander's invalidation:true → noInvalidation:false", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-binding-"));
    writeFileSync(join(tmp, "index.html"), "<h1>x</h1>");
    try {
      const args = resolveUpdateArgs("my-bucket", {
        source: tmp,
        invalidation: true,
      });
      expect(args.noInvalidation).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolveUpdateArgs treats `noInvalidation: true` as a synonym (programmatic callers)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-binding-"));
    writeFileSync(join(tmp, "index.html"), "<h1>x</h1>");
    try {
      const args = resolveUpdateArgs("my-bucket", {
        source: tmp,
        noInvalidation: true,
      });
      expect(args.noInvalidation).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("default (neither flag set) → noInvalidation: false (invalidation runs)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-binding-"));
    writeFileSync(join(tmp, "index.html"), "<h1>x</h1>");
    try {
      const args = resolveUpdateArgs("my-bucket", { source: tmp });
      expect(args.noInvalidation).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CloudFront origin domain — China partition (`.amazonaws.com.cn`).
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveUpdateTarget — China partition origin matching", () => {
  it("matches a `<bucket>.s3.<region>.amazonaws.com.cn` origin", async () => {
    const target = await resolveUpdateTarget("cn-bucket", {
      loadProvisions: async () => [],
      loadRawProvisions: async () => [],
      listDistributions: async () => [
        {
          Id: "ECN1234567890",
          ARN: "arn:aws-cn:cloudfront::112233445566:distribution/ECN1234567890",
          DomainName: "d-cn.cloudfront.cn",
          Origins: {
            Items: [{ DomainName: "cn-bucket.s3.cn-north-1.amazonaws.com.cn" }],
          },
        },
      ],
    });
    expect(target.distributionId).toBe("ECN1234567890");
    expect(target.cloudFrontDomainName).toBe("d-cn.cloudfront.cn");
  });

  it("matches the dualstack China form too", async () => {
    const target = await resolveUpdateTarget("cn-bucket", {
      loadProvisions: async () => [],
      loadRawProvisions: async () => [],
      listDistributions: async () => [
        {
          Id: "ECN0000000111",
          DomainName: "d2-cn.cloudfront.cn",
          Origins: {
            Items: [
              {
                DomainName:
                  "cn-bucket.s3.dualstack.cn-northwest-1.amazonaws.com.cn",
              },
            ],
          },
        },
      ],
    });
    expect(target.distributionId).toBe("ECN0000000111");
  });
});
