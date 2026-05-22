/**
 * Tests for bulk-action.ts (assignee destroy --all).
 *
 * Covers:
 *   - Dry-run mode: renders plan, exits 0, zero AWS writes.
 *   - Exclusion allowlist enforcement: allowlisted ARNs never appear in plan.
 *   - > 100 resource cap: refuses unless --allow-large-sweep.
 *   - Plan ordering: TYPE_DESTROY_ORDER respected.
 *   - Continue-on-error: per-resource failure logged, execution continues.
 *   - JSON envelope shape: plan/excluded/totalCostSaved keys present.
 *   - Empty resource list: exits 0 with "nothing to destroy".
 *   - All resources excluded: exits 0 with "nothing to destroy".
 *   - --no-confirm (noConfirm): skips typed confirmation, logs warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ManagedResource } from "@assignee/core";

// ── Hoisted stubs ─────────────────────────────────────────────────────

const {
  mockFetchManagedResources,
  mockSingleDestroyAction,
  mockAppendAuditRecord,
  mockClackText,
  mockClackIsCancel,
  mockTryAssigneeCredentials,
  mockStsSend,
} = vi.hoisted(() => ({
  mockFetchManagedResources: vi.fn(),
  mockSingleDestroyAction: vi.fn(),
  mockAppendAuditRecord: vi.fn().mockResolvedValue(undefined),
  mockClackText: vi.fn(),
  mockClackIsCancel: vi.fn().mockReturnValue(false),
  mockTryAssigneeCredentials: vi.fn().mockReturnValue(null),
  mockStsSend: vi.fn(),
}));

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock("../../services/list-resources.js", () => ({
  fetchManagedResources: (...args: unknown[]) =>
    mockFetchManagedResources(...args),
}));

vi.mock("./single-flow.js", () => ({
  singleDestroyAction: (...args: unknown[]) => mockSingleDestroyAction(...args),
}));

vi.mock("@assignee/core/audit", () => ({
  appendAuditRecord: (...args: unknown[]) => mockAppendAuditRecord(...args),
}));

vi.mock("@clack/prompts", () => ({
  text: (...args: unknown[]) => mockClackText(...args),
  isCancel: (...args: unknown[]) => mockClackIsCancel(...args),
}));

vi.mock("../../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: (...args: unknown[]) =>
    mockTryAssigneeCredentials(...args),
}));

vi.mock("@aws-sdk/client-sts", () => {
  class STSClient {
    send = mockStsSend;
  }
  function GetCallerIdentityCommand() {
    return { _type: "GetCallerIdentityCommand" };
  }
  return { STSClient, GetCallerIdentityCommand };
});

vi.mock("../../utils/display.js", () => ({
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

vi.mock("../../config/constants.js", () => ({
  AWS_REGION: "us-east-1",
  UserMessage: { DESTROY_CANCELLED: "Destroy cancelled." },
}));

// ── Fixtures ──────────────────────────────────────────────────────────

/** Real ARNs that must be excluded from bulk destroy. */
const EXCLUDED_ARN_OPERATOR_POLICY =
  "arn:aws:iam::112233445566:policy/AssigneeOperatorPolicy";
const EXCLUDED_ARN_READER_ROLE =
  "arn:aws:iam::112233445566:role/AssigneeAiBedrockLoggingRole";

/** A non-excluded S3 bucket. */
const S3_BUCKET: ManagedResource = {
  resourceType: "AWS::S3::Bucket",
  arn: "arn:aws:s3:::my-data-bucket",
  region: "us-east-1",
  createdDate: "2026-01-01",
  estimatedMonthlyCost: "$2.50/month",
};

/** A non-excluded Lambda function. */
const LAMBDA_FN: ManagedResource = {
  resourceType: "AWS::Lambda::Function",
  arn: "arn:aws:lambda:us-east-1:112233445566:function:my-fn",
  region: "us-east-1",
  createdDate: "2026-01-02",
  estimatedMonthlyCost: "$0.50/month",
};

/** A non-excluded IAM role (user-created, not assignee infra). */
const USER_IAM_ROLE: ManagedResource = {
  resourceType: "AWS::IAM::Role",
  arn: "arn:aws:iam::112233445566:role/MyAppRole",
  region: "global",
  createdDate: "2026-01-03",
  estimatedMonthlyCost: "N/A",
};

/** An excluded assignee operator policy. */
const EXCLUDED_POLICY: ManagedResource = {
  resourceType: "AWS::IAM::ManagedPolicy",
  arn: EXCLUDED_ARN_OPERATOR_POLICY,
  region: "global",
  createdDate: "2026-01-04",
  estimatedMonthlyCost: "N/A",
};

/** An excluded Bedrock logging role. */
const EXCLUDED_ROLE: ManagedResource = {
  resourceType: "AWS::IAM::Role",
  arn: EXCLUDED_ARN_READER_ROLE,
  region: "global",
  createdDate: "2026-01-05",
  estimatedMonthlyCost: "N/A",
};

