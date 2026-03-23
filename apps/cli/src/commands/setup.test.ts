import { describe, it, expect, vi, beforeEach } from "vitest";
import { IAM_USER_NAMES, IAM_POLICY_NAMES } from "@assignee/core";

// Mock @aws-sdk/client-iam
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-iam", () => {
  return {
    IAMClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
    CreateUserCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "CreateUser", input })),
    GetUserCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "GetUser", input })),
    CreatePolicyCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "CreatePolicy", input })),
    CreatePolicyVersionCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "CreatePolicyVersion", input })),
    AttachUserPolicyCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "AttachUserPolicy", input })),
    CreateAccessKeyCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "CreateAccessKey", input })),
    ListAccessKeysCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "ListAccessKeys", input })),
    ListPolicyVersionsCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "ListPolicyVersions", input })),
    DeletePolicyVersionCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "DeletePolicyVersion", input })),
    DeleteAccessKeyCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "DeleteAccessKey", input })),
  };
});

// Mock @aws-sdk/client-sts
const mockStsSend = vi.fn();
vi.mock("@aws-sdk/client-sts", () => {
  return {
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
    GetCallerIdentityCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "GetCallerIdentity", input })),
  };
});

// Mock @clack/prompts
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  confirm: vi.fn(() => true),
  isCancel: vi.fn(() => false),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
}));

// Mock env-writer
const mockMergeEnvFile = vi.fn();
vi.mock("../utils/env-writer.js", () => ({
  mergeEnvFile: (...args: unknown[]) => mockMergeEnvFile(...args),
}));

// Mock process.exit
const mockExit = vi
  .spyOn(process, "exit")
  .mockImplementation(() => undefined as never);

describe("setup command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: STS returns an account ID
    mockStsSend.mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:root",
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
    await setupCommand.parseAsync(["node", "setup"]);

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
