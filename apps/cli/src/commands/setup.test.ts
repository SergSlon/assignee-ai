import { describe, it, expect, vi, beforeEach } from "vitest";
import { IAM_USER_NAMES, IAM_POLICY_NAMES } from "@assignee/core";

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

// Mock CloudWatch Logs and Bedrock clients (used by Bedrock logging setup)
const mockCwlSend = vi.fn().mockResolvedValue({});
vi.mock("@aws-sdk/client-cloudwatch-logs", () => {
  class CloudWatchLogsClient {
    send = mockCwlSend;
  }
  return {
    CloudWatchLogsClient,
    CreateLogGroupCommand: makeCommandClass("CreateLogGroup"),
  };
});

const mockBedrockSend = vi.fn().mockResolvedValue({});
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

let mockExit: any;

/**
 * Resets Commander option state between tests. Commander persists parsed
 * option values on the Command instance, so flags from one test (e.g.
 * --enable-llm-logging) would otherwise leak into the next.
 */
async function resetSetupCommandOptions(): Promise<void> {
  const { setupCommand } = await import("./setup.js");
  setupCommand.setOptionValue("enableLlmLogging", false);
  setupCommand.setOptionValue("dryRun", false);
}

describe("setup command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    // Re-arm Bedrock and CWL default resolutions wiped by mockReset.
    mockBedrockSend.mockResolvedValue({});
    mockCwlSend.mockResolvedValue({});

    // Default: STS returns an account ID
    mockStsSend.mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:root",
    });

    // Default: Bedrock client send resolves successfully (mockReset clears it)
    mockBedrockSend.mockResolvedValue({});

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

  it("creates 3 managed policies with correct names", async () => {
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    const createPolicyCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "CreatePolicy",
    );
    expect(createPolicyCalls).toHaveLength(3);

    const policyNames = createPolicyCalls.map((c) => c[0].input["PolicyName"]);
    expect(policyNames).toContain(IAM_POLICY_NAMES.operator);
    expect(policyNames).toContain(IAM_POLICY_NAMES.reader);
    expect(policyNames).toContain(IAM_POLICY_NAMES.auditor);
  });

  it("attaches each policy to its user", async () => {
    const { setupCommand } = await import("./setup.js");
    await setupCommand.parseAsync(["node", "setup"]);

    const attachCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "AttachUserPolicy",
    );
    expect(attachCalls).toHaveLength(3);
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

    // Should call CreatePolicyVersion (update existing)
    const policyVersionCalls = mockSend.mock.calls.filter(
      (c) => c[0]._type === "CreatePolicyVersion",
    );
    expect(policyVersionCalls).toHaveLength(3);
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
    const allText = stepMock.mock.calls.map((c) => c[0] as string).join("\n");
    // Real IAM user names from @assignee/core
    expect(allText).toContain(IAM_USER_NAMES.operator);
    expect(allText).toContain(IAM_USER_NAMES.reader);
    expect(allText).toContain(IAM_USER_NAMES.auditor);
    expect(allText).toContain(IAM_POLICY_NAMES.operator);
    expect(allText).toContain("AssigneeAiBedrockLoggingRole");
    expect(allText).toContain("/assignee-ai/bedrock-invocations");
    // Default dry-run shows textDataDeliveryEnabled=false
    expect(allText).toContain("textDataDeliveryEnabled=false");
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

  it("--help text mentions --enable-llm-logging, --dry-run, and PRIVACY", async () => {
    const { setupCommand } = await import("./setup.js");
    const help = setupCommand.helpInformation();
    expect(help).toContain("--enable-llm-logging");
    expect(help).toContain("--dry-run");
    expect(help).toContain("PRIVACY");
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

    // Make process.exit actually halt execution (throw) so code after the
    // exit call cannot run and accidentally write .env.
    mockExit.mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });

    await resetSetupCommandOptions();
    const { setupCommand } = await import("./setup.js");
    await expect(setupCommand.parseAsync(["node", "setup"])).rejects.toThrow(
      /process\.exit\(1\)/,
    );

    // process.exit(1) was called
    expect(mockExit).toHaveBeenCalledWith(1);
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
