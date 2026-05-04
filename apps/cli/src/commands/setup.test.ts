import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MockInstance } from "vitest";
import {
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
  AssigneeError,
} from "@assignee/core";
import { ErrorCode } from "../constants/errors.js";

// Mock @aws-sdk/client-iam
//
// NOTE: vitest config has `mockReset: true`, which wipes any
// `vi.fn().mockImplementation(() => ...)` factory between tests. We use
// plain `class` declarations for the SDK client constructors so that the
// mockReset cannot strip the constructor body — only the hoisted send mock
// gets reset (and we re-arm it in beforeEach). Command shapes are arrow
// functions for the same reason.
const mockSend = vi.fn();
// SUT calls `new XCommand(input)` so commands must be constructable. We
// use `class` declarations (rather than vi.fn().mockImplementation) so
// vitest mockReset cannot strip the constructor body.
function makeCommandClass(type: string) {
  return class {
    _type = type;
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}

vi.mock("@aws-sdk/client-iam", () => {
  class IAMClient {
    send = mockSend;
  }
  return {
    IAMClient,
    CreateUserCommand: makeCommandClass("CreateUser"),
    GetUserCommand: makeCommandClass("GetUser"),
    CreatePolicyCommand: makeCommandClass("CreatePolicy"),
    CreatePolicyVersionCommand: makeCommandClass("CreatePolicyVersion"),
    AttachUserPolicyCommand: makeCommandClass("AttachUserPolicy"),
    CreateAccessKeyCommand: makeCommandClass("CreateAccessKey"),
    ListAccessKeysCommand: makeCommandClass("ListAccessKeys"),
    ListPolicyVersionsCommand: makeCommandClass("ListPolicyVersions"),
    DeletePolicyVersionCommand: makeCommandClass("DeletePolicyVersion"),
    DeleteAccessKeyCommand: makeCommandClass("DeleteAccessKey"),
    GetRoleCommand: makeCommandClass("GetRole"),
    CreateRoleCommand: makeCommandClass("CreateRole"),
    PutRolePolicyCommand: makeCommandClass("PutRolePolicy"),
    TagUserCommand: makeCommandClass("TagUser"),
    TagRoleCommand: makeCommandClass("TagRole"),
    TagPolicyCommand: makeCommandClass("TagPolicy"),
  };
});

// Mock CloudWatch Logs and Bedrock clients (used by Bedrock logging setup).
// The commands actually dispatched to these clients — CreateLogGroupCommand,
// PutResourcePolicyCommand, PutModelInvocationLoggingConfigurationCommand —
// are all "empty-success" in the AWS SDK (real response carries only
// $metadata; no business fields). Use a realistic $metadata shape as the
// default so the mock is honest against the SDK contract.
const mockCwlSend = vi.fn().mockResolvedValue({
  $metadata: {
    httpStatusCode: 200,
    requestId: "test-req-cwl-default",
    attempts: 1,
    totalRetryDelay: 0,
  },
});
vi.mock("@aws-sdk/client-cloudwatch-logs", () => {
  class CloudWatchLogsClient {
    send = mockCwlSend;
  }
  return {
    CloudWatchLogsClient,
    CreateLogGroupCommand: makeCommandClass("CreateLogGroup"),
    // Story 50-5 H-2: bedrock-logging.ts now calls PutResourcePolicy
    // to restrict Bedrock log-group reads to operator + root.
    PutResourcePolicyCommand: makeCommandClass("PutResourcePolicy"),
  };
});

const mockBedrockSend = vi.fn().mockResolvedValue({
  $metadata: {
    httpStatusCode: 200,
    requestId: "test-req-bedrock-default",
    attempts: 1,
    totalRetryDelay: 0,
  },
});
vi.mock("@aws-sdk/client-bedrock", () => {
  class BedrockClient {
    send = mockBedrockSend;
  }
  return {
    BedrockClient,
    PutModelInvocationLoggingConfigurationCommand: makeCommandClass(
      "PutModelInvocationLogging",
    ),
  };
});

// Mock @aws-sdk/credential-providers — capture which profile
// fromNodeProviderChain() was called with so the AWS_PROFILE-honoring
// regression test (L1) can assert it. Switched from fromIni to
// fromNodeProviderChain so SSO / AWS Identity Center / login_session profiles
// resolve cleanly (fromIni misses those formats and triggers a downstream
// EntityReplacer XML-parse failure when STS rejects the empty creds).
const mockFromIni = vi.fn((opts: { profile: string }) => {
  // Return a real-shaped credentials provider function that resolves to a
  // synthetic credential set. STS calls are intercepted at the SDK layer so
  // these never hit the network.
  return async () => ({
    accessKeyId: `AKIA_${opts.profile.toUpperCase()}`,
    secretAccessKey: `secret_${opts.profile}`,
  });
});
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: (opts: { profile: string }) => mockFromIni(opts),
}));

