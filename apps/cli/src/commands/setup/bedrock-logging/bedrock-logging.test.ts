/**
 * Unit tests for the 5 phase helpers extracted from setupBedrockLogging
 * by story 54-it1-09. Each helper is tested independently against
 * realistic AWS SDK mocks (matching $metadata shape + realistic ARNs).
 *
 * These complement — do NOT replace — the integration-style assertions
 * in apps/cli/src/commands/setup.test.ts that exercise the orchestrator
 * end-to-end via `setupCommand.parseAsync(...)`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Realistic AWS SDK $metadata shape reused by every mock response.
const SUCCESS_METADATA = {
  $metadata: {
    httpStatusCode: 200,
    requestId: "test-req-unit",
    attempts: 1,
    totalRetryDelay: 0,
  },
} as const;

// Mock @aws-sdk/client-iam — class-based so vitest mockReset (which is
// enabled project-wide) can't strip the constructor body. See the
// same pattern in apps/cli/src/commands/setup.test.ts for rationale.
const mockIamSend = vi.fn();
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
    send = mockIamSend;
  }
  return {
    IAMClient,
    GetRoleCommand: makeCommandClass("GetRole"),
    CreateRoleCommand: makeCommandClass("CreateRole"),
    TagRoleCommand: makeCommandClass("TagRole"),
    PutRolePolicyCommand: makeCommandClass("PutRolePolicy"),
  };
});

const mockCwlSend = vi.fn();
vi.mock("@aws-sdk/client-cloudwatch-logs", () => {
  class CloudWatchLogsClient {
    send = mockCwlSend;
  }
  return {
    CloudWatchLogsClient,
    CreateLogGroupCommand: makeCommandClass("CreateLogGroup"),
    PutResourcePolicyCommand: makeCommandClass("PutResourcePolicy"),
  };
});

const mockBedrockSend = vi.fn();
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

// Mock clack so log.step / log.warn don't write to stdout during tests.
vi.mock("@clack/prompts", () => ({
  log: {
    step: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

// Real account id (12 digits, like AWS) and real-shaped partition.
const ACCOUNT_ID = "123456789012";
const REGION = "us-east-1";
const PARTITION = "aws";

beforeEach(() => {
  mockIamSend.mockReset();
  mockCwlSend.mockReset();
  mockBedrockSend.mockReset();
});

describe("ensureIamRole", () => {
  it("verifies existing role (GetRole succeeds) and tags it", async () => {
    const { IAMClient } = await import("@aws-sdk/client-iam");
    const iam = new IAMClient({});
    mockIamSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetRole") {
        return Promise.resolve({
          Role: { RoleName: "AssigneeAiBedrockLoggingRole" },
          ...SUCCESS_METADATA,
        });
      }
      if (cmd._type === "TagRole") return Promise.resolve(SUCCESS_METADATA);
      throw new Error(`unexpected command ${cmd._type}`);
    });

    const { ensureIamRole } = await import("./ensure-iam-role.js");
    await ensureIamRole(iam);

    const types = mockIamSend.mock.calls.map((c) => c[0]._type);
    expect(types).toEqual(["GetRole", "TagRole"]);
    // CreateRole was NOT called — idempotent verify path.
    expect(types).not.toContain("CreateRole");
  });

  it("creates role when GetRole throws NoSuchEntityException, then tags it", async () => {
    const { IAMClient } = await import("@aws-sdk/client-iam");
    const iam = new IAMClient({});
    mockIamSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetRole") {
        throw Object.assign(new Error("Role not found"), {
          name: "NoSuchEntityException",
        });
      }
      return Promise.resolve(SUCCESS_METADATA);
    });

    const { ensureIamRole } = await import("./ensure-iam-role.js");
    await ensureIamRole(iam);

    const types = mockIamSend.mock.calls.map((c) => c[0]._type);
    expect(types).toEqual(["GetRole", "CreateRole", "TagRole"]);

    // Verify trust policy targets bedrock.amazonaws.com.
    const createCmd = mockIamSend.mock.calls.find(
      (c) => c[0]._type === "CreateRole",
    )!;
    const doc = JSON.parse(createCmd[0].input.AssumeRolePolicyDocument);
    expect(doc.Statement[0].Principal.Service).toBe("bedrock.amazonaws.com");
    expect(doc.Statement[0].Action).toBe("sts:AssumeRole");
  });

  it("propagates unexpected errors (non-NoSuchEntity) from GetRole", async () => {
    const { IAMClient } = await import("@aws-sdk/client-iam");
    const iam = new IAMClient({});
    mockIamSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "GetRole") {
        throw Object.assign(new Error("Access denied"), {
          name: "AccessDeniedException",
        });
      }
      return Promise.resolve(SUCCESS_METADATA);
    });

    const { ensureIamRole } = await import("./ensure-iam-role.js");
    await expect(ensureIamRole(iam)).rejects.toThrow("Access denied");

    // TagRole was never reached — error short-circuits.
    const types = mockIamSend.mock.calls.map((c) => c[0]._type);
    expect(types).not.toContain("TagRole");
  });
});

describe("ensureInlinePolicy", () => {
  it("writes BedrockLoggingPolicy with partition-aware log-group ARN", async () => {
    const { IAMClient } = await import("@aws-sdk/client-iam");
    const iam = new IAMClient({});
    mockIamSend.mockResolvedValue(SUCCESS_METADATA);

    const { ensureInlinePolicy } = await import("./ensure-inline-policy.js");
    await ensureInlinePolicy({
      iam,
      partition: PARTITION,
      region: REGION,
      accountId: ACCOUNT_ID,
    });

    expect(mockIamSend).toHaveBeenCalledTimes(1);
    const cmd = mockIamSend.mock.calls[0]![0];
    expect(cmd._type).toBe("PutRolePolicy");
    expect(cmd.input.RoleName).toBe("AssigneeAiBedrockLoggingRole");
    expect(cmd.input.PolicyName).toBe("BedrockLoggingPolicy");
    const doc = JSON.parse(cmd.input.PolicyDocument);
    expect(doc.Statement[0].Resource).toBe(
      "arn:aws:logs:us-east-1:123456789012:log-group:/assignee-ai/bedrock-invocations:*",
    );
    // All four log actions are present (no extras).
    expect(doc.Statement[0].Action).toEqual(
      expect.arrayContaining([
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
      ]),
    );
  });

  it("respects a GovCloud partition in the resource ARN", async () => {
    const { IAMClient } = await import("@aws-sdk/client-iam");
    const iam = new IAMClient({});
    mockIamSend.mockResolvedValue(SUCCESS_METADATA);

    const { ensureInlinePolicy } = await import("./ensure-inline-policy.js");
    await ensureInlinePolicy({
      iam,
      partition: "aws-us-gov",
      region: "us-gov-west-1",
      accountId: ACCOUNT_ID,
    });

    const cmd = mockIamSend.mock.calls[0]![0];
    const doc = JSON.parse(cmd.input.PolicyDocument);
    expect(doc.Statement[0].Resource).toMatch(/^arn:aws-us-gov:logs:/);
  });
});

describe("ensureLogGroup", () => {
  it("creates the log group when it does not exist", async () => {
    const { CloudWatchLogsClient } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const cwl = new CloudWatchLogsClient({});
    mockCwlSend.mockResolvedValue(SUCCESS_METADATA);

    const { ensureLogGroup } = await import("./ensure-log-group.js");
    await ensureLogGroup(cwl);

    expect(mockCwlSend).toHaveBeenCalledTimes(1);
    const cmd = mockCwlSend.mock.calls[0]![0];
    expect(cmd._type).toBe("CreateLogGroup");
    expect(cmd.input.logGroupName).toBe("/assignee-ai/bedrock-invocations");
  });

  it("treats ResourceAlreadyExistsException as success (verified)", async () => {
    const { CloudWatchLogsClient } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const cwl = new CloudWatchLogsClient({});
    mockCwlSend.mockImplementation(() => {
      throw Object.assign(new Error("Already exists"), {
        name: "ResourceAlreadyExistsException",
      });
    });

    const { ensureLogGroup } = await import("./ensure-log-group.js");
    await expect(ensureLogGroup(cwl)).resolves.toBeUndefined();
  });

  it("propagates unrelated errors", async () => {
    const { CloudWatchLogsClient } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const cwl = new CloudWatchLogsClient({});
    mockCwlSend.mockImplementation(() => {
      throw Object.assign(new Error("Throttled"), {
        name: "ThrottlingException",
      });
    });

    const { ensureLogGroup } = await import("./ensure-log-group.js");
    await expect(ensureLogGroup(cwl)).rejects.toThrow("Throttled");
  });
});

describe("ensureLogGroupReadRestriction", () => {
  it("PutResourcePolicy is called with a partition-aware policy document", async () => {
    const { CloudWatchLogsClient } =
      await import("@aws-sdk/client-cloudwatch-logs");
    const cwl = new CloudWatchLogsClient({});
    mockCwlSend.mockResolvedValue(SUCCESS_METADATA);

    const { ensureLogGroupReadRestriction } =
      await import("./ensure-log-group-read-restriction.js");
    await ensureLogGroupReadRestriction({
      cwl,
      partition: PARTITION,
      region: REGION,
      accountId: ACCOUNT_ID,
    });

    expect(mockCwlSend).toHaveBeenCalledTimes(1);
    const cmd = mockCwlSend.mock.calls[0]![0];
    expect(cmd._type).toBe("PutResourcePolicy");
    expect(cmd.input.policyName).toBe(
      "AssigneeAiBedrockLoggingReadRestriction",
    );
    const doc = JSON.parse(cmd.input.policyDocument);
    expect(doc.Statement[0].Effect).toBe("Deny");
    expect(doc.Statement[0].Resource).toMatch(/^arn:aws:logs:us-east-1:/);
    // Only operator + root may read (StringNotEquals is the deny filter).
    const allowed = doc.Statement[0].Condition.StringNotEquals[
      "aws:PrincipalArn"
    ] as string[];
    expect(allowed).toHaveLength(2);
    expect(allowed[0]).toMatch(
      /^arn:aws:iam::123456789012:user\/assignee-operator$/,
    );
    expect(allowed[1]).toBe("arn:aws:iam::123456789012:root");
  });
});

describe("enableModelInvocationLogging", () => {
  it("writes logging config with textDataDeliveryEnabled=false by default", async () => {
    const { BedrockClient } = await import("@aws-sdk/client-bedrock");
    const bedrock = new BedrockClient({});
    mockBedrockSend.mockResolvedValue(SUCCESS_METADATA);

    const { enableModelInvocationLogging } =
      await import("./ensure-model-invocation-logging.js");
    await enableModelInvocationLogging({
      bedrock,
      partition: PARTITION,
      accountId: ACCOUNT_ID,
      enableLlmLogging: false,
    });

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    const cmd = mockBedrockSend.mock.calls[0]![0];
    expect(cmd._type).toBe("PutModelInvocationLogging");
    const cfg = cmd.input.loggingConfig;
    expect(cfg.textDataDeliveryEnabled).toBe(false);
    expect(cfg.imageDataDeliveryEnabled).toBe(false);
    expect(cfg.embeddingDataDeliveryEnabled).toBe(false);
    expect(cfg.cloudWatchConfig.roleArn).toBe(
      "arn:aws:iam::123456789012:role/AssigneeAiBedrockLoggingRole",
    );
    expect(cfg.cloudWatchConfig.logGroupName).toBe(
      "/assignee-ai/bedrock-invocations",
    );

    // No warn was emitted — text logging is OFF.
    const clack = await import("@clack/prompts");
    expect(clack.log.warn).not.toHaveBeenCalled();
  });

  it("writes textDataDeliveryEnabled=true AND warns the user when opt-in", async () => {
    const { BedrockClient } = await import("@aws-sdk/client-bedrock");
    const bedrock = new BedrockClient({});
    mockBedrockSend.mockResolvedValue(SUCCESS_METADATA);
    const clack = await import("@clack/prompts");
    (clack.log.warn as ReturnType<typeof vi.fn>).mockClear();

    const { enableModelInvocationLogging } =
      await import("./ensure-model-invocation-logging.js");
    await enableModelInvocationLogging({
      bedrock,
      partition: PARTITION,
      accountId: ACCOUNT_ID,
      enableLlmLogging: true,
    });

    const cfg = mockBedrockSend.mock.calls[0]![0].input.loggingConfig;
    expect(cfg.textDataDeliveryEnabled).toBe(true);

    // Privacy warning points at the AWS CLI command to disable later.
    expect(clack.log.warn).toHaveBeenCalled();
    const warnText = (clack.log.warn as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(warnText).toContain("LLM prompts/responses will be logged");
    expect(warnText).toContain("put-model-invocation-logging-configuration");
  });

  it("uses partition-aware role ARN for China/GovCloud regions", async () => {
    const { BedrockClient } = await import("@aws-sdk/client-bedrock");
    const bedrock = new BedrockClient({});
    mockBedrockSend.mockResolvedValue(SUCCESS_METADATA);

    const { enableModelInvocationLogging } =
      await import("./ensure-model-invocation-logging.js");
    await enableModelInvocationLogging({
      bedrock,
      partition: "aws-cn",
      accountId: ACCOUNT_ID,
      enableLlmLogging: false,
    });

    const cfg = mockBedrockSend.mock.calls[0]![0].input.loggingConfig;
    expect(cfg.cloudWatchConfig.roleArn).toMatch(/^arn:aws-cn:iam::/);
  });
});

describe("buildBedrockLogReadRestriction (unit)", () => {
  it("emits a Deny-unless-operator-or-root statement with partition-aware ARNs", async () => {
    const { buildBedrockLogReadRestriction } =
      await import("./read-restriction-policy.js");
    const json = buildBedrockLogReadRestriction({
      partition: PARTITION,
      accountId: ACCOUNT_ID,
      region: REGION,
    });
    const doc = JSON.parse(json);
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Effect).toBe("Deny");
    expect(doc.Statement[0].Action).toEqual([
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartQuery",
    ]);
    // Partition-aware ARN for the log group (not literal `arn:aws:`).
    expect(doc.Statement[0].Resource).toMatch(
      /^arn:aws[\w-]*:logs:us-east-1:123456789012:log-group:/,
    );
  });
});
