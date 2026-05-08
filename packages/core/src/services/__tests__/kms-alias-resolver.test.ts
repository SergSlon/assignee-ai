/**
 * Unit tests for kms-alias-resolver — Wave C (epic-104-demo-dryrun).
 *
 * Covers ACs 1, 2, 3, 5, 6, 7, 9, 10 from
 * `_bmad-output/implementation-artifacts/feature-kms-key-reuse-via-alias.md`.
 *
 * Mocks `appendAuditRecord` so tests do not pollute
 * `~/.assignee/audit/audit.log`; the chain-integrity contract is
 * exercised in `audit/audit-log.test.ts`.
 *
 * Mocks `@aws-sdk/client-kms` SDK with a class-stub `KMSClient` whose
 * `send()` is the test's switching-mock — no live AWS calls. This
 * matches the existing pattern in `utils/aws-resource-discovery.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock audit-log + logger (hoisted) ─────────────────────────────────
const sharedHoisted = vi.hoisted(() => {
  return {
    mockAppendAuditRecord: vi.fn().mockResolvedValue(undefined),
    mockLog: vi.fn(),
  };
});
const { mockAppendAuditRecord, mockLog } = sharedHoisted;

vi.mock("../../audit/audit-log.js", () => ({
  appendAuditRecord: sharedHoisted.mockAppendAuditRecord,
}));

vi.mock("../../utils/logger/index.js", async () => {
  // Preserve LOG_ACTIONS exports — the resolver imports them at module
  // load time and they must be the real values. We only stub `log`.
  const actual = await vi.importActual<
    typeof import("../../utils/logger/index.js")
  >("../../utils/logger/index.js");
  return {
    ...actual,
    log: sharedHoisted.mockLog,
  };
});

// ── Mock @aws-sdk/client-kms ───────────────────────────────────────────
//
// vi.mock factories are hoisted to the top of the file. We use
// `vi.hoisted(...)` to declare the shared mock state + Fake* classes
// before the hoisted vi.mock factory body references them, then pull the
// same identities back out at module scope so the test cases can switch
// on `instanceof FakeXCommand`.
const kmsHoisted = vi.hoisted(() => {
  const mockKmsSend = vi.fn();
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
    mockKmsSend,
    FakeListAliasesCommand,
    FakeCreateKeyCommand,
    FakeCreateAliasCommand,
    FakeDescribeKeyCommand,
    FakeEnableKeyRotationCommand,
    FakeScheduleKeyDeletionCommand,
  };
});

const {
  mockKmsSend,
  FakeListAliasesCommand,
  FakeCreateKeyCommand,
  FakeCreateAliasCommand,
  FakeDescribeKeyCommand,
  FakeEnableKeyRotationCommand,
  FakeScheduleKeyDeletionCommand,
} = kmsHoisted;

vi.mock("@aws-sdk/client-kms", () => {
  class KMSClient {
    send = kmsHoisted.mockKmsSend;
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

// ── Imports (after mocks) ──────────────────────────────────────────────
import { KMSClient } from "@aws-sdk/client-kms";
import {
  resolveOrCreateDefaultKmsKey,
  clearKmsAliasCache,
  DEFAULT_KMS_ALIAS_NAME,
} from "../kms-alias-resolver.js";
import { AssigneeError } from "../../errors.js";
import { LOG_ACTIONS } from "../../utils/logger/index.js";

// ── Real-data fixtures ─────────────────────────────────────────────────
//
// Use a non-denylisted 12-digit account id (per
// feedback_no_real_account_ids_in_repo: 112233445566 is safe; 210987654321
// is denylisted). Region us-east-1 mirrors the project default.
const TEST_ACCOUNT = "112233445566";
const TEST_REGION = "us-east-1";

const EXISTING_KEY_ID = "1a2b3c4d-1234-5678-9abc-def012345678";
const EXISTING_KEY_ARN = `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/${EXISTING_KEY_ID}`;

const NEW_KEY_ID = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";
const NEW_KEY_ARN = `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/${NEW_KEY_ID}`;

const RACING_KEY_ID = "0aaa1bbb-2ccc-3ddd-4eee-5fff67891234";
const RACING_KEY_ARN = `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:key/${RACING_KEY_ID}`;

function makeKms(): KMSClient {
  return new KMSClient({ region: TEST_REGION });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearKmsAliasCache();
});

describe("resolveOrCreateDefaultKmsKey", () => {
  // ── AC-2 ──────────────────────────────────────────────────────────────
  describe("alias already exists (AC-2 — reuse across runs)", () => {
    it("returns the existing key arn without calling CreateKey or CreateAlias", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: EXISTING_KEY_ID,
                AliasArn: `arn:aws:kms:${TEST_REGION}:${TEST_ACCOUNT}:${DEFAULT_KMS_ALIAS_NAME}`,
              },
            ],
            Truncated: false,
          };
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: EXISTING_KEY_ID,
              Arn: EXISTING_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        throw new Error(
          `Unexpected command in AC-2 happy path: ${cmd?.constructor?.name}`,
        );
      });

      const result = await resolveOrCreateDefaultKmsKey({
        kms: makeKms(),
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
        runId: "ac-2-run",
      });

      expect(result).toEqual({
        keyArn: EXISTING_KEY_ARN,
        aliasName: DEFAULT_KMS_ALIAS_NAME,
        created: false,
      });

      const cmds = mockKmsSend.mock.calls.map((c) => c[0]);
      expect(cmds).toHaveLength(2);
      expect(cmds[0]).toBeInstanceOf(FakeListAliasesCommand);
      expect(cmds[1]).toBeInstanceOf(FakeDescribeKeyCommand);
      // No audit-record emit on the reuse path (AC-9 negative case).
      expect(mockAppendAuditRecord).not.toHaveBeenCalled();
    });

    it("paginates ListAliases when the alias is on the second page", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          if (!cmd.input.Marker) {
            return {
              Aliases: [
                {
                  AliasName: "alias/aws/s3",
                  TargetKeyId: "aws-managed-1",
                },
              ],
              Truncated: true,
              NextMarker: "page-2",
            };
          }
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: EXISTING_KEY_ID,
              },
            ],
            Truncated: false,
          };
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: EXISTING_KEY_ID,
              Arn: EXISTING_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        throw new Error(`Unexpected command: ${cmd?.constructor?.name}`);
      });

      const result = await resolveOrCreateDefaultKmsKey({
        kms: makeKms(),
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      });

      expect(result.keyArn).toBe(EXISTING_KEY_ARN);
      expect(
        mockKmsSend.mock.calls.filter(
          (c) => c[0] instanceof FakeListAliasesCommand,
        ),
      ).toHaveLength(2);
    });
  });

  // ── AC-1 (cache) ──────────────────────────────────────────────────────
  describe("cache (AC-1 — same-run idempotence)", () => {
    it("second call within a run does not invoke the SDK at all", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: EXISTING_KEY_ID,
              },
            ],
            Truncated: false,
          };
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: EXISTING_KEY_ID,
              Arn: EXISTING_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        throw new Error("unreachable");
      });

      const kms = makeKms();
      const r1 = await resolveOrCreateDefaultKmsKey({
        kms,
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      });
      const callsAfterFirst = mockKmsSend.mock.calls.length;
      const r2 = await resolveOrCreateDefaultKmsKey({
        kms,
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      });
      expect(r1).toEqual(r2);
      expect(mockKmsSend.mock.calls.length).toBe(callsAfterFirst);
    });

    it("clearKmsAliasCache forces a re-lookup", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: EXISTING_KEY_ID,
              },
            ],
            Truncated: false,
          };
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: EXISTING_KEY_ID,
              Arn: EXISTING_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        throw new Error("unreachable");
      });

      const kms = makeKms();
      await resolveOrCreateDefaultKmsKey({
        kms,
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      });
      const callsBeforeClear = mockKmsSend.mock.calls.length;
      clearKmsAliasCache();
      await resolveOrCreateDefaultKmsKey({
        kms,
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      });
      expect(mockKmsSend.mock.calls.length).toBeGreaterThan(callsBeforeClear);
    });

    it("different (account, region) tuples do not share a cache slot", async () => {
      let listCallCount = 0;
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          listCallCount++;
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: EXISTING_KEY_ID,
              },
            ],
            Truncated: false,
          };
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: EXISTING_KEY_ID,
              Arn: EXISTING_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        throw new Error("unreachable");
      });

      const kms = makeKms();
      await resolveOrCreateDefaultKmsKey({
        kms,
        accountId: TEST_ACCOUNT,
        region: "us-east-1",
      });
      await resolveOrCreateDefaultKmsKey({
        kms,
        accountId: TEST_ACCOUNT,
        region: "us-west-2",
      });
      expect(listCallCount).toBe(2);
    });
  });

  // ── AC-3 + AC-7 + AC-9 (create-path) ─────────────────────────────────
  describe("alias missing — create path (AC-3, AC-7, AC-9)", () => {
    it("creates the CMK with the 3 expected tags inline (no separate TagResource)", async () => {
      const recordedCommands: unknown[] = [];
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        recordedCommands.push(cmd);
        if (cmd instanceof FakeListAliasesCommand) {
          return { Aliases: [], Truncated: false };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: NEW_KEY_ID,
              Arn: NEW_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        if (cmd instanceof FakeEnableKeyRotationCommand) {
          return {};
        }
        if (cmd instanceof FakeCreateAliasCommand) {
          return {};
        }
        throw new Error(
          `Unexpected command on create-path: ${cmd?.constructor?.name}`,
        );
      });

      const result = await resolveOrCreateDefaultKmsKey({
        kms: makeKms(),
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
        runId: "ac-3-run",
      });

      expect(result).toEqual({
        keyArn: NEW_KEY_ARN,
        aliasName: DEFAULT_KMS_ALIAS_NAME,
        created: true,
      });

      // AC-3: tags applied inline via CreateKey
      const createKeyCmd = recordedCommands.find(
        (c): c is InstanceType<typeof FakeCreateKeyCommand> =>
          c instanceof FakeCreateKeyCommand,
      );
      expect(createKeyCmd).toBeDefined();
      const tags = createKeyCmd!.input.Tags ?? [];
      const tagSet = new Set(
        tags.map(
          (t: { TagKey: string; TagValue: string }) =>
            `${t.TagKey}=${t.TagValue}`,
        ),
      );
      expect(tagSet).toEqual(
        new Set([
          "managed-by=assignee-ai",
          "created-by=assignee-ai",
          "scope=default-encryption",
        ]),
      );

      // AC-7: no separate TagResource. Our mock SDK does not stub
      // TagResourceCommand at all — any `kms:TagResource` call would
      // hit the "Unexpected command" throw above. The test passes
      // therefore implies no separate TagResource was sent.
      // Identity-based assertion rather than constructor.name (vitest's
      // hoisted-mock wrappers mangle the class names).
      expect(recordedCommands).toHaveLength(4);
      expect(recordedCommands[0]).toBeInstanceOf(FakeListAliasesCommand);
      expect(recordedCommands[1]).toBeInstanceOf(FakeCreateKeyCommand);
      expect(recordedCommands[2]).toBeInstanceOf(FakeEnableKeyRotationCommand);
      expect(recordedCommands[3]).toBeInstanceOf(FakeCreateAliasCommand);

      // AC-9: apply_resource_created audit emit on the create-path.
      expect(mockAppendAuditRecord).toHaveBeenCalledTimes(1);
      const auditEvent = mockAppendAuditRecord.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(auditEvent["action"]).toBe("apply_resource_created");
      expect(auditEvent["resourceType"]).toBe("AWS::KMS::Key");
      expect(auditEvent["resourceArn"]).toBe(NEW_KEY_ARN);
      expect(auditEvent["region"]).toBe(TEST_REGION);
      expect(auditEvent["runId"]).toBe("ac-3-run");
      expect(auditEvent["desiredStateHash"]).toBe(DEFAULT_KMS_ALIAS_NAME);
      expect(typeof auditEvent["timestamp"]).toBe("string");

      // Structured info log on the create-path
      const infoCalls = mockLog.mock.calls.filter(
        (c) =>
          (c[0] as { action: string }).action ===
          LOG_ACTIONS.KMS_ALIAS_CMK_CREATED,
      );
      expect(infoCalls).toHaveLength(1);
    });
  });

  // ── AC-5 (race) ───────────────────────────────────────────────────────
  describe("CreateAlias race (AC-5 — orphan key scheduled for deletion)", () => {
    it("schedules orphan key for 7-day pending deletion and returns racing alias's keyArn", async () => {
      let listCallCount = 0;
      const recorded: unknown[] = [];
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        recorded.push(cmd);
        if (cmd instanceof FakeListAliasesCommand) {
          listCallCount++;
          if (listCallCount === 1) {
            return { Aliases: [], Truncated: false };
          }
          // Second list (post-race) finds the racing alias.
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: RACING_KEY_ID,
              },
            ],
            Truncated: false,
          };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: NEW_KEY_ID,
              Arn: NEW_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        if (cmd instanceof FakeEnableKeyRotationCommand) {
          return {};
        }
        if (cmd instanceof FakeCreateAliasCommand) {
          const err = new Error(
            "An alias with the name arn:aws:kms:us-east-1:112233445566:alias/assignee-default-encryption already exists",
          );
          (err as { name: string }).name = "AlreadyExistsException";
          throw err;
        }
        if (cmd instanceof FakeScheduleKeyDeletionCommand) {
          return {
            KeyId: NEW_KEY_ID,
            DeletionDate: new Date(Date.now() + 7 * 86_400_000),
          };
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: RACING_KEY_ID,
              Arn: RACING_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        throw new Error(`Unexpected: ${cmd?.constructor?.name}`);
      });

      const result = await resolveOrCreateDefaultKmsKey({
        kms: makeKms(),
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
        runId: "ac-5-run",
      });

      expect(result).toEqual({
        keyArn: RACING_KEY_ARN,
        aliasName: DEFAULT_KMS_ALIAS_NAME,
        created: false,
      });

      const scheduleCalls = recorded.filter(
        (c): c is InstanceType<typeof FakeScheduleKeyDeletionCommand> =>
          c instanceof FakeScheduleKeyDeletionCommand,
      );
      expect(scheduleCalls).toHaveLength(1);
      expect(scheduleCalls[0]!.input).toEqual({
        KeyId: NEW_KEY_ID,
        PendingWindowInDays: 7,
      });

      // The race also emits the structured KMS_ALIAS_RACE_LOST warning.
      const warnCalls = mockLog.mock.calls.filter(
        (c) =>
          (c[0] as { action: string }).action ===
          LOG_ACTIONS.KMS_ALIAS_RACE_LOST,
      );
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── AC-6 (stale alias) ────────────────────────────────────────────────
  describe("stale alias (AC-6)", () => {
    it("throws AssigneeError(KMS_ALIAS_STALE) when underlying key is PendingDeletion", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: EXISTING_KEY_ID,
              },
            ],
            Truncated: false,
          };
        }
        if (cmd instanceof FakeDescribeKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: EXISTING_KEY_ID,
              Arn: EXISTING_KEY_ARN,
              KeyState: "PendingDeletion",
            },
          };
        }
        throw new Error("unreachable");
      });

      await expect(
        resolveOrCreateDefaultKmsKey({
          kms: makeKms(),
          accountId: TEST_ACCOUNT,
          region: TEST_REGION,
        }),
      ).rejects.toMatchObject({
        name: "AssigneeError",
        code: "KMS_ALIAS_STALE",
      });
    });

    it("throws KMS_ALIAS_STALE for Disabled state too", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return {
            Aliases: [
              {
                AliasName: DEFAULT_KMS_ALIAS_NAME,
                TargetKeyId: EXISTING_KEY_ID,
              },
            ],
            Truncated: false,
          };
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
        throw new Error("unreachable");
      });

      const err = await resolveOrCreateDefaultKmsKey({
        kms: makeKms(),
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe("KMS_ALIAS_STALE");
    });
  });

  // ── AC-10 (rotation failure non-fatal) ───────────────────────────────
  describe("EnableKeyRotation failure (AC-10 — non-fatal)", () => {
    it("returns the keyArn anyway and emits KMS_ALIAS_RESOLVE_PARTIAL warning", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return { Aliases: [], Truncated: false };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: NEW_KEY_ID,
              Arn: NEW_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        if (cmd instanceof FakeEnableKeyRotationCommand) {
          const err = new Error(
            "User: arn:aws:iam::112233445566:user/assignee-operator is not authorized to perform: kms:EnableKeyRotation",
          );
          (err as { name: string }).name = "AccessDeniedException";
          throw err;
        }
        if (cmd instanceof FakeCreateAliasCommand) {
          return {};
        }
        throw new Error("unreachable");
      });

      const result = await resolveOrCreateDefaultKmsKey({
        kms: makeKms(),
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
        runId: "ac-10-run",
      });

      expect(result.keyArn).toBe(NEW_KEY_ARN);
      expect(result.created).toBe(true);

      const partialWarnings = mockLog.mock.calls.filter(
        (c) =>
          (c[0] as { action: string }).action ===
          LOG_ACTIONS.KMS_ALIAS_RESOLVE_PARTIAL,
      );
      expect(partialWarnings).toHaveLength(1);
      const evt = partialWarnings[0]![0] as {
        extras: { failedStep: string; failureReason: string };
      };
      expect(evt.extras.failedStep).toBe("EnableKeyRotation");
      expect(evt.extras.failureReason).toContain("kms:EnableKeyRotation");
    });
  });

  // ── Hard-error paths ──────────────────────────────────────────────────
  describe("error propagation", () => {
    it("propagates CreateKey errors as KMS_ALIAS_CREATE_FAILED is NOT used (only CreateAlias path uses it); CreateKey errors surface raw", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return { Aliases: [], Truncated: false };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          throw new Error("kms:CreateKey AccessDenied");
        }
        throw new Error("unreachable");
      });

      await expect(
        resolveOrCreateDefaultKmsKey({
          kms: makeKms(),
          accountId: TEST_ACCOUNT,
          region: TEST_REGION,
        }),
      ).rejects.toThrow("kms:CreateKey AccessDenied");
    });

    it("CreateAlias non-race failure surfaces as KMS_ALIAS_CREATE_FAILED", async () => {
      mockKmsSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof FakeListAliasesCommand) {
          return { Aliases: [], Truncated: false };
        }
        if (cmd instanceof FakeCreateKeyCommand) {
          return {
            KeyMetadata: {
              KeyId: NEW_KEY_ID,
              Arn: NEW_KEY_ARN,
              KeyState: "Enabled",
            },
          };
        }
        if (cmd instanceof FakeEnableKeyRotationCommand) {
          return {};
        }
        if (cmd instanceof FakeCreateAliasCommand) {
          throw new Error("kms:CreateAlias ThrottlingException");
        }
        throw new Error("unreachable");
      });

      const err = await resolveOrCreateDefaultKmsKey({
        kms: makeKms(),
        accountId: TEST_ACCOUNT,
        region: TEST_REGION,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe("KMS_ALIAS_CREATE_FAILED");
    });
  });
});