// Mock @aws-sdk/client-sts
const mockStsSend = vi.fn();
vi.mock("@aws-sdk/client-sts", () => {
  class STSClient {
    send = mockStsSend;
  }
  return {
    STSClient,
    GetCallerIdentityCommand: makeCommandClass("GetCallerIdentity"),
  };
});

// Mock @clack/prompts. spinner/confirm/isCancel use plain arrow factories
// so they survive vitest mockReset between tests.
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    warn: vi.fn(),
  },
  spinner: () => ({
    start: () => undefined,
    stop: () => undefined,
  }),
  confirm: () => true,
  isCancel: () => false,
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
}));

// Mock env-writer
const mockMergeEnvFile = vi.fn();
vi.mock("../utils/env-writer.js", () => ({
  mergeEnvFile: (...args: unknown[]) => mockMergeEnvFile(...args),
}));

// process.exit spy is installed in beforeEach so restoreMocks doesn't bring
// the real exit back between tests.

let mockExit: MockInstance;

/**
 * Resets Commander option state between tests. Commander persists parsed
 * option values on the Command instance, so flags from one test (e.g.
 * --enable-llm-logging) would otherwise leak into the next.
 */
async function resetSetupCommandOptions(): Promise<void> {
  const { setupCommand } = await import("./setup.js");
  setupCommand.setOptionValue("enableLlmLogging", false);
  setupCommand.setOptionValue("disableLlmLogging", false);
  setupCommand.setOptionValue("dryRun", false);
  // L1 V1 audit: --profile must also be reset between tests so the
  // AWS_PROFILE-fallback regression test sees a clean slate.
  setupCommand.setOptionValue("profile", undefined);
}

