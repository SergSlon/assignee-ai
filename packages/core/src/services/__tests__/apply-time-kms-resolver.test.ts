/**
 * Unit tests for apply-time-kms-resolver — Wave D-0 (epic-104-demo-dryrun).
 *
 * Covers ACs D0-1 through D0-7 from
 * `_bmad-output/implementation-artifacts/feature-kms-alias-resolver-consumer-wiring-phase-2.md`.
 *
 * Mock boundaries:
 *
 * - `@aws-sdk/client-sts` — fake `STSClient` whose `send()` returns a
 *   real-shape `GetCallerIdentityResponse`.
 * - `@aws-sdk/client-kms` — same fake-class pattern as Wave C
 *   (`kms-alias-resolver.test.ts`). `KMSClient.send` is the test's
 *   switching mock.
 * - `appendAuditRecord` (`audit/audit-log.js`) — mocked so the
 *   create-path emit cannot pollute `~/.assignee/audit/audit.log`.
 *   Pollution-discipline contract from Wave B-1.
 * - `requireAssigneeCredentials` — provided via env vars set in
 *   `beforeEach`; the real helper reads from `process.env` so no mock
 *   needed.
 *
 * The helper builds its KMSClient by delegating to
 * `services/cloudcontrol-client.ts:createKmsClient`. We mock that
 * factory to return a `KMSClient` instance whose `send()` is the
 * shared switching mock — that lets us count KMS calls without
 * touching AWS.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────
const sharedHoisted = vi.hoisted(() => {
  return {
    mockAppendAuditRecord: vi.fn().mockResolvedValue(undefined),
    mockLog: vi.fn(),
    mockStsSend: vi.fn(),
    mockKmsSend: vi.fn(),
    stsClientCtorCount: { value: 0 },
  };
});
const { mockAppendAuditRecord, mockStsSend, mockKmsSend, stsClientCtorCount } =
  sharedHoisted;

// ── Mock audit-log + logger ───────────────────────────────────────────
vi.mock("../../audit/audit-log.js", () => ({
  appendAuditRecord: sharedHoisted.mockAppendAuditRecord,
}));

vi.mock("../../utils/logger/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../utils/logger/index.js")
  >("../../utils/logger/index.js");
  return {
    ...actual,
    log: sharedHoisted.mockLog,
  };
});

// ── Mock @aws-sdk/client-sts ──────────────────────────────────────────
vi.mock("@aws-sdk/client-sts", () => {
  class STSClient {
    send = sharedHoisted.mockStsSend;
    constructor(_config: unknown) {
      sharedHoisted.stsClientCtorCount.value++;
    }
  }
  function GetCallerIdentityCommand(input: unknown) {
    return { _type: "GetCallerIdentity", input };
  }
  return { STSClient, GetCallerIdentityCommand };
});

// ── Mock @aws-sdk/client-kms ──────────────────────────────────────────
//
// Match Wave C's class-stub pattern so the resolver's
// `cmd instanceof FakeXCommand` checks work correctly.
const kmsHoisted = vi.hoisted(() => {
  class FakeListAliasesCommand {
    constructor(public input: { Marker?: string }) {}
  }
  class FakeCreateKeyCommand {
    constructor(
      public input: {
        Description?: string;
        KeyUsage?: string;
        Tags?: Array<{ TagKey: string; TagValue: string }>;
      },
    ) {}
  }
  class FakeCreateAliasCommand {
    constructor(public input: { AliasName: string; TargetKeyId: string }) {}
  }
  class FakeDescribeKeyCommand {
    constructor(public input: { KeyId: string }) {}
  }
  class FakeEnableKeyRotationCommand {
    constructor(public input: { KeyId: string }) {}
  }
  class FakeScheduleKeyDeletionCommand {
    constructor(public input: { KeyId: string; PendingWindowInDays: number }) {}
  }
  return {
    FakeListAliasesCommand,
    FakeCreateKeyCommand,
    FakeCreateAliasCommand,
    FakeDescribeKeyCommand,
    FakeEnableKeyRotationCommand,
    FakeScheduleKeyDeletionCommand,
  };
});

const {
  FakeListAliasesCommand,
  FakeCreateKeyCommand,
  FakeCreateAliasCommand,
  FakeDescribeKeyCommand,
  FakeEnableKeyRotationCommand,
  FakeScheduleKeyDeletionCommand,
} = kmsHoisted;

vi.mock("@aws-sdk/client-kms", () => {
  class KMSClient {
    send = sharedHoisted.mockKmsSend;
  }
  return {
    KMSClient,
    ListAliasesCommand: kmsHoisted.FakeListAliasesCommand,
    CreateKeyCommand: kmsHoisted.FakeCreateKeyCommand,
    CreateAliasCommand: kmsHoisted.FakeCreateAliasCommand,
    DescribeKeyCommand: kmsHoisted.FakeDescribeKeyCommand,
    EnableKeyRotationCommand: kmsHoisted.FakeEnableKeyRotationCommand,
    ScheduleKeyDeletionCommand: kmsHoisted.FakeScheduleKeyDeletionCommand,
  };
});

// ── Mock cloudcontrol-client.createKmsClient so the helper's
//    own client construction reuses the same fake KMSClient + send mock.
vi.mock("../cloudcontrol-client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../cloudcontrol-client.js")
  >("../cloudcontrol-client.js");
  const { KMSClient } = await import("@aws-sdk/client-kms");
  return {
    ...actual,
    createKmsClient: vi.fn(() => new KMSClient({} as never)),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────
import {
  resolveDefaultKmsKeyForApply,
  clearApplyTimeKmsClientCache,
  KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
} from "../apply-time-kms-resolver.js";
import {
  clearKmsAliasCache,
  DEFAULT_KMS_ALIAS_NAME,
} from "../kms-alias-resolver.js";
import { resetAccountIdCache } from "../../utils/resolve-arn.js";
import { AssigneeError } from "../../errors.js";
import { createKmsClient } from "../cloudcontrol-client.js";

// ── Real-data fixtures ────────────────────────────────────────────────
//
// Use a non-denylisted 12-digit account id (per
// feedback_no_real_account_ids_in_repo: 112233445566 is safe;
// 210987654321 is denylisted).
const TEST_ACCOUNT = "112233445566";
const TEST_REGION = "us-east-1";
const SECONDARY_REGION = "eu-west-1";

const EXISTING_KEY_ID = "1a2b3c4d-1234-5678-9abc-def012345678";
const EXISTING_KEY_ARN = `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/${EXISTING_KEY_ID}`;
const EXISTING_KEY_ARN_EU = `arn:aws:kms:${SECONDARY_REGION}:${TEST_ACCOUNT}:key/${EXISTING_KEY_ID}`;

const NEW_KEY_ID = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";
const NEW_KEY_ARN = `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/${NEW_KEY_ID}`;

const ORIGINAL_ENV = { ...process.env };

beforeAll(() => {
  // The helper's `requireAssigneeCredentials("operator")` reads these
  // at call time. Without them the no-creds path fires before STS,
  // surfacing as `MissingAssigneeCredentialsError` thrown out of
  // `getOperatorAccountId` rather than the no-credentials cache
  // behaviour we want for AC-D0-1/2/3/5/6.
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountIdCache();
  clearKmsAliasCache();
  clearApplyTimeKmsClientCache();
  stsClientCtorCount.value = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────
function aliasHitResponse(keyId: string) {
  return {
    Aliases: [
      {
        AliasName: DEFAULT_KMS_ALIAS_NAME,
        TargetKeyId: keyId,
      },
    ],
    Truncated: false,
  };
}

function describeKeyResponse(keyArn: string, keyId: string) {
  return {
    KeyMetadata: {
      KeyId: keyId,
      Arn: keyArn,
      KeyState: "Enabled",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
describe("resolveDefaultKmsKeyForApply", () => {
  // ── AC-D0-1 + AC-D0-2 ────────────────────────────────────────────────
  describe("happy path + cache (AC-D0-1, AC-D0-2)", () => {
    it("returns { keyArn, aliasName, created, accountId } and caches both STS and alias on the second call", async () => {
      mockStsSend.mockResolvedValueOnce({
        Account: TEST_ACCOUNT,
        Arn: `arn:aws:iam::${TEST_ACCOUNT}:user/assignee-operator`,
      });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return describeKeyResponse(EXISTING_KEY_ARN, EXISTING_KEY_ID);
        }
        throw new Error(
          `Unexpected KMS command in happy path: ${cmd?.constructor?.name}`,
        );
      });

      const r1 = await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
        runId: "ac-d0-1-run",
      });
      expect(r1).toEqual({
        keyArn: EXISTING_KEY_ARN,
        aliasName: DEFAULT_KMS_ALIAS_NAME,
        created: false,
        accountId: TEST_ACCOUNT,
      });

      const stsAfterFirst = mockStsSend.mock.calls.length;
      const kmsAfterFirst = mockKmsSend.mock.calls.length;

      const r2 = await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
        runId: "ac-d0-1-run",
      });

      expect(r2).toEqual(r1);
      // AC-D0-2: zero additional STS or KMS calls on the cached re-read.
      expect(mockStsSend.mock.calls.length).toBe(stsAfterFirst);
      expect(mockKmsSend.mock.calls.length).toBe(kmsAfterFirst);
      // Pollution discipline: alias-resolver hit the lookup-path, not
      // the create-path → no audit emit.
      expect(mockAppendAuditRecord).not.toHaveBeenCalled();
    });
  });

  // ── AC-D0-3 ─────────────────────────────────────────────────────────
  describe("multi-region (AC-D0-3)", () => {
    it("issues exactly one STS call across two regions but two ListAliases calls (per-region cache slots)", async () => {
      mockStsSend.mockResolvedValue({
        Account: TEST_ACCOUNT,
        Arn: `arn:aws:iam::${TEST_ACCOUNT}:user/assignee-operator`,
      });
      let listAliasesCount = 0;
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          listAliasesCount++;
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          // Different ARN per region matches AWS reality (KMS keys are
          // regional). Both reuse the same UUID for fixture brevity.
          if (listAliasesCount === 1) {
            return describeKeyResponse(EXISTING_KEY_ARN, EXISTING_KEY_ID);
          }
          return describeKeyResponse(EXISTING_KEY_ARN_EU, EXISTING_KEY_ID);
        }
        throw new Error(`Unexpected KMS command: ${cmd?.constructor?.name}`);
      });

      const us = await resolveDefaultKmsKeyForApply({ region: TEST_REGION });
      const eu = await resolveDefaultKmsKeyForApply({
        region: SECONDARY_REGION,
      });

      expect(us.keyArn).toBe(EXISTING_KEY_ARN);
      expect(eu.keyArn).toBe(EXISTING_KEY_ARN_EU);
      expect(us.accountId).toBe(TEST_ACCOUNT);
      expect(eu.accountId).toBe(TEST_ACCOUNT);

      // Exactly ONE STS call across two regions (account is region-
      // agnostic; the upstream cache slot is keyed only on tenantId).
      expect(mockStsSend).toHaveBeenCalledTimes(1);
      // Two ListAliases (one per region — alias-resolver cache key is
      // (accountId, region)).
      expect(listAliasesCount).toBe(2);
    });
  });

  // ── AC-D0-4 (STS failure) ───────────────────────────────────────────
  describe("STS failure (AC-D0-4)", () => {
    it("throws AssigneeError(KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED) and does not invoke KMS when getOperatorAccountId returns undefined (network failure)", async () => {
      mockStsSend.mockRejectedValueOnce(
        Object.assign(new Error("ECONNREFUSED"), { name: "NetworkError" }),
      );

      await expect(
        resolveDefaultKmsKeyForApply({ region: TEST_REGION }),
      ).rejects.toMatchObject({
        name: "AssigneeError",
        code: KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
      });

      // Critical: KMS was never touched — failing closed avoids
      // minting a CMK in the wrong account.
      expect(mockKmsSend).not.toHaveBeenCalled();
      expect(mockAppendAuditRecord).not.toHaveBeenCalled();
    });

    it("throws AssigneeError(KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED) when STS returns no Account field", async () => {
      // STS succeeded but returned an empty body — the upstream
      // helper folds this to undefined.
      mockStsSend.mockResolvedValueOnce({});

      const err = await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe(
        KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
      );
      expect((err as AssigneeError).message).toContain(
        "could not resolve operator account id",
      );
      expect(mockKmsSend).not.toHaveBeenCalled();
    });

    it("throws AssigneeError(KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED) when operator credentials are missing", async () => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

      await expect(
        resolveDefaultKmsKeyForApply({ region: TEST_REGION }),
      ).rejects.toMatchObject({
        name: "AssigneeError",
        code: KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
      });

      // No STS call attempted (the upstream helper short-circuits on
      // MissingAssigneeCredentialsError before constructing STSClient).
      expect(mockStsSend).not.toHaveBeenCalled();
      expect(mockKmsSend).not.toHaveBeenCalled();
    });
  });

  // ── AC-D0-5 (accountIdOverride bypass) ──────────────────────────────
  describe("accountIdOverride (AC-D0-5)", () => {
    it("does not construct an STSClient or call STS when accountIdOverride is supplied", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return describeKeyResponse(EXISTING_KEY_ARN, EXISTING_KEY_ID);
        }
        throw new Error(`unexpected: ${cmd?.constructor?.name}`);
      });

      const result = await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
        accountIdOverride: TEST_ACCOUNT,
      });

      expect(result.accountId).toBe(TEST_ACCOUNT);
      expect(result.keyArn).toBe(EXISTING_KEY_ARN);
      // Critical: STS was never invoked AND STSClient was never even
      // constructed.
      expect(mockStsSend).not.toHaveBeenCalled();
      expect(stsClientCtorCount.value).toBe(0);
    });

    it("rejects an empty / whitespace accountIdOverride with KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED", async () => {
      await expect(
        resolveDefaultKmsKeyForApply({
          region: TEST_REGION,
          accountIdOverride: "   ",
        }),
      ).rejects.toMatchObject({
        name: "AssigneeError",
        code: KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
      });
      expect(mockStsSend).not.toHaveBeenCalled();
      expect(mockKmsSend).not.toHaveBeenCalled();
    });
  });

  // ── AC-D0-6 (KMS error propagation) ─────────────────────────────────
  describe("KMS resolver errors propagate (AC-D0-6)", () => {
    it("propagates KMS_ALIAS_STALE unchanged when the existing alias points at a Disabled key", async () => {
      mockStsSend.mockResolvedValueOnce({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: EXISTING_KEY_ID,
              Arn: EXISTING_KEY_ARN,
              KeyState: "Disabled",
            },
          };
        }
        throw new Error(`unexpected: ${cmd?.constructor?.name}`);
      });

      const err = await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe("KMS_ALIAS_STALE");
      // Pollution discipline: stale-alias path does NOT emit an audit
      // record (the create-path is the only emitter).
      expect(mockAppendAuditRecord).not.toHaveBeenCalled();
    });

    it("returns created: true when the alias resolver hits the create-path", async () => {
      mockStsSend.mockResolvedValueOnce({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          // No alias yet → forces the create-path.
          return { Aliases: [], Truncated: false };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: NEW_KEY_ID,
              Arn: NEW_KEY_ARN,
            },
          };
        }
        if (cmd instanceof FakeEnableKeyRotationCommand) {
          return {};
        }
        if (cmd instanceof FakeCreateAliasCommand) {
          return {};
        }
        throw new Error(`unexpected: ${cmd?.constructor?.name}`);
      });

      const result = await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
        runId: "ac-d0-6-create-run",
      });

      expect(result).toEqual({
        keyArn: NEW_KEY_ARN,
        aliasName: DEFAULT_KMS_ALIAS_NAME,
        created: true,
        accountId: TEST_ACCOUNT,
      });
      // Audit emit happened on the create-path (Wave C contract). The
      // mock catches it so the file on disk is untouched. L1: pin
      // `region` + `runId` so a future region/runId-stripping refactor
      // surfaces here, not as a silent observability regression.
      expect(mockAppendAuditRecord).toHaveBeenCalledTimes(1);
      expect(mockAppendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "apply_resource_created",
          resourceType: "AWS::KMS::Key",
          resourceArn: NEW_KEY_ARN,
          region: TEST_REGION,
          runId: "ac-d0-6-create-run",
        }),
      );
    });
  });

  // ── L3 (runId propagation) ──────────────────────────────────────────
  describe("runId propagation through the conditional spread", () => {
    it("threads runId from helper opts → underlying alias-resolver → audit emit", async () => {
      mockStsSend.mockResolvedValueOnce({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return { Aliases: [], Truncated: false };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          return { KeyMetadata: { KeyId: NEW_KEY_ID, Arn: NEW_KEY_ARN } };
        }
        if (cmd instanceof FakeEnableKeyRotationCommand) {
          return {};
        }
        if (cmd instanceof FakeCreateAliasCommand) {
          return {};
        }
        throw new Error(`unexpected: ${cmd?.constructor?.name}`);
      });

      const distinctiveRunId = "wave-d0-l3-runid-fixture-9c2f4e";
      await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
        runId: distinctiveRunId,
      });

      expect(mockAppendAuditRecord).toHaveBeenCalledTimes(1);
      expect(mockAppendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: distinctiveRunId,
        }),
      );
    });

    it("omits runId from the underlying call when helper opts.runId is undefined (audit emit falls back to the alias-resolver default)", async () => {
      mockStsSend.mockResolvedValueOnce({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return { Aliases: [], Truncated: false };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          return { KeyMetadata: { KeyId: NEW_KEY_ID, Arn: NEW_KEY_ARN } };
        }
        if (cmd instanceof FakeEnableKeyRotationCommand) {
          return {};
        }
        if (cmd instanceof FakeCreateAliasCommand) {
          return {};
        }
        throw new Error(`unexpected: ${cmd?.constructor?.name}`);
      });

      // No runId on the helper opts.
      await resolveDefaultKmsKeyForApply({ region: TEST_REGION });

      // Wave C resolver substitutes "kms-alias-resolver" when runId is
      // absent from the underlying call. Asserting that string here
      // proves the conditional spread correctly suppressed our key
      // (instead of forwarding runId=undefined, which Wave C would NOT
      // have rewritten).
      expect(mockAppendAuditRecord).toHaveBeenCalledTimes(1);
      expect(mockAppendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "kms-alias-resolver",
        }),
      );
    });
  });

  // ── kms client reuse ────────────────────────────────────────────────
  describe("per-region KMS client cache", () => {
    it("constructs the KMS client once per region, even across multiple calls", async () => {
      mockStsSend.mockResolvedValue({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return describeKeyResponse(EXISTING_KEY_ARN, EXISTING_KEY_ID);
        }
        throw new Error("unreachable");
      });

      // Two calls in the same region.
      await resolveDefaultKmsKeyForApply({ region: TEST_REGION });
      // Force the alias-resolver cache miss for the second call so the
      // KMS client path actually runs again.
      clearKmsAliasCache();
      await resolveDefaultKmsKeyForApply({ region: TEST_REGION });

      // Mocked factory should have been called exactly once (cached
      // per region across the two calls).
      expect(createKmsClient).toHaveBeenCalledTimes(1);

      // A different region forces a new client.
      clearKmsAliasCache();
      await resolveDefaultKmsKeyForApply({ region: SECONDARY_REGION });
      expect(createKmsClient).toHaveBeenCalledTimes(2);
    });

    it("clearApplyTimeKmsClientCache forces a new KMS client on the next call", async () => {
      mockStsSend.mockResolvedValue({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return describeKeyResponse(EXISTING_KEY_ARN, EXISTING_KEY_ID);
        }
        throw new Error("unreachable");
      });

      await resolveDefaultKmsKeyForApply({ region: TEST_REGION });
      expect(createKmsClient).toHaveBeenCalledTimes(1);

      clearApplyTimeKmsClientCache();
      clearKmsAliasCache();
      await resolveDefaultKmsKeyForApply({ region: TEST_REGION });

      expect(createKmsClient).toHaveBeenCalledTimes(2);
    });
  });

  // ── caller-supplied KMS client ──────────────────────────────────────
  describe("caller-supplied KMS client", () => {
    it("does NOT construct a fresh KMS client when the caller passes one", async () => {
      mockStsSend.mockResolvedValueOnce({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return describeKeyResponse(EXISTING_KEY_ARN, EXISTING_KEY_ID);
        }
        throw new Error("unreachable");
      });

      // The caller-supplied client uses the SAME mocked KMSClient
      // class as the helper's internal one (single shared mock at the
      // SDK module boundary), so we get equivalent send-counting.
      const { KMSClient } = await import("@aws-sdk/client-kms");
      const callerKms = new KMSClient({} as never);

      await resolveDefaultKmsKeyForApply({
        region: TEST_REGION,
        kms: callerKms,
      });

      // createKmsClient was NOT called — the caller's client was used.
      expect(createKmsClient).not.toHaveBeenCalled();
    });
  });

  // ── AC-D0-7 (pollution discipline summary) ──────────────────────────
  describe("pollution discipline (AC-D0-7)", () => {
    it("never invokes appendAuditRecord on the lookup-path across the full suite", async () => {
      mockStsSend.mockResolvedValueOnce({ Account: TEST_ACCOUNT });
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return aliasHitResponse(EXISTING_KEY_ID);
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return describeKeyResponse(EXISTING_KEY_ARN, EXISTING_KEY_ID);
        }
        throw new Error("unreachable");
      });

      await resolveDefaultKmsKeyForApply({ region: TEST_REGION });
      expect(mockAppendAuditRecord).not.toHaveBeenCalled();
    });
  });
});

// ── Avoid unused-import warnings while keeping the imports above —
//    these are referenced indirectly through the SDK mock factory.
void FakeScheduleKeyDeletionCommand;
