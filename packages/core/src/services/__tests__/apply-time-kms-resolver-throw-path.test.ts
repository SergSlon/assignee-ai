/**
 * M1 — defensive throw-path coverage for apply-time-kms-resolver.
 *
 * The helper wraps `getOperatorAccountId` in try/catch as defence-in-
 * depth: the upstream contract documents "swallow internal errors and
 * return undefined", but the catch block exists in case that contract
 * silently changes. Without this test the catch path has no coverage
 * and a regression in `resolve-arn.ts` (e.g. an `if (!creds) throw …`
 * added for SaaS multi-tenant) would not surface here.
 *
 * This file is separate from `apply-time-kms-resolver.test.ts` because
 * `vi.mock` is hoisted to the top of the file — the main test file
 * imports `resetAccountIdCache` from `resolve-arn.js` for cache
 * cleanup in `beforeEach`, which conflicts with mocking the same
 * module identity.
 *
 * Pollution discipline: same `appendAuditRecord` mock as the main
 * file. Zero audit-log writes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock audit-log so the resolver's audit emit never touches disk
//    (defensive — this test should never reach the create-path, but
//    the contract is "no audit-log delta from the test suite").
vi.mock("../../audit/audit-log.js", () => ({
  appendAuditRecord: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock @aws-sdk/client-kms so the helper can construct a region-
//    bound client without reaching real AWS. The KMS path is
//    unreachable in this file (STS throws first), but the import
//    graph still loads it.
vi.mock("@aws-sdk/client-kms", () => {
  class KMSClient {
    send = vi.fn();
  }
  return {
    KMSClient,
    ListAliasesCommand: class {
      constructor(public input: unknown) {}
    },
    CreateKeyCommand: class {
      constructor(public input: unknown) {}
    },
    CreateAliasCommand: class {
      constructor(public input: unknown) {}
    },
    DescribeKeyCommand: class {
      constructor(public input: unknown) {}
    },
    EnableKeyRotationCommand: class {
      constructor(public input: unknown) {}
    },
    ScheduleKeyDeletionCommand: class {
      constructor(public input: unknown) {}
    },
  };
});

// ── M1 critical mock: replace `getOperatorAccountId` with a thrower.
//    The upstream contract today swallows internal errors and returns
//    undefined; this test pins the helper's defensive try/catch so a
//    future contract change still surfaces a structured error.
//
//    `vi.mock` is hoisted to the top of the file, so the factory body
//    cannot close over a top-level `const mockFn`. Use `vi.hoisted` to
//    declare the mock state in the same hoist phase.
const { mockGetOperatorAccountId } = vi.hoisted(() => ({
  mockGetOperatorAccountId: vi.fn(),
}));
vi.mock("../../utils/resolve-arn.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../utils/resolve-arn.js")
  >("../../utils/resolve-arn.js");
  return {
    ...actual,
    getOperatorAccountId: mockGetOperatorAccountId,
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────
import {
  resolveDefaultKmsKeyForApply,
  clearApplyTimeKmsClientCache,
  KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
} from "../apply-time-kms-resolver.js";
import { clearKmsAliasCache } from "../kms-alias-resolver.js";
import { AssigneeError } from "../../errors.js";
import { MissingAssigneeCredentialsError } from "../../config/aws-credentials.js";

const TEST_REGION = "us-east-1";

beforeEach(() => {
  vi.clearAllMocks();
  clearKmsAliasCache();
  clearApplyTimeKmsClientCache();
  // The helper still constructs a KMSClient via
  // `requireAssigneeCredentials("operator")` — guarantee the env vars
  // are set so the throw under test is the STS-class error, not a
  // missing-creds error from a different code path.
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

describe("M1 — defensive throw-path on getOperatorAccountId contract change", () => {
  it("surfaces KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED with the underlying cause when getOperatorAccountId throws a generic Error", async () => {
    const cause = "STS contract changed: hard-throw on missing creds";
    mockGetOperatorAccountId.mockRejectedValueOnce(new Error(cause));

    const err = await resolveDefaultKmsKeyForApply({
      region: TEST_REGION,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AssigneeError);
    expect((err as AssigneeError).code).toBe(
      KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
    );
    // The defensive catch must surface the original cause so an
    // operator can see what changed upstream.
    expect((err as AssigneeError).message).toContain(cause);
    expect((err as AssigneeError).message).toContain("STS GetCallerIdentity");
  });

  it("surfaces KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED with the credential-class message when getOperatorAccountId throws MissingAssigneeCredentialsError", async () => {
    const credErr = new MissingAssigneeCredentialsError(
      "operator",
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    );
    mockGetOperatorAccountId.mockRejectedValueOnce(credErr);

    const err = await resolveDefaultKmsKeyForApply({
      region: TEST_REGION,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AssigneeError);
    expect((err as AssigneeError).code).toBe(
      KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
    );
    // The defensive catch branches on MissingAssigneeCredentialsError
    // specifically and forwards `err.message` (not String(err)) so the
    // structured class name is not leaked into the operator-visible
    // hint.
    expect((err as AssigneeError).message).toContain(credErr.message);
  });

  it("surfaces KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED with String(err) when getOperatorAccountId throws a non-Error value", async () => {
    // Defensive — a hostile mock or a corrupt module could throw a
    // string. The catch block handles this via `String(err)`.
    mockGetOperatorAccountId.mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "raw-string-rejection";
    });

    const err = await resolveDefaultKmsKeyForApply({
      region: TEST_REGION,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AssigneeError);
    expect((err as AssigneeError).code).toBe(
      KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
    );
    expect((err as AssigneeError).message).toContain("raw-string-rejection");
  });
});