describe("setup command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    // Re-arm Bedrock and CWL default resolutions wiped by mockReset.
    // Commands dispatched here are empty-success SDK commands; realistic
    // shape is just $metadata.
    mockBedrockSend.mockResolvedValue({
      $metadata: {
        httpStatusCode: 200,
        requestId: "test-req-bedrock-rearm",
        attempts: 1,
        totalRetryDelay: 0,
      },
    });
    mockCwlSend.mockResolvedValue({
      $metadata: {
        httpStatusCode: 200,
        requestId: "test-req-cwl-rearm",
        attempts: 1,
        totalRetryDelay: 0,
      },
    });

    // Default: STS returns an account ID
    mockStsSend.mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:root",
    });

    // Default: Bedrock client send resolves successfully (mockReset clears it)
    mockBedrockSend.mockResolvedValue({
      $metadata: {
        httpStatusCode: 200,
        requestId: "test-req-bedrock-default-rearm",
        attempts: 1,
        totalRetryDelay: 0,
      },
    });

    // Default IAM responses
    let accessKeyCounter = 0;
    mockSend.mockImplementation(
      (cmd: { _type: string; input: Record<string, unknown> }) => {
        switch (cmd._type) {
          case "GetUser":
            // User does not exist (trigger create path)
            throw Object.assign(new Error("User not found"), {
              name: "NoSuchEntityException",
            });
          case "CreateUser":
            return { User: { UserName: cmd.input["UserName"] } };
          case "CreatePolicy":
            return {
              Policy: {
                Arn: `arn:aws:iam::123456789012:policy/${cmd.input["PolicyName"]}`,
              },
            };
          case "AttachUserPolicy":
            return {};
          case "CreateAccessKey":
            accessKeyCounter++;
            return {
              AccessKey: {
                AccessKeyId: `AKIA_TEST_${accessKeyCounter}`,
                SecretAccessKey: `secret_${accessKeyCounter}`,
              },
            };
          case "ListAccessKeys":
            return { AccessKeyMetadata: [] };
          default:
            return {};
        }
      },
    );
  });

  it("creates 3 IAM users with correct names", async () => {
    // Dynamic import to ensure mocks are active
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    const createUserCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "CreateUser",
    );
    expect(createUserCalls).toHaveLength(3);

    const userNames = createUserCalls.map((c) => c[0].input["UserName"]);
    expect(userNames).toContain(IAM_USER_NAMES.operator);
    expect(userNames).toContain(IAM_USER_NAMES.reader);
    expect(userNames).toContain(IAM_USER_NAMES.auditor);
  });

  it("creates 5 managed policies with correct names (operator split into core + servicesA + servicesB per (f) 2026-04-09)", async () => {
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    const createPolicyCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "CreatePolicy",
    );
    // 5 policies: operator core, operator servicesA, operator servicesB,
    // reader, auditor. The A/B split of the services half became
    // necessary when the single services policy dropped below the
    // 700-byte canary floor after A10-A14 resource type promotions.
    expect(createPolicyCalls).toHaveLength(5);

    const policyNames = createPolicyCalls.map((c) => c[0].input["PolicyName"]);
    expect(policyNames).toContain(IAM_POLICY_NAMES.operator);
    expect(policyNames).toContain(IAM_POLICY_NAMES.operatorServicesA);
    expect(policyNames).toContain(IAM_POLICY_NAMES.operatorServicesB);
    expect(policyNames).toContain(IAM_POLICY_NAMES.reader);
    expect(policyNames).toContain(IAM_POLICY_NAMES.auditor);
  });

  it("attaches each policy to its user (5 attachments after the A/B split)", async () => {
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    const attachCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "AttachUserPolicy",
    );
    expect(attachCalls).toHaveLength(5);
    // All THREE operator policies must attach to the operator user.
    const operatorAttachments = attachCalls.filter(
      (c) => c[0].input["UserName"] === IAM_USER_NAMES.operator,
    );
    expect(operatorAttachments).toHaveLength(3);
  });

  it("creates access keys for each user", async () => {
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    const createKeyCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "CreateAccessKey",
    );
    expect(createKeyCalls).toHaveLength(3);
  });

  it("writes credentials to .env", async () => {
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    expect(mockMergeEnvFile).toHaveBeenCalledTimes(1);
    const envUpdates = mockMergeEnvFile.mock.calls[0]![1];
    expect(envUpdates).toHaveProperty("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    expect(envUpdates).toHaveProperty("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
    expect(envUpdates).toHaveProperty("ASSIGNEE_READER_ACCESS_KEY_ID");
    expect(envUpdates).toHaveProperty("ASSIGNEE_READER_SECRET_ACCESS_KEY");
    expect(envUpdates).toHaveProperty("ASSIGNEE_AUDITOR_ACCESS_KEY_ID");
    expect(envUpdates).toHaveProperty("ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY");
  });

  it("handles idempotent path when users already exist", async () => {
    // Override: users already exist
    mockSend.mockImplementation(
      (cmd: { _type: string; input: Record<string, unknown> }) => {
        switch (cmd._type) {
          case "GetUser":
            return { User: { UserName: cmd.input["UserName"] } }; // Exists
          case "CreatePolicy": {
            const err = Object.assign(new Error("Already exists"), {
              name: "EntityAlreadyExistsException",
            });
            throw err;
          }
          case "ListPolicyVersions":
            return {
              Versions: [
                {
                  VersionId: "v1",
                  IsDefaultVersion: true,
                  CreateDate: new Date(),
                },
              ],
            };
          case "CreatePolicyVersion":
            return {};
          case "AttachUserPolicy":
            return {};
          case "ListAccessKeys":
            return { AccessKeyMetadata: [] }; // No keys — will create
          case "CreateAccessKey":
            return {
              AccessKey: {
                AccessKeyId: "AKIA_EXISTING",
                SecretAccessKey: "secret_existing",
              },
            };
          default:
            return {};
        }
      },
    );

    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    // Should not call CreateUser (users exist)
    const createUserCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "CreateUser",
    );
    expect(createUserCalls).toHaveLength(0);

    // Should call CreatePolicyVersion (update existing) — 5 policies
    // after the (f) 2026-04-09 A/B split (operator core + operator
    // servicesA + operator servicesB + reader + auditor).
    const policyVersionCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "CreatePolicyVersion",
    );
    expect(policyVersionCalls).toHaveLength(5);
  });

  it("exits with error when STS fails", async () => {
    mockStsSend.mockRejectedValue(new Error("STS unreachable"));

    const { setupCommand } = await import("./setup.js");

    await expect(setupCommand.parseAsync(["node", "setup"])).rejects.toThrow(
      "Cannot reach AWS STS",
    );
  });

  // ── Privacy/safety: --enable-llm-logging default OFF ─────────────
  it("by default does NOT enable Bedrock textDataDeliveryEnabled", async () => {
    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    const putLogCalls = mockBedrockSend.mock.calls.filter(
      (c) => c[0]?._type === "PutModelInvocationLogging",
    );
    expect(putLogCalls).toHaveLength(1);
    const config = putLogCalls[0]![0].input.loggingConfig;
    expect(config.textDataDeliveryEnabled).toBe(false);
    expect(config.imageDataDeliveryEnabled).toBe(false);
    expect(config.embeddingDataDeliveryEnabled).toBe(false);
    // Real-shaped role ARN — account 123456789012 from STS mock above
    expect(config.cloudWatchConfig.roleArn).toBe(
      "arn:aws:iam::123456789012:role/AssigneeAiBedrockLoggingRole",
    );
    expect(config.cloudWatchConfig.logGroupName).toBe(
      "/assignee-ai/bedrock-invocations",
    );
  });

  it("--enable-llm-logging sets textDataDeliveryEnabled and prints a warning", async () => {
    await resetSetupCommandOptions();
    const clack = await import("@clack/prompts");
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup", "--enable-llm-logging"]);

    const putLogCalls = mockBedrockSend.mock.calls.filter(
      (c) => c[0]?._type === "PutModelInvocationLogging",
    );
    expect(putLogCalls).toHaveLength(1);
    const config = putLogCalls[0]![0].input.loggingConfig;
    expect(config.textDataDeliveryEnabled).toBe(true);

    // Warning was emitted to the user
    const warnMock = clack.log.warn as ReturnType<typeof vi.fn>;
    expect(warnMock).toHaveBeenCalled();
    const warnText = warnMock.mock.calls[0]![0] as string;
    expect(warnText).toContain("LLM prompts/responses will be logged");
    expect(warnText).toContain("disable later via");
  });

  // ── --dry-run safety: zero AWS mutations ─────────────────────────
  it("--dry-run prints a plan and does not invoke any AWS API", async () => {
    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup", "--dry-run"]);

    // STS not called — no credential verification roundtrip
    expect(mockStsSend).not.toHaveBeenCalled();
    // No IAM calls of any kind
    expect(mockSend).not.toHaveBeenCalled();
    // No Bedrock invocation logging configuration call
    expect(mockBedrockSend).not.toHaveBeenCalled();
    // No .env file written
    expect(mockMergeEnvFile).not.toHaveBeenCalled();

    // The plan was printed via clack.log.step
    const clack = await import("@clack/prompts");
    const stepMock = clack.log.step as ReturnType<typeof vi.fn>;
    const stepTexts = stepMock.mock.calls.map((c) => c[0] as string);
    const allText = stepTexts.join("\n");
    // Real IAM user names from @assignee/core
    expect(allText).toContain(IAM_USER_NAMES.operator);
    expect(allText).toContain(IAM_USER_NAMES.reader);
    expect(allText).toContain(IAM_USER_NAMES.auditor);
    expect(allText).toContain(IAM_POLICY_NAMES.operator);
    expect(allText).toContain("AssigneeAiBedrockLoggingRole");
    expect(allText).toContain("/assignee-ai/bedrock-invocations");
    // Default dry-run shows textDataDeliveryEnabled=false
    expect(allText).toContain("textDataDeliveryEnabled=false");

    // UX (M-T1): The dry-run plan must be rendered as 5 multi-line
    // step calls (one per section) — NOT one step per IAM resource. The
    // previous implementation called clack.log.step ~14 times which
    // doubled the visible row count thanks to clack's `│` connectors.
    //
    // Sections: IAM Users, IAM Managed Policies, IAM Access Keys,
    // Bedrock infrastructure, Files written. = 5 steps total.
    expect(stepTexts).toHaveLength(5);

    // The "IAM Users" section must be a single multi-line string
    // containing all 3 user names — proves it was emitted as one block.
    // Wave 18: strengthened all four section assertions below — replaced
    // bare `toBeDefined()` with `typeof === "string"` checks. The
    // previous form would have passed for any non-undefined value
    // (e.g. a number, an object) and the `.toContain()` chain would
    // throw a confusing diagnostic. The string check anchors the
    // section at its expected shape.
    const usersSection = stepTexts.find((s) => s.startsWith("IAM Users:"));
    expect(typeof usersSection).toBe("string");
    expect(usersSection).toContain(IAM_USER_NAMES.operator);
    expect(usersSection).toContain(IAM_USER_NAMES.reader);
    expect(usersSection).toContain(IAM_USER_NAMES.auditor);
    // Must contain 3 newlines (header + 3 users = 4 lines, 3 newlines)
    expect((usersSection!.match(/\n/g) ?? []).length).toBe(3);

    // Similar for the policies section. (f) 2026-04-09: 5 policies
    // because the operator role now splits into core + servicesA +
    // servicesB (services split into two byte-balanced halves to
    // stay below 6144 per managed policy). The dry-run text is one
    // entry per policy, so the expected newline count is 5 (header +
    // 5 policies = 6 lines, 5 newlines).
    const policiesSection = stepTexts.find((s) =>
      s.startsWith("IAM Managed Policies:"),
    );
    expect(typeof policiesSection).toBe("string");
    expect(policiesSection).toContain(IAM_POLICY_NAMES.operator);
    expect(policiesSection).toContain(IAM_POLICY_NAMES.operatorServicesA);
    expect(policiesSection).toContain(IAM_POLICY_NAMES.operatorServicesB);
    expect(policiesSection).toContain(IAM_POLICY_NAMES.reader);
    expect(policiesSection).toContain(IAM_POLICY_NAMES.auditor);
    expect((policiesSection!.match(/\n/g) ?? []).length).toBe(5);

    // Access keys section must be one block listing all 3 env var pairs.
    const keysSection = stepTexts.find((s) => s.startsWith("IAM Access Keys:"));
    expect(typeof keysSection).toBe("string");
    expect(keysSection).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    expect(keysSection).toContain("ASSIGNEE_READER_ACCESS_KEY_ID");
    expect(keysSection).toContain("ASSIGNEE_AUDITOR_ACCESS_KEY_ID");
    expect((keysSection!.match(/\n/g) ?? []).length).toBe(3);

    // Bedrock infrastructure must be ONE block with role + policy + log
    // group + logging-config sub-lines (4 sub-lines = 4 newlines).
    const bedrockSection = stepTexts.find((s) =>
      s.startsWith("Bedrock invocation logging infrastructure:"),
    );
    expect(typeof bedrockSection).toBe("string");
    expect(bedrockSection).toContain("AssigneeAiBedrockLoggingRole");
    expect(bedrockSection).toContain("BedrockLoggingPolicy");
    expect(bedrockSection).toContain("/assignee-ai/bedrock-invocations");
    expect(bedrockSection).toContain("textDataDeliveryEnabled=false");
    expect((bedrockSection!.match(/\n/g) ?? []).length).toBe(4);
  });

  it("--dry-run with --enable-llm-logging shows planned text logging and warns", async () => {
    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync([
      "node",
      "setup",
      "--dry-run",
      "--enable-llm-logging",
    ]);

    // Still no AWS calls
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();

    const clack = await import("@clack/prompts");
    const stepMock = clack.log.step as ReturnType<typeof vi.fn>;
    const allText = stepMock.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allText).toContain("textDataDeliveryEnabled=true");

    const warnMock = clack.log.warn as ReturnType<typeof vi.fn>;
    expect(warnMock).toHaveBeenCalled();
    const warnText = warnMock.mock.calls[0]![0] as string;
    expect(warnText).toContain("--enable-llm-logging");
  });

  // ── L1 V1 audit (2026-04-06): AWS_PROFILE env fallback ─────────────
  it("honors process.env.AWS_PROFILE when --profile is not provided", async () => {
    vi.stubEnv("AWS_PROFILE", "myprofile");
    try {
      await resetSetupCommandOptions();
      const { setupCommand } = await import("./setup.js");
      await setupCommand.parseAsync(["node", "setup"]);

      // fromNodeProviderChain() must have been called at least once with the
      // AWS_PROFILE value, NOT silently with "default".
      expect(mockFromIni).toHaveBeenCalled();
      const profilesUsed = mockFromIni.mock.calls.map(
        (c) => (c[0] as { profile: string }).profile,
      );
      expect(profilesUsed).toContain("myprofile");
      expect(profilesUsed).not.toContain("default");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("--profile flag overrides process.env.AWS_PROFILE", async () => {
    vi.stubEnv("AWS_PROFILE", "envprofile");
    try {
      await resetSetupCommandOptions();
      const { setupCommand } = await import("./setup.js");
      await setupCommand.parseAsync([
        "node",
        "setup",
        "--profile",
        "flagprofile",
      ]);

      const profilesUsed = mockFromIni.mock.calls.map(
        (c) => (c[0] as { profile: string }).profile,
      );
      expect(profilesUsed).toContain("flagprofile");
      expect(profilesUsed).not.toContain("envprofile");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to 'default' profile when neither --profile nor AWS_PROFILE set", async () => {
    // Ensure AWS_PROFILE is not set in test env
    const prev = process.env["AWS_PROFILE"];
    delete process.env["AWS_PROFILE"];
    try {
      await resetSetupCommandOptions();
      const { setupCommand } = await import("./setup.js");
      await setupCommand.parseAsync(["node", "setup"]);

      const profilesUsed = mockFromIni.mock.calls.map(
        (c) => (c[0] as { profile: string }).profile,
      );
      expect(profilesUsed).toContain("default");
    } finally {
      if (prev !== undefined) process.env["AWS_PROFILE"] = prev;
    }
  });

  it("--help text mentions --enable-llm-logging, --dry-run, and PRIVACY", async () => {
    const { setupCommand } = await import("./setup.js");
    const help = setupCommand.helpInformation();
    expect(help).toContain("--enable-llm-logging");
    expect(help).toContain("--dry-run");
    expect(help).toContain("PRIVACY");
  });

  // ── Sally UX: --disable-llm-logging symmetric to --enable ─────────
  //
  // The CLI previously only exposed --enable-llm-logging, forcing users to
  // drop back to raw `aws bedrock put-model-invocation-logging-configuration`
  // calls to turn logging back off. These tests cover the new
  // --disable-llm-logging flag which flips textDataDeliveryEnabled=false
  // without re-running the IAM wizard.

  it("--disable-llm-logging calls Bedrock with the disable config and no IAM mutations", async () => {
    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup", "--disable-llm-logging"]);

    // STS is still called (we need the account id for the role ARN)
    expect(mockStsSend).toHaveBeenCalled();

    // IAM is NOT touched — no users, no policies, no access keys
    const iamTypes = mockSend.mock.calls.map(
      (c) => (c[0] as { _type: string })._type,
    );
    expect(iamTypes).not.toContain("CreateUser");
    expect(iamTypes).not.toContain("CreatePolicy");
    expect(iamTypes).not.toContain("AttachUserPolicy");
    expect(iamTypes).not.toContain("CreateAccessKey");

    // Bedrock PutModelInvocationLoggingConfiguration IS called, with
    // textDataDeliveryEnabled=false
    const putLogCalls = mockBedrockSend.mock.calls.filter(
      (c) => c[0]?._type === "PutModelInvocationLogging",
    );
    expect(putLogCalls).toHaveLength(1);
    const config = putLogCalls[0]![0].input.loggingConfig;
    expect(config.textDataDeliveryEnabled).toBe(false);
    expect(config.imageDataDeliveryEnabled).toBe(false);
    expect(config.embeddingDataDeliveryEnabled).toBe(false);
    // Real-shaped role ARN using the mocked account id 123456789012
    expect(config.cloudWatchConfig.roleArn).toBe(
      "arn:aws:iam::123456789012:role/AssigneeAiBedrockLoggingRole",
    );
    expect(config.cloudWatchConfig.logGroupName).toBe(
      "/assignee-ai/bedrock-invocations",
    );

    // No .env writes in the disable path
    expect(mockMergeEnvFile).not.toHaveBeenCalled();
  });

  it("--disable-llm-logging --dry-run prints a plan and makes ZERO AWS calls", async () => {
    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync([
      "node",
      "setup",
      "--disable-llm-logging",
      "--dry-run",
    ]);

    // Absolutely no AWS calls: STS, IAM, Bedrock, CWL, env writes.
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockCwlSend).not.toHaveBeenCalled();
    expect(mockMergeEnvFile).not.toHaveBeenCalled();

    // The plan was printed through clack.log.step, and explicitly names the
    // disable target.
    const clack = await import("@clack/prompts");
    const stepMock = clack.log.step as ReturnType<typeof vi.fn>;
    const stepTexts = stepMock.mock.calls.map((c) => c[0] as string);
    const allText = stepTexts.join("\n");
    expect(allText).toContain("DISABLE");
    expect(allText).toContain("textDataDeliveryEnabled: false");
    expect(allText).toContain("/assignee-ai/bedrock-invocations");
    expect(allText).toContain("AssigneeAiBedrockLoggingRole");
  });

  it("--enable-llm-logging combined with --disable-llm-logging fails with a mutually-exclusive error", async () => {
    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");

    let caughtError: unknown;
    try {
      await setupCommand.parseAsync([
        "node",
        "setup",
        "--enable-llm-logging",
        "--disable-llm-logging",
      ]);
    } catch (err) {
      caughtError = err;
    }

    // Must throw an AssigneeError with USAGE_ERROR code so errorToExitCode
    // maps to exit 73 (USAGE_ERROR) — not exit 1 (GENERIC_ERROR).
    // Mirror of W9-S4 fix on init.ts (--wizard + --yes mutex).
    expect(caughtError).toBeInstanceOf(AssigneeError);
    expect((caughtError as AssigneeError).code).toBe(ErrorCode.USAGE_ERROR);
    expect((caughtError as AssigneeError).message).toMatch(
      /mutually exclusive/i,
    );

    // No AWS calls of any kind happened — the guard fires before the
    // intro/spinner/credentials path.
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockMergeEnvFile).not.toHaveBeenCalled();
  });

  // ── M-S11: operator role is REQUIRED — partial failure aborts ─────

  it("aborts with exit(1) and does NOT write .env when operator role fails", async () => {
    // Override IAM mock so the operator user creation throws but reader/auditor succeed.
    let accessKeyCounter = 0;
    mockSend.mockImplementation(
      (cmd: { _type: string; input: Record<string, unknown> }) => {
        switch (cmd._type) {
          case "GetUser":
            // User does not exist anywhere → triggers CreateUser
            throw Object.assign(new Error("User not found"), {
              name: "NoSuchEntityException",
            });
          case "CreateUser":
            if (cmd.input["UserName"] === IAM_USER_NAMES.operator) {
              throw new Error("AccessDenied: cannot create operator");
            }
            return { User: { UserName: cmd.input["UserName"] } };
          case "CreatePolicy":
            return {
              Policy: {
                Arn: `arn:aws:iam::123456789012:policy/${cmd.input["PolicyName"]}`,
              },
            };
          case "AttachUserPolicy":
            return {};
          case "CreateAccessKey":
            accessKeyCounter++;
            return {
              AccessKey: {
                AccessKeyId: `AKIA_TEST_${accessKeyCounter}`,
                SecretAccessKey: `secret_${accessKeyCounter}`,
              },
            };
          case "ListAccessKeys":
            return { AccessKeyMetadata: [] };
          default:
            return {};
        }
      },
    );

    // W15-S1: source uses process.exitCode = GENERIC_ERROR; return (not process.exit(1)).
    // The command returns normally after setting exitCode — no throw needed.
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    // process.exitCode must be 1 (GENERIC_ERROR) — process.exit must NOT be called.
    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    process.exitCode = prevExitCode;
    // .env was NOT written — operator missing
    expect(mockMergeEnvFile).not.toHaveBeenCalled();

    // Error message mentions operator REQUIRED
    const clack = await import("@clack/prompts");
    const errorMock = clack.log.error as ReturnType<typeof vi.fn>;
    const allErrors = errorMock.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allErrors).toContain("Operator role failed");
    expect(allErrors).toMatch(/REQUIRED/i);
  });

  // ── M-S12: ListPolicyVersions defensive — all 5 are default ───────

  it("skips policy update when all 5 policy versions are marked default", async () => {
    // This is impossible per AWS spec but the code must defend against it
    // and avoid the cryptic LimitExceeded that would come from CreatePolicyVersion.
    let createPolicyVersionCalled = 0;
    mockSend.mockImplementation(
      (cmd: { _type: string; input: Record<string, unknown> }) => {
        switch (cmd._type) {
          case "GetUser":
            return { User: { UserName: cmd.input["UserName"] } };
          case "CreatePolicy":
            throw Object.assign(new Error("Already exists"), {
              name: "EntityAlreadyExistsException",
            });
          case "ListPolicyVersions":
            return {
              Versions: [
                {
                  VersionId: "v1",
                  IsDefaultVersion: true,
                  CreateDate: new Date(),
                },
                {
                  VersionId: "v2",
                  IsDefaultVersion: true,
                  CreateDate: new Date(),
                },
                {
                  VersionId: "v3",
                  IsDefaultVersion: true,
                  CreateDate: new Date(),
                },
                {
                  VersionId: "v4",
                  IsDefaultVersion: true,
                  CreateDate: new Date(),
                },
                {
                  VersionId: "v5",
                  IsDefaultVersion: true,
                  CreateDate: new Date(),
                },
              ],
            };
          case "CreatePolicyVersion":
            createPolicyVersionCalled++;
            // If reached, simulate the LimitExceeded the code is supposed to avoid
            throw Object.assign(new Error("LimitExceeded: too many versions"), {
              name: "LimitExceededException",
            });
          case "DeletePolicyVersion":
            return {};
          case "AttachUserPolicy":
            return {};
          case "ListAccessKeys":
            return { AccessKeyMetadata: [] };
          case "CreateAccessKey":
            return {
              AccessKey: {
                AccessKeyId: "AKIA_TEST",
                SecretAccessKey: "secret",
              },
            };
          default:
            return {};
        }
      },
    );

    // Spy on stderr.write to verify the warning is emitted
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    // CreatePolicyVersion must NEVER have been called → no LimitExceeded
    expect(createPolicyVersionCalled).toBe(0);

    // The defensive warning was written to stderr
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allWrites).toContain("none are non-default");
    expect(allWrites).toContain("Skipping policy update");

    stderrSpy.mockRestore();
  });

  // ── M-S10: spinner stops when Bedrock setup throws ────────────────

  it("Bedrock setup error stops the spinner via finally (no leak)", async () => {
    // Make TagRoleCommand throw — this is inside the Bedrock-logging block
    // and after the spinner.start(). Without try/finally the spinner would
    // be left running.
    mockSend.mockImplementation(
      (cmd: { _type: string; input: Record<string, unknown> }) => {
        switch (cmd._type) {
          case "GetUser":
            throw Object.assign(new Error("User not found"), {
              name: "NoSuchEntityException",
            });
          case "CreateUser":
            return { User: { UserName: cmd.input["UserName"] } };
          case "CreatePolicy":
            return {
              Policy: {
                Arn: `arn:aws:iam::123456789012:policy/${cmd.input["PolicyName"]}`,
              },
            };
          case "AttachUserPolicy":
            return {};
          case "CreateAccessKey":
            return {
              AccessKey: {
                AccessKeyId: "AKIA_TEST",
                SecretAccessKey: "secret",
              },
            };
          case "ListAccessKeys":
            return { AccessKeyMetadata: [] };
          case "GetRole":
            // Role does not exist → CreateRole next
            throw Object.assign(new Error("Role not found"), {
              name: "NoSuchEntityException",
            });
          case "CreateRole":
            return { Role: { RoleName: cmd.input["RoleName"] } };
          case "TagRole":
            // The throw point — happens AFTER logSp.start() but BEFORE logSp.stop()
            throw new Error("AccessDenied: cannot tag bedrock role");
          default:
            return {};
        }
      },
    );

    // Track spinner lifecycle. Replace the spinner factory used by setup.ts
    // so we can observe start/stop calls. Re-mock @clack/prompts piece.
    const startCalls: string[] = [];
    const stopCalls: string[] = [];
    const clack = await import("@clack/prompts");
    (clack as unknown as { spinner: () => unknown }).spinner = () => ({
      start: (msg?: string) => {
        startCalls.push(msg ?? "");
      },
      stop: (msg?: string) => {
        stopCalls.push(msg ?? "");
      },
    });

    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");

    await expect(setupCommand.parseAsync(["node", "setup"])).rejects.toThrow(
      /cannot tag bedrock role/,
    );

    // Both spinner.start AND spinner.stop must have run for the Bedrock block
    const bedrockStarts = startCalls.filter((m) =>
      m.includes("Bedrock invocation logging"),
    );
    expect(bedrockStarts.length).toBeGreaterThanOrEqual(1);
    // The finally block must have stopped it with the failure label
    const bedrockStops = stopCalls.filter((m) => m.includes("Bedrock logging"));
    expect(bedrockStops.length).toBeGreaterThanOrEqual(1);
    expect(bedrockStops.some((m) => m.includes("failed"))).toBe(true);
  });
});