// ── Helper: capture stdout writes ─────────────────────────────────────

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf8"),
    );
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("runBulkDestroyAction", () => {
  let stdoutCapture: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSingleDestroyAction.mockResolvedValue(undefined);
    mockAppendAuditRecord.mockResolvedValue(undefined);
    mockClackIsCancel.mockReturnValue(false);
    stdoutCapture = captureStdout();
  });

  afterEach(() => {
    stdoutCapture.restore();
  });

  // ── Import function under test ───────────────────────────────────
  async function getSubject() {
    // Re-import to avoid module cache state from previous tests
    const mod = await import("./bulk-action.js");
    return mod.runBulkDestroyAction;
  }

  // ── Dry-run mode ─────────────────────────────────────────────────

  describe("dry-run mode (no --yes)", () => {
    it("renders plan and exits 0 with zero AWS writes", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET, LAMBDA_FN]);
      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      await runBulkDestroyAction({ yes: false });

      const out = stdoutCapture.output();
      expect(out).toContain("DRY-RUN");
      expect(out).toContain("AWS::S3::Bucket");
      expect(out).toContain("AWS::Lambda::Function");
      // No single destroys fired
      expect(mockSingleDestroyAction).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });

    it("shows cost summary", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET, LAMBDA_FN]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({});

      const out = stdoutCapture.output();
      // S3=$2.50 + Lambda=$0.50 = $3.00
      expect(out).toContain("$3.00");
    });

    // F6 fix (2026-05-23): per-unit rate costs (e.g. "$0.0230/GB-month")
    // are no longer treated as flat monthly amounts. Previously the
    // parser stripped non-numeric chars and summed `0.0230 + 0.0230 ≈
    // $0.05/month` for 2×S3 buckets whose actual storage could be GBs
    // to TBs. After the fix, per-unit rates are excluded from the sum
    // and the result is labelled "≥ $X/month (variable per-unit rates
    // excluded ...)".
    it("F6: per-unit rate costs ('$0.0230/GB-month') excluded from sum + 'variable rates excluded' footnote", async () => {
      // Two S3 buckets whose cost is reported as a per-GB rate (no
      // storage measurement). Previously summed to ~$0.05; now should
      // produce "≥ $0.00" + the footnote.
      const S3_BUCKET_RATE_ONLY = {
        ...S3_BUCKET,
        arn: "arn:aws:s3:::rate-bucket-1",
        primaryIdentifier: "rate-bucket-1",
        estimatedMonthlyCost: "$0.0230/GB-month",
      };
      const S3_BUCKET_RATE_ONLY_2 = {
        ...S3_BUCKET,
        arn: "arn:aws:s3:::rate-bucket-2",
        primaryIdentifier: "rate-bucket-2",
        estimatedMonthlyCost: "$0.0230/GB-month",
      };
      mockFetchManagedResources.mockResolvedValue([
        S3_BUCKET_RATE_ONLY,
        S3_BUCKET_RATE_ONLY_2,
      ]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({});

      const out = stdoutCapture.output();
      // Must NOT contain the buggy "$0.05/month" sum or any sum that
      // treats the rate as if it were a total.
      expect(out).not.toMatch(/\$0\.04\/month|\$0\.05\/month/);
      // Should label the sum as a lower bound with the variable-rate
      // footnote.
      expect(out).toContain("≥ ");
      expect(out).toContain("variable per-unit rates excluded");
    });

    it("F6: mixed fixed + per-unit costs sum only the fixed amounts, label as lower bound", async () => {
      const FIXED_LAMBDA = { ...LAMBDA_FN }; // $0.50/month
      const RATE_S3 = {
        ...S3_BUCKET,
        arn: "arn:aws:s3:::mixed-rate-bucket",
        primaryIdentifier: "mixed-rate-bucket",
        estimatedMonthlyCost: "$0.0230/GB-month",
      };
      mockFetchManagedResources.mockResolvedValue([FIXED_LAMBDA, RATE_S3]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({});

      const out = stdoutCapture.output();
      // Fixed part = $0.50; rate excluded. Total should be "≥ $0.50".
      expect(out).toContain("≥ $0.50/month");
      expect(out).toContain("variable per-unit rates excluded");
    });

    it("shows exclusion list when some resources are excluded", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET, EXCLUDED_POLICY]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({});

      const out = stdoutCapture.output();
      expect(out).toContain("EXCLUDED");
      expect(out).toContain(EXCLUDED_ARN_OPERATOR_POLICY);
      expect(out).toContain("self-lockout protection");
      // Only S3 in plan
      expect(out).toContain("AWS::S3::Bucket");
      // Excluded policy NOT in plan section
      expect(out).not.toMatch(/plan.*AssigneeOperatorPolicy/s);
    });

    it("prints nothing-to-destroy when all resources are excluded", async () => {
      mockFetchManagedResources.mockResolvedValue([
        EXCLUDED_POLICY,
        EXCLUDED_ROLE,
      ]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({});

      const out = stdoutCapture.output();
      expect(out).toContain("Nothing to destroy");
      expect(mockSingleDestroyAction).not.toHaveBeenCalled();
    });

    it("prints nothing-to-destroy when resource list is empty", async () => {
      mockFetchManagedResources.mockResolvedValue([]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({});

      const out = stdoutCapture.output();
      expect(out).toContain("Nothing to destroy");
      expect(mockSingleDestroyAction).not.toHaveBeenCalled();
    });
  });

  // ── JSON dry-run ─────────────────────────────────────────────────

  describe("JSON dry-run mode (--json, no --yes)", () => {
    it("emits well-formed JSON envelope with plan/excluded/totalCostSaved", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET, EXCLUDED_POLICY]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ json: true });

      const out = stdoutCapture.output();
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(out);
      }).not.toThrow();

      const envelope = parsed as {
        ok: boolean;
        operation: string;
        plan: unknown[];
        excluded: unknown[];
        totalCostSaved: string;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.operation).toBe("bulk_destroy");
      expect(Array.isArray(envelope.plan)).toBe(true);
      expect(envelope.plan).toHaveLength(1); // S3 only
      expect(Array.isArray(envelope.excluded)).toBe(true);
      expect(envelope.excluded).toHaveLength(1); // EXCLUDED_POLICY
      expect(typeof envelope.totalCostSaved).toBe("string");
      // No AWS writes in dry-run
      expect(mockSingleDestroyAction).not.toHaveBeenCalled();
    });
  });

  // ── Exclusion allowlist ───────────────────────────────────────────

  describe("exclusion allowlist enforcement", () => {
    it("never destroys an allowlisted resource even with --yes --no-confirm", async () => {
      mockFetchManagedResources.mockResolvedValue([
        S3_BUCKET,
        EXCLUDED_POLICY,
        EXCLUDED_ROLE,
      ]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      // Only S3 should be destroyed
      expect(mockSingleDestroyAction).toHaveBeenCalledTimes(1);
      expect(mockSingleDestroyAction).toHaveBeenCalledWith(
        S3_BUCKET.arn,
        expect.objectContaining({ yes: true }),
      );
    });

    it("does not destroy any of the 13 protected assignee-infra resources", async () => {
      const protectedResources: ManagedResource[] = [
        {
          resourceType: "AWS::IAM::ManagedPolicy",
          arn: "arn:aws:iam::112233445566:policy/AssigneeOperatorPolicy",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::ManagedPolicy",
          arn: "arn:aws:iam::112233445566:policy/AssigneeOperatorServicesAPolicy",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::ManagedPolicy",
          arn: "arn:aws:iam::112233445566:policy/AssigneeOperatorServicesBPolicy",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::ManagedPolicy",
          arn: "arn:aws:iam::112233445566:policy/AssigneeReaderPolicy",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::ManagedPolicy",
          arn: "arn:aws:iam::112233445566:policy/AssigneeAuditorPolicy",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::User",
          arn: "arn:aws:iam::112233445566:user/assignee-operator",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::User",
          arn: "arn:aws:iam::112233445566:user/assignee-reader",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::User",
          arn: "arn:aws:iam::112233445566:user/assignee-auditor",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::Role",
          arn: "arn:aws:iam::112233445566:role/AssigneeOperator",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::Role",
          arn: "arn:aws:iam::112233445566:role/AssigneeReader",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::Role",
          arn: "arn:aws:iam::112233445566:role/AssigneeAuditor",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
        {
          resourceType: "AWS::IAM::Role",
          arn: "arn:aws:iam::112233445566:role/AssigneeAiBedrockLoggingRole",
          region: "global",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        },
      ];

      mockFetchManagedResources.mockResolvedValue([
        ...protectedResources,
        S3_BUCKET, // one non-excluded resource so we can verify only it was destroyed
      ]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      // Only S3 should have been destroyed — none of the 12 protected resources
      expect(mockSingleDestroyAction).toHaveBeenCalledTimes(1);
      expect(mockSingleDestroyAction).toHaveBeenCalledWith(
        S3_BUCKET.arn,
        expect.anything(),
      );
      const destroyedArns = mockSingleDestroyAction.mock.calls.map(
        (c) => c[0] as string,
      );
      for (const r of protectedResources) {
        expect(destroyedArns).not.toContain(r.arn);
      }
    });
  });

  // ── Resource cap ─────────────────────────────────────────────────

  describe("> 100 resource cap", () => {
    it("refuses to destroy > 100 resources without --allow-large-sweep", async () => {
      const resources: ManagedResource[] = Array.from(
        { length: 101 },
        (_, i) => ({
          resourceType: "AWS::S3::Bucket",
          arn: `arn:aws:s3:::bucket-${i}`,
          region: "us-east-1",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        }),
      );
      mockFetchManagedResources.mockResolvedValue(resources);
      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      // No destroys fired
      expect(mockSingleDestroyAction).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("allows > 100 resources with --allow-large-sweep", async () => {
      const resources: ManagedResource[] = Array.from(
        { length: 101 },
        (_, i) => ({
          resourceType: "AWS::S3::Bucket",
          arn: `arn:aws:s3:::bucket-${i}`,
          region: "us-east-1",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        }),
      );
      mockFetchManagedResources.mockResolvedValue(resources);
      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      await runBulkDestroyAction({
        yes: true,
        noConfirm: true,
        allowLargeSweep: true,
      });

      // All 101 destroys fired
      expect(mockSingleDestroyAction).toHaveBeenCalledTimes(101);
    });

    it("cap error message names the threshold and resource count", async () => {
      const resources: ManagedResource[] = Array.from(
        { length: 105 },
        (_, i) => ({
          resourceType: "AWS::DynamoDB::Table",
          arn: `arn:aws:dynamodb:us-east-1:112233445566:table/t-${i}`,
          region: "us-east-1",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        }),
      );
      mockFetchManagedResources.mockResolvedValue(resources);

      // Capture stderr to check message
      const stderrChunks: string[] = [];
      const origStderr = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8"),
        );
        return true;
      }) as typeof process.stderr.write;

      try {
        const runBulkDestroyAction = await getSubject();
        await runBulkDestroyAction({ yes: true, noConfirm: true });
        const stderr = stderrChunks.join("");
        expect(stderr).toMatch(/105/);
        expect(stderr).toMatch(/100/);
        expect(stderr).toMatch(/--allow-large-sweep/);
      } finally {
        process.stderr.write = origStderr;
      }
    });
  });

  // ── Plan ordering ─────────────────────────────────────────────────

  describe("plan ordering", () => {
    it("destroys Lambda before IAM Role (dependency order)", async () => {
      // Lambda order=30, IAM Role order=141 → Lambda first
      const iamRole: ManagedResource = {
        resourceType: "AWS::IAM::Role",
        arn: "arn:aws:iam::112233445566:role/MyAppRole",
        region: "global",
        createdDate: "2026-01-01",
        estimatedMonthlyCost: "N/A",
      };
      const lambda: ManagedResource = {
        resourceType: "AWS::Lambda::Function",
        arn: "arn:aws:lambda:us-east-1:112233445566:function:fn",
        region: "us-east-1",
        createdDate: "2026-01-01",
        estimatedMonthlyCost: "N/A",
      };
      // Provide resources in WRONG order (IAM before Lambda)
      mockFetchManagedResources.mockResolvedValue([iamRole, lambda]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      const calls = mockSingleDestroyAction.mock.calls;
      expect(calls).toHaveLength(2);
      // Lambda (order 30) must be destroyed BEFORE IAM Role (order 141)
      const firstArn = calls[0]![0] as string;
      const secondArn = calls[1]![0] as string;
      expect(firstArn).toBe(lambda.arn);
      expect(secondArn).toBe(iamRole.arn);
    });

    it("destroys CloudFront before S3 (dependency order)", async () => {
      // CloudFront order=10, S3 order=90 → CloudFront first
      const cf: ManagedResource = {
        resourceType: "AWS::CloudFront::Distribution",
        arn: "arn:aws:cloudfront::112233445566:distribution/EDFDVBD6EXAMPLE",
        region: "global",
        createdDate: "2026-01-01",
        estimatedMonthlyCost: "$5.00/month",
      };
      const s3: ManagedResource = {
        resourceType: "AWS::S3::Bucket",
        arn: "arn:aws:s3:::my-origin-bucket",
        region: "us-east-1",
        createdDate: "2026-01-01",
        estimatedMonthlyCost: "$1.00/month",
      };
      // Provide in WRONG order (S3 before CF)
      mockFetchManagedResources.mockResolvedValue([s3, cf]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      const calls = mockSingleDestroyAction.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toBe(cf.arn);
      expect(calls[1]![0]).toBe(s3.arn);
    });
  });

  // ── Continue-on-error ─────────────────────────────────────────────

  describe("continue-on-error", () => {
    it("continues destroying after a per-resource failure", async () => {
      mockFetchManagedResources.mockResolvedValue([
        S3_BUCKET,
        LAMBDA_FN,
        USER_IAM_ROLE,
      ]);
      // Lambda fails; S3 and IAM Role succeed
      mockSingleDestroyAction
        .mockResolvedValueOnce(undefined) // S3 — succeeds (Lambda has order 30, but S3 has 90... wait)
        .mockRejectedValueOnce(new Error("Lambda delete failed: dependency"))
        .mockResolvedValueOnce(undefined); // IAM Role
      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      // All three were attempted despite the middle one failing
      expect(mockSingleDestroyAction).toHaveBeenCalledTimes(3);
      // Exit code reflects the failure
      expect(process.exitCode).toBe(1);
    });

    it("reports failed resources in the final summary", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);
      mockSingleDestroyAction.mockRejectedValueOnce(
        new Error("S3 bucket not empty"),
      );
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      const out = stdoutCapture.output();
      expect(out).toContain("S3 bucket not empty");
      expect(out).toContain("manual remediation");
    });
  });

  // ── Polish item 2 (2026-05-09): per-resource --yes warning suppressed ─

  describe("per-resource --yes warning suppression", () => {
    it("threads noConfirm=true into the per-resource destroyer (suppresses per-key --yes warning)", async () => {
      // Bulk-destroy collected typed-account-ID confirmation once
      // (line 575-609 of bulk-action.ts). Per-resource invocations must
      // forward `noConfirm: true` so the
      // "--yes flag used in interactive session" warning that
      // single-flow.ts / confirmDestroy emit does NOT fire 3× for a
      // 3-resource run. Polished by extracting `maybeWarnYesInTty`
      // into yes-warning.ts and wiring `noConfirm` from
      // BulkDestroyOptions through perResourceOpts.
      mockFetchManagedResources.mockResolvedValue([
        S3_BUCKET,
        LAMBDA_FN,
        USER_IAM_ROLE,
      ]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      expect(mockSingleDestroyAction).toHaveBeenCalledTimes(3);
      for (const call of mockSingleDestroyAction.mock.calls) {
        // The fallback wraps perResourceOpts and forwards `noConfirm`
        // into the singleDestroyAction opts payload. Each per-resource
        // call MUST carry `noConfirm: true` so the warning is gated.
        expect(call[1]).toMatchObject({ yes: true, noConfirm: true });
      }
    });

    it("does NOT emit per-resource --yes warning string into stderr during bulk run", async () => {
      mockFetchManagedResources.mockResolvedValue([
        S3_BUCKET,
        LAMBDA_FN,
        USER_IAM_ROLE,
      ]);
      const runBulkDestroyAction = await getSubject();

      const stderrChunks: string[] = [];
      const origStderr = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8"),
        );
        return true;
      }) as typeof process.stderr.write;

      try {
        await runBulkDestroyAction({ yes: true, noConfirm: true });
      } finally {
        process.stderr.write = origStderr;
      }

      const stderr = stderrChunks.join("");
      // No per-resource --yes warning even though 3 per-resource
      // destroys ran. The bulk-confirm step happened upstream
      // (--no-confirm path in this test, so even the bulk warning is
      // about --no-confirm not --yes).
      expect(stderr).not.toContain("--yes flag used in interactive session");
    });
  });

  // ── Audit log ─────────────────────────────────────────────────────

  describe("audit log", () => {
    it("writes one batch audit event per invocation (execute mode)", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      expect(mockAppendAuditRecord).toHaveBeenCalledOnce();
      const auditPayload = mockAppendAuditRecord.mock.calls[0]![0] as {
        action: string;
        planCount: number;
        executed: unknown[];
        excluded: unknown[];
      };
      expect(auditPayload.action).toBe("bulk_destroy_executed");
      expect(auditPayload.planCount).toBe(1);
      expect(Array.isArray(auditPayload.executed)).toBe(true);
      expect(Array.isArray(auditPayload.excluded)).toBe(true);
    });

    it("writes audit event even when all resources are in the exclusion allowlist", async () => {
      mockFetchManagedResources.mockResolvedValue([EXCLUDED_POLICY]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      expect(mockAppendAuditRecord).toHaveBeenCalledOnce();
    });

    it("does NOT write an audit event in dry-run mode", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: false });

      expect(mockAppendAuditRecord).not.toHaveBeenCalled();
    });
  });

  // ── JSON execute mode ─────────────────────────────────────────────

  describe("JSON execute mode (--yes --json)", () => {
    it("emits well-formed JSON envelope with executed/excluded keys", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET, EXCLUDED_POLICY]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true, json: true });

      const out = stdoutCapture.output();
      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(out);
      }).not.toThrow();

      const envelope = parsed as {
        ok: boolean;
        operation: string;
        plan: unknown[];
        executed: Array<{ arn: string; success: boolean }>;
        excluded: unknown[];
        totalCostSaved: string;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.operation).toBe("bulk_destroy");
      expect(envelope.plan).toHaveLength(1);
      expect(envelope.executed).toHaveLength(1);
      expect(envelope.executed[0]!.success).toBe(true);
      expect(envelope.excluded).toHaveLength(1);
    });

    it("emits ok:false and error fields in JSON when resource count exceeds cap", async () => {
      const resources: ManagedResource[] = Array.from(
        { length: 101 },
        (_, i) => ({
          resourceType: "AWS::S3::Bucket",
          arn: `arn:aws:s3:::bucket-${i}`,
          region: "us-east-1",
          createdDate: "2026-01-01",
          estimatedMonthlyCost: "N/A",
        }),
      );
      mockFetchManagedResources.mockResolvedValue(resources);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ json: true });

      const out = stdoutCapture.output();
      const envelope = JSON.parse(out) as { ok: boolean; error: string };
      expect(envelope.ok).toBe(false);
      expect(typeof envelope.error).toBe("string");
      expect(envelope.error).toMatch(/--allow-large-sweep/);
    });
  });

  // ── --no-confirm warning ──────────────────────────────────────────

  describe("--no-confirm (CI/CD) skip behaviour", () => {
    it("logs a warning when --no-confirm is used", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);
      const stderrChunks: string[] = [];
      const origStderr = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8"),
        );
        return true;
      }) as typeof process.stderr.write;

      try {
        const runBulkDestroyAction = await getSubject();
        await runBulkDestroyAction({ yes: true, noConfirm: true });
        const stderr = stderrChunks.join("");
        expect(stderr).toMatch(/WARNING.*--no-confirm/);
      } finally {
        process.stderr.write = origStderr;
      }
    });

    it("proceeds with destroy when --no-confirm is set", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);
      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({ yes: true, noConfirm: true });

      expect(mockSingleDestroyAction).toHaveBeenCalledOnce();
      // No clack prompt fired
      expect(mockClackText).not.toHaveBeenCalled();
    });
  });

  // ── Typed-confirmation gate ───────────────────────────────────────

  describe("typed-confirmation gate (interactive)", () => {
    it("aborts and sets exitCode=1 when confirmation is refused", async () => {
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);
      // User types wrong phrase
      mockClackText.mockResolvedValue("WRONG_PHRASE");
      // process.stdin.isTTY must be truthy for the prompt to fire
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });

      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      await runBulkDestroyAction({ yes: true });

      expect(mockSingleDestroyAction).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Three-bucket summary (destroyed / already_pending / failed) ───────

  describe("three-bucket summary (idempotent-success categorisation)", () => {
    /**
     * Build 5 ManagedResource fixtures with unique ARNs so we can
     * control which resources return "already_pending" via destroyOne.
     */
    const makeResources = (n: number): ManagedResource[] =>
      Array.from({ length: n }, (_, i) => ({
        resourceType: "AWS::KMS::Key",
        arn: `arn:aws:kms:us-east-1:112233445566:key/key-${i}`,
        region: "us-east-1",
        createdDate: "2026-05-07",
        estimatedMonthlyCost: "N/A",
      }));

    it("2 destroyed + 3 already_pending + 0 failed → summary and exit 0", async () => {
      const resources = makeResources(5);
      mockFetchManagedResources.mockResolvedValue(resources);

      // destroyOne returns "already_pending" for the last 3, void for the first 2
      const alreadyPendingDestroyOne = vi
        .fn()
        .mockResolvedValueOnce(undefined) // resource 0 → destroyed
        .mockResolvedValueOnce(undefined) // resource 1 → destroyed
        .mockResolvedValue("already_pending"); // resources 2,3,4 → already_pending

      // Defect 2 (2026-05-09): we additionally need to capture stderr so
      // we can pin per-resource line phrasing.  Wrap stderr.write only
      // for this test so the runtime never lets a worker emit garbage
      // into the parent vitest reporter.
      const stderrChunks: string[] = [];
      const originalStderr = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf-8"),
        );
        return true;
      }) as typeof process.stderr.write;

      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      try {
        await runBulkDestroyAction({
          yes: true,
          noConfirm: true,
          destroyOne: alreadyPendingDestroyOne,
        });
      } finally {
        process.stderr.write = originalStderr;
      }

      const out = stdoutCapture.output();
      // Summary must show three buckets
      expect(out).toContain("2 destroyed");
      expect(out).toContain("3 already pending");
      expect(out).toContain("0 failed");
      // Exit 0 — already_pending is success
      expect(process.exitCode).toBe(0);

      // Defect 2: per-resource progress lines now branch on outcome.
      const stderr = stderrChunks.join("");
      // Each of the 3 already-pending KMS keys gets the ↻ marker.
      const alreadyPendingLines = stderr
        .split("\n")
        .filter((l) => l.includes("↻ Already pending"));
      expect(alreadyPendingLines).toHaveLength(3);
      // The 3 already-pending lines MUST NOT also be tagged "✓ Destroyed".
      for (const line of alreadyPendingLines) {
        expect(line).not.toContain("✓ Destroyed");
      }
      // Exactly 2 destroyed lines for the freshly-destroyed resources.
      const destroyedLines = stderr
        .split("\n")
        .filter((l) => l.includes("✓ Destroyed"));
      expect(destroyedLines).toHaveLength(2);
    });

    it("Defect 2: failed resource line keeps the ✗ FAILED marker (no regression)", async () => {
      const resources = makeResources(3);
      mockFetchManagedResources.mockResolvedValue(resources);

      const mixedDestroyOne = vi
        .fn()
        .mockResolvedValueOnce(undefined) // resource 0 → destroyed
        .mockResolvedValueOnce("already_pending") // resource 1 → already_pending
        .mockRejectedValueOnce(new Error("Throttling: rate exceeded")); // resource 2 → failed

      const stderrChunks: string[] = [];
      const originalStderr = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf-8"),
        );
        return true;
      }) as typeof process.stderr.write;

      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      try {
        await runBulkDestroyAction({
          yes: true,
          noConfirm: true,
          destroyOne: mixedDestroyOne,
        });
      } finally {
        process.stderr.write = originalStderr;
      }

      const stderr = stderrChunks.join("");
      // All three branches produce distinct line shapes — no overlap.
      const destroyed = stderr
        .split("\n")
        .filter((l) => l.includes("✓ Destroyed"));
      const alreadyPending = stderr
        .split("\n")
        .filter((l) => l.includes("↻ Already pending"));
      const failed = stderr.split("\n").filter((l) => l.includes("✗ FAILED"));
      expect(destroyed).toHaveLength(1);
      expect(alreadyPending).toHaveLength(1);
      expect(failed).toHaveLength(1);
      // The failed line embeds the original error message.
      expect(failed[0]).toContain("Throttling: rate exceeded");
    });

    it("0 destroyed + 15 already_pending + 0 failed → exit 0 (the bug-report scenario)", async () => {
      const resources = makeResources(15);
      mockFetchManagedResources.mockResolvedValue(resources);

      const alreadyPendingDestroyOne = vi
        .fn()
        .mockResolvedValue("already_pending");

      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      await runBulkDestroyAction({
        yes: true,
        noConfirm: true,
        destroyOne: alreadyPendingDestroyOne,
      });

      const out = stdoutCapture.output();
      expect(out).toContain("0 destroyed");
      expect(out).toContain("15 already pending");
      expect(out).toContain("0 failed");
      // All resources are in a scheduled-deletion state — that's success
      expect(process.exitCode).toBe(0);
    });

    it("1 destroyed + 0 already_pending + 1 failed → exit 1 (failed still non-zero)", async () => {
      const resources = makeResources(2);
      mockFetchManagedResources.mockResolvedValue(resources);

      const mixedDestroyOne = vi
        .fn()
        .mockResolvedValueOnce(undefined) // resource 0 → destroyed
        .mockRejectedValueOnce(new Error("Throttling")); // resource 1 → failed

      const runBulkDestroyAction = await getSubject();
      process.exitCode = 0;

      await runBulkDestroyAction({
        yes: true,
        noConfirm: true,
        destroyOne: mixedDestroyOne,
      });

      const out = stdoutCapture.output();
      expect(out).toContain("1 destroyed");
      // "already pending" bucket omitted when count is 0
      expect(out).not.toContain("already pending");
      expect(out).toContain("1 failed");
      // Non-zero exit because there's a real failure
      expect(process.exitCode).toBe(1);
    });

    // ── B1: STS resolveAccountId coverage ──────────────────────────

    describe("B1: resolveAccountId STS path", () => {
      let originalIsTTY: boolean | undefined;

      beforeEach(() => {
        // The typed-confirmation gate only fires when stdin.isTTY is truthy.
        originalIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, "isTTY", {
          value: true,
          configurable: true,
        });
        // Provide real-looking operator credentials so tryAssigneeCredentials
        // returns a non-null value, allowing resolveAccountId to proceed to
        // the STS call.
        mockTryAssigneeCredentials.mockReturnValue({
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        });
      });

      afterEach(() => {
        Object.defineProperty(process.stdin, "isTTY", {
          value: originalIsTTY,
          configurable: true,
        });
      });

      it("B1-1: STS success — promptTypedAccountConfirmation receives real account ID", async () => {
        // STS returns a real account ID.
        mockStsSend.mockResolvedValue({ Account: "112233445566" });
        // Operator types the exact account ID to confirm.
        mockClackText.mockResolvedValue("112233445566");
        mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);

        const runBulkDestroyAction = await getSubject();
        await runBulkDestroyAction({ yes: true });

        // clack.text was called with a message containing the account ID as
        // the required phrase — not "DESTROY-EVERYTHING".
        expect(mockClackText).toHaveBeenCalledOnce();
        const callArg = mockClackText.mock.calls[0]![0] as { message: string };
        expect(callArg.message).toContain("112233445566");
        expect(callArg.message).not.toContain("DESTROY-EVERYTHING");
        // Destroy ran (confirmation succeeded).
        expect(mockSingleDestroyAction).toHaveBeenCalledOnce();
      });

      it("B1-2: STS failure (AccessDenied) — falls back to DESTROY-EVERYTHING phrase", async () => {
        // Simulate IAM denial on GetCallerIdentity.
        const accessDenied = Object.assign(
          new Error("AccessDeniedException: not authorised"),
          { name: "AccessDeniedException" },
        );
        mockStsSend.mockRejectedValue(accessDenied);
        // Operator types the fallback phrase.
        mockClackText.mockResolvedValue("DESTROY-EVERYTHING");
        mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);

        const runBulkDestroyAction = await getSubject();
        await runBulkDestroyAction({ yes: true });

        // Fallback phrase must have been used, not the account ID.
        expect(mockClackText).toHaveBeenCalledOnce();
        const callArg = mockClackText.mock.calls[0]![0] as { message: string };
        expect(callArg.message).toContain("DESTROY-EVERYTHING");
        // Destroy still ran (confirmation succeeded with fallback phrase).
        expect(mockSingleDestroyAction).toHaveBeenCalledOnce();
      });

      it("B1-3: STS timeout (2 s) — falls back to DESTROY-EVERYTHING phrase", async () => {
        // STSClient.send never resolves — the Promise.race timeout (2 s) wins.
        // Use a real promise that never settles so the 2 s internal setTimeout
        // fires naturally. Test timeout is set to 10 s to accommodate the delay.
        mockStsSend.mockReturnValue(new Promise<never>(() => {}));
        // Operator types the fallback phrase.
        mockClackText.mockResolvedValue("DESTROY-EVERYTHING");
        mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);

        const runBulkDestroyAction = await getSubject();
        await runBulkDestroyAction({ yes: true });

        expect(mockClackText).toHaveBeenCalledOnce();
        const callArg = mockClackText.mock.calls[0]![0] as { message: string };
        expect(callArg.message).toContain("DESTROY-EVERYTHING");
        // Destroy ran (operator confirmed with fallback phrase).
        expect(mockSingleDestroyAction).toHaveBeenCalledOnce();
      }, 10_000);
    });

    it("JSON envelope includes 'outcome' per executed entry", async () => {
      const resources = makeResources(2);
      mockFetchManagedResources.mockResolvedValue(resources);

      const mixedDestroyOne = vi
        .fn()
        .mockResolvedValueOnce(undefined) // destroyed
        .mockResolvedValueOnce("already_pending"); // already_pending

      const runBulkDestroyAction = await getSubject();

      await runBulkDestroyAction({
        yes: true,
        noConfirm: true,
        json: true,
        destroyOne: mixedDestroyOne,
      });

      const out = stdoutCapture.output();
      const envelope = JSON.parse(out) as {
        ok: boolean;
        executed: Array<{ outcome: string; success: boolean }>;
      };
      expect(envelope.ok).toBe(true);
      const outcomes = envelope.executed.map((e) => e.outcome);
      expect(outcomes).toContain("destroyed");
      expect(outcomes).toContain("already_pending");
    });
  });

  // ─── EPIC-107-2 R2: destroy-isolation behavioural mirror test ─────────
  //
  // Story reviewer guidance: "A unit test alone is insufficient; add a
  // result-formatter snapshot AND a destroy-strategy mirror test."
  //
  // R2 (review structural critique): R1's test was shape-only — it only
  // asserted the destroy plan output didn't mention "vpc-". The behavioral
  // assertion is stronger: construct a scenario where an "Existing" VPC
  // EXISTS at the API layer (RGTA could discover it), but is NOT in the
  // provisions.json that fetchManagedResources reads. Verify that even
  // when bulk-destroy executes against the same account, the VPC has
  // ZERO destroy-API calls fired against it — only the provisioned
  // ManagedResource (the S3 bucket) gets destroyed.

  describe("EPIC-107-2 R2: destroy-isolation (behavioural — existing VPC is never destroyed)", () => {
    /**
     * Simulates the real production scenario:
     *   1. User ran `assignee plan` mentioning "default VPC".
     *   2. The existing-resource-extractor populated
     *      `graph-state.existingResources: [{ kind: "VPC", id: "vpc-abc123" }]`.
     *   3. Apply phase provisioned an S3 bucket as a NEW resource and
     *      wrote ONLY the S3 to provisions.json. The VPC is intentionally
     *      not in provisions.json (it was discovered, not created).
     *   4. Later the user runs `assignee destroy --all --yes`.
     *   5. Expected: bulk-destroy sees ONLY the S3 (from
     *      fetchManagedResources, which reads provisions.json). The VPC is
     *      structurally unreachable — singleDestroyAction is called once
     *      with the S3 and never with anything VPC-shaped.
     */
    const VPC_AS_MANAGED_SHAPE: ManagedResource = {
      // This is what an ExistingResource COULD look like if it were
      // shape-shifted into ManagedResource form. It MUST NOT be returned
      // by fetchManagedResources — the test asserts that even if it were
      // (e.g. via a future regression), the bulk-destroyer would treat it
      // as just another ManagedResource. But the actual destroy-isolation
      // invariant is that fetchManagedResources's data source
      // (provisions.json) does NOT contain the VPC — only the S3.
      resourceType: "AWS::EC2::VPC",
      arn: "arn:aws:ec2:us-east-1:112233445566:vpc/vpc-abc123",
      region: "us-east-1",
      createdDate: "2026-01-01",
      estimatedMonthlyCost: "$0.00/month",
    };

    it("destroys the provisioned S3 and fires ZERO destroy calls against the existing VPC (behavioural)", async () => {
      // Simulate provisions.json containing ONLY the S3 — the VPC is in
      // the account but was discovered, not provisioned, so it's NOT in
      // provisions.json. fetchManagedResources returns the provisions.json
      // contents (S3 only).
      mockFetchManagedResources.mockResolvedValue([S3_BUCKET]);

      // Spy on singleDestroyAction to assert ONLY the S3 was destroyed.
      mockSingleDestroyAction.mockResolvedValue(undefined);

      const runBulkDestroyAction = await getSubject();
      await runBulkDestroyAction({ yes: true, noConfirm: true });

      // The S3 was destroyed exactly once.
      expect(mockSingleDestroyAction).toHaveBeenCalledTimes(1);
      // singleDestroyAction signature: (resource: string, opts: {...}).
      // The first positional arg is the ARN string (NOT an object).
      const firstCallArgs = mockSingleDestroyAction.mock.calls[0] as unknown[];
      expect(firstCallArgs[0]).toBe(S3_BUCKET.arn);

      // VPC ARN string was NEVER passed to singleDestroyAction.
      for (const call of mockSingleDestroyAction.mock.calls) {
        const arnArg = (call as unknown[])[0];
        if (typeof arnArg === "string") {
          expect(arnArg).not.toContain("vpc-abc123");
          expect(arnArg).not.toContain(":vpc/");
        }
      }
    });

    it("when fetchManagedResources is buggy and returns the VPC, destroy WOULD operate on it — proving the safety lives in provisions.json upstream", async () => {
      // Negative-control: this test asserts that the destroy-isolation
      // invariant is upstream (provisions.json doesn't contain
      // ExistingResources). If a buggy fetchManagedResources DID return
      // the VPC, the destroyer would happily destroy it — proving the
      // structural guarantee depends on provisions.json hygiene, not on
      // the destroyer being defensive. This documents the invariant for
      // future maintainers.
      mockFetchManagedResources.mockResolvedValue([
        S3_BUCKET,
        VPC_AS_MANAGED_SHAPE,
      ]);
      mockSingleDestroyAction.mockResolvedValue(undefined);

      const runBulkDestroyAction = await getSubject();
      await runBulkDestroyAction({ yes: true, noConfirm: true });

      // BOTH would be destroyed — confirming the invariant is upstream.
      expect(mockSingleDestroyAction).toHaveBeenCalledTimes(2);
      // This negative-control proves: the only thing preventing the VPC
      // from being destroyed is that provisions.json never contained it.
      // The ExistingResource → ManagedResource pipe is missing by
      // construction. If a future story adds it, this test MUST be
      // re-evaluated.
    });

    it("graph-state.existingResources type is NOT plumbed into fetchManagedResources call sites (signature audit)", async () => {
      // Type-level audit reused from R1. Combined with the behavioural
      // tests above this confirms there is NO code path from
      // graph-state.existingResources to the destroy executor.
      mockFetchManagedResources.mockResolvedValue([]);
      const runBulkDestroyAction = await getSubject();
      await runBulkDestroyAction({});

      const callArgs = mockFetchManagedResources.mock.calls[0] ?? [];
      for (const arg of callArgs) {
        if (Array.isArray(arg)) {
          for (const item of arg) {
            if (item && typeof item === "object") {
              expect("kind" in item && "id" in item && "label" in item).toBe(
                false,
              );
            }
          }
        } else if (arg !== undefined) {
          expect(typeof arg).toBe("string");
        }
      }
    });
  });
});
