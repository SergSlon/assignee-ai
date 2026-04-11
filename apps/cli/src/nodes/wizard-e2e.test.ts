/**
 * E2E wizard flow tests — simulate complete user journeys through optionElicitorNode
 * and plan generator to catch integration bugs like placeholder value leaks.
 *
 * These tests mock clack prompts at the transport level (select/text/confirm)
 * and exercise the full flow: field resolution, prompt loop, showIf gates,
 * advanced tier, and plan generation with elicited options.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExecutionStatus, MockLlmAdapter } from "@assignee/core";

// ── Module mocks (must be before imports) ────────────────────────────────────

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  note: vi.fn(),
}));

vi.mock("@assignee/best-practices", () => ({
  loadBestPractices: () => [],
}));

vi.mock("../utils/aws-resource-discovery.js", () => ({
  discoverAmis: vi.fn().mockResolvedValue([]),
  discoverSubnets: vi.fn().mockResolvedValue([]),
  discoverSecurityGroups: vi.fn().mockResolvedValue([]),
  discoverKeyPairs: vi.fn().mockResolvedValue([]),
  discoverInstanceTypes: vi.fn().mockResolvedValue(null),
  discoverRdsEngineVersions: vi.fn().mockResolvedValue([]),
  discoverRdsInstanceClasses: vi.fn().mockResolvedValue([]),
  discoverLambdaRuntimes: vi.fn().mockResolvedValue([]),
  clearDiscoveryCache: vi.fn(),
  resolveAmiFromOsName: vi.fn().mockResolvedValue(null),
  DiscoveryCacheKey: {
    AMIS: "discover-amis",
    SUBNETS: "discover-subnets",
    KEY_PAIRS: "discover-key-pairs",
    SECURITY_GROUPS: "discover-security-groups",
    RDS_ENGINE_VERSIONS: "discover-rds-engine-versions",
    RDS_INSTANCE_CLASSES: "discover-rds-instance-classes",
    LAMBDA_RUNTIMES: "discover-lambda-runtimes",
  },
}));

vi.mock("../utils/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/display.js")>();
  return {
    ...actual,
    renderOptionPrompt: vi.fn(actual.renderOptionPrompt),
    renderAdvancedConfirm: vi.fn(actual.renderAdvancedConfirm),
    renderDocHelp: vi.fn().mockResolvedValue("Doc help text"),
    renderTradeoffHelp: vi.fn().mockResolvedValue("Trade-off text"),
    startSpinner: vi.fn(),
    stopSpinner: vi.fn(),
  };
});

// Story 27.4: Mock config loaders — return undefined by default (no config)
vi.mock("../config/user-config-loader.js", () => ({
  loadUserConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/project-config-loader.js", () => ({
  loadProjectConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/org-policy-cache.js", () => ({
  readAuthToken: vi.fn().mockResolvedValue(undefined),
  fetchOrgPolicy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/memory.js", () => ({
  defaultMemoryService: {
    readProvisions: vi.fn().mockResolvedValue([]),
    readFailures: vi.fn().mockResolvedValue([]),
    readPatterns: vi.fn().mockResolvedValue([]),
  },
}));

// ── Dynamic imports (after mocks) ────────────────────────────────────────────

const { confirm, select, text } = await import("@clack/prompts");
const { optionElicitorNode } = await import("./option-elicitor.js");
const { createPlanGeneratorNode, applyToCfnTransforms } =
  await import("./plan-generator.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Known placeholder values that should never appear in final output. */
const KNOWN_PLACEHOLDERS = [
  "ami-0abcdef1234567890",
  "my-key-pair",
  "subnet-0abc1234",
  "sg-0abc1234",
  "arn:aws:iam::123456789012:role/my-role",
  "my-instance-profile",
  "placeholder",
  "CHANGE_ME",
  "example",
];

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

type ElicitorState = Parameters<typeof optionElicitorNode>[0];

function makeElicitorState(
  overrides: Record<string, unknown> = {},
): ElicitorState {
  return {
    executionStatus: ExecutionStatus.PENDING,
    resourceType: "AWS::EC2::Instance",
    elicitedOptions: undefined,
    runId: "run-e2e-test",
    userIntent: "Create an EC2 instance",
    ...overrides,
  } as ElicitorState;
}

function makePlanState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create a resource",
    runId: "run-e2e-plan",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "plan",
    resourceType: "AWS::EC2::Instance",
    resourceSchema: {
      properties: {
        InstanceType: { type: "string" },
        ImageId: { type: "string" },
        KeyName: { type: "string" },
        SubnetId: { type: "string" },
        SecurityGroupIds: { type: "array" },
        Tags: { type: "array" },
      },
      required: ["InstanceType"],
    },
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<ReturnType<typeof createPlanGeneratorNode>>[0];
}

/** Recursively checks if any value in an object matches a known placeholder. */
function containsPlaceholder(obj: unknown): string | null {
  if (typeof obj === "string") {
    for (const ph of KNOWN_PLACEHOLDERS) {
      if (obj === ph || obj.includes(ph)) return ph;
    }
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = containsPlaceholder(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === "object" && obj !== null) {
    for (const val of Object.values(obj)) {
      const found = containsPlaceholder(val);
      if (found) return found;
    }
  }
  return null;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

/**
 * Wraps `vi.mocked(select).mockResolvedValueOnce` values so that any call
 * to the action-menu select (text-field back/help/skip) auto-returns "enter"
 * and doesn't consume from the queue.
 *
 * Story: wizard-back-navigation-ux — text fields now show a select action menu
 * before the actual text input when showBack=true. Tests that were written
 * before this change provide select mocks for real selects only, not for
 * action menus. This helper bridges that gap without rewriting every test.
 */
function isActionMenu(opts: unknown): boolean {
  if (!opts || typeof opts !== "object") return false;
  const options = (opts as { options?: Array<{ value?: unknown }> }).options;
  return Array.isArray(options) && options.some((o) => o?.value === "enter");
}

function installActionMenuAutoHandler(): void {
  const originalSelect = vi.mocked(select);
  // Use mockImplementation as the fallback: if the call is an action menu,
  // return "enter" immediately; otherwise, fall through to the queued
  // mockResolvedValueOnce responses. Vitest consumes Once values first,
  // so the queue is preserved for non-action-menu calls.
  //
  // We achieve this by saving the original queue behavior and wrapping.
  const queue: Array<unknown> = [];
  const realOnce = originalSelect.mockResolvedValueOnce.bind(originalSelect);
  originalSelect.mockResolvedValueOnce = ((value: unknown) => {
    queue.push(value);
    return originalSelect;
  }) as typeof originalSelect.mockResolvedValueOnce;

  originalSelect.mockImplementation(async (opts: unknown) => {
    if (isActionMenu(opts)) return "enter" as never;
    if (queue.length > 0) return queue.shift() as never;
    return undefined as never;
  });

  // Suppress unused warning
  void realOnce;
}

beforeEach(() => {
  vi.clearAllMocks();
  setTTY(true);
  installActionMenuAutoHandler();
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: undefined,
    configurable: true,
  });
  vi.resetAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// EC2 FLOWS
// ═════════════════════════════════════════════════════════════════════════════

describe("EC2 full flow — user skips optional fields", () => {
  it("excludes empty/skipped fields from elicitedOptions (no placeholder leak)", async () => {
    // EC2 fields (from real plugin):
    //   1. InstanceType (categorySelect) → select category, then select type
    //   2. ImageId (enum/fetcher → falls back to string) → text
    //   3. KeyName (enum/fetcher → falls back to string) → text
    //   4. SubnetId (enum/fetcher → falls back to string) → text
    //   5. SecurityGroupIds (multi/fetcher → skipped when options=[])
    //   6. Tags (string) → text
    //   7. Advanced confirm → No

    // Step 1: InstanceType categorySelect
    vi.mocked(select)
      .mockResolvedValueOnce("burstable") // category selection
      .mockResolvedValueOnce("t3.small"); // instance type within category

    // Steps 2-4: ImageId, KeyName, SubnetId, SecurityGroupIds — all fall back to text
    // (discovery returns [] and no static fallback → converted to string type)
    // User presses Enter (empty) to skip each
    vi.mocked(text)
      .mockResolvedValueOnce("") // ImageId (skipped)
      .mockResolvedValueOnce("") // KeyName (skipped)
      .mockResolvedValueOnce("") // SubnetId (skipped)
      .mockResolvedValueOnce("") // SecurityGroupIds (multi→string fallback, skipped)
      .mockResolvedValueOnce(""); // Tags (skipped)

    // Advanced tier
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState());

    // InstanceType should be captured
    expect(result.elicitedOptions?.["InstanceType"]).toBe("t3.small");

    // Skipped fields should NOT appear with placeholder values
    const elicited = result.elicitedOptions ?? {};
    const placeholder = containsPlaceholder(elicited);
    expect(placeholder).toBeNull();

    // Empty string values should not be present in elicitedOptions
    // (the node filters out empty strings: `if (answer !== undefined && answer !== "")`)
    expect(elicited["ImageId"]).toBeUndefined();
    expect(elicited["KeyName"]).toBeUndefined();
    expect(elicited["SubnetId"]).toBeUndefined();
    expect(elicited["Tags"]).toBeUndefined();
  });
});

describe("EC2 full flow — user provides values", () => {
  it("stores user-provided values correctly in elicitedOptions", async () => {
    // InstanceType categorySelect + ImageId enum (static fallback)
    vi.mocked(select)
      .mockResolvedValueOnce("burstable") // category
      .mockResolvedValueOnce("t3.medium") // instance type
      .mockResolvedValueOnce("amazon-linux-2023"); // ImageId (static fallback option)

    // Text fields: KeyName, SubnetId, SecurityGroupIds (multi→string fallback)
    vi.mocked(text)
      .mockResolvedValueOnce("my-ssh-key") // KeyName
      .mockResolvedValueOnce("subnet-abc123def") // SubnetId
      .mockResolvedValueOnce("sg-abc123"); // SecurityGroupIds (falls back to string)

    // Advanced = no (Tags is now in advancedFields, so it won't be prompted)
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState());

    expect(result.elicitedOptions?.["InstanceType"]).toBe("t3.medium");
    expect(result.elicitedOptions?.["ImageId"]).toBe("amazon-linux-2023");
    expect(result.elicitedOptions?.["KeyName"]).toBe("my-ssh-key");
    expect(result.elicitedOptions?.["SubnetId"]).toBe("subnet-abc123def");
    // Tags not prompted when advanced options declined
    expect(result.elicitedOptions?.["Tags"]).toBeUndefined();
  });
});

describe("EC2 full flow — user provides values and configures advanced", () => {
  it("captures advanced fields when user opts in", async () => {
    // InstanceType categorySelect + ImageId enum (static fallback)
    vi.mocked(select)
      .mockResolvedValueOnce("general") // category
      .mockResolvedValueOnce("m5.large") // instance type
      .mockResolvedValueOnce("ubuntu-24.04"); // ImageId (static fallback option)

    // Text fields: KeyName, SubnetId, SecurityGroupIds (multi→string), Tags
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName (skipped)
      .mockResolvedValueOnce("") // SubnetId (skipped)
      .mockResolvedValueOnce("") // SecurityGroupIds (multi→string fallback, skipped)
      .mockResolvedValueOnce("") // Tags (skipped)
      .mockResolvedValueOnce("my-profile") // IamInstanceProfile (advanced)
      .mockResolvedValueOnce(""); // UserData (skipped)

    // Advanced = yes
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await optionElicitorNode(makeElicitorState());

    expect(result.elicitedOptions?.["InstanceType"]).toBe("m5.large");
    expect(result.elicitedOptions?.["ImageId"]).toBe("ubuntu-24.04");
    expect(result.elicitedOptions?.["IamInstanceProfile"]).toBe("my-profile");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// S3 FLOWS
// ═════════════════════════════════════════════════════════════════════════════

describe("S3 full flow — with advanced lifecycle options", () => {
  it("captures bucket config with advanced lifecycle", async () => {
    // S3 commonFields:
    //   1. BucketName (string) → text
    //   2. BucketEncryption (boolean) → select (Yes/No/?)
    //   3. KMSMasterKeyID (string, showIf BucketEncryption=true) → text
    //   4. PublicAccessBlockConfiguration (boolean) → select
    //   5. VersioningConfiguration (boolean) → select
    //   6. Tags (string) → text

    vi.mocked(text)
      .mockResolvedValueOnce("my-data-bucket") // BucketName
      .mockResolvedValueOnce("") // KMSMasterKeyID (blank = SSE-S3)
      .mockResolvedValueOnce("") // Tags (skipped)
      .mockResolvedValueOnce("30") // LifecycleTransitionDays - but this is enum, handle via select
      .mockResolvedValueOnce("365"); // LifecycleExpirationDays (advanced, showIf)

    vi.mocked(select)
      .mockResolvedValueOnce("true") // BucketEncryption = Yes
      .mockResolvedValueOnce("true") // PublicAccessBlockConfiguration = Yes
      .mockResolvedValueOnce("false") // VersioningConfiguration = No
      .mockResolvedValueOnce("true") // EnableLifecycle = Yes (advanced)
      .mockResolvedValueOnce("30") // LifecycleTransitionDays (enum, showIf)
      .mockResolvedValueOnce("false") // EnableCors = No
      .mockResolvedValueOnce("false"); // EnableReplication = No

    // Advanced = yes
    vi.mocked(confirm).mockResolvedValueOnce(true);

    const result = await optionElicitorNode(
      makeElicitorState({
        resourceType: "AWS::S3::Bucket",
        userIntent: "Create an S3 bucket for data storage",
      }),
    );

    const elicited = result.elicitedOptions ?? {};
    expect(elicited["BucketName"]).toBe("my-data-bucket");
    expect(elicited["BucketEncryption"]).toBe(true);
    expect(elicited["PublicAccessBlockConfiguration"]).toBe(true);

    // Verify no placeholder values leaked
    const placeholder = containsPlaceholder(elicited);
    expect(placeholder).toBeNull();
  });
});

describe("S3 flow — encryption disabled hides KMS field", () => {
  it("does not prompt for KMSMasterKeyID when encryption is off", async () => {
    vi.mocked(text)
      .mockResolvedValueOnce("my-simple-bucket") // BucketName
      .mockResolvedValueOnce(""); // Tags

    vi.mocked(select)
      .mockResolvedValueOnce("false") // BucketEncryption = No
      .mockResolvedValueOnce("true") // PublicAccessBlockConfiguration = Yes
      .mockResolvedValueOnce("false"); // VersioningConfiguration = No

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(
      makeElicitorState({
        resourceType: "AWS::S3::Bucket",
        userIntent: "Create a simple S3 bucket",
      }),
    );

    const elicited = result.elicitedOptions ?? {};
    expect(elicited["BucketName"]).toBe("my-simple-bucket");
    expect(elicited["BucketEncryption"]).toBe(false);
    // KMSMasterKeyID should not be present (showIf: BucketEncryption=true)
    expect(elicited["KMSMasterKeyID"]).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RDS FLOWS
// ═════════════════════════════════════════════════════════════════════════════

describe("RDS full flow — all required fields", () => {
  it("captures engine, instance class and credentials", async () => {
    // RDS commonFields (discovery mocked to return []):
    //   1. DBInstanceClass (enum, fetcher → static fallback options) → select
    //   2. Engine (enum) → select
    //   3. EngineVersion × 5 (enum, showIf per engine, fetcher → static fallback)
    //   4. DBName (string) → text
    //   5. MasterUsername (string) → text
    //   6. MasterUserPassword (string) → text
    //   7. MultiAZ (boolean) → select
    //   8. DeletionProtection (boolean) → select
    //   9. StorageType (enum) → select
    //  10. AllocatedStorage (enum) → select
    //  11. Tags (string) → text

    vi.mocked(select)
      .mockResolvedValueOnce("db.t3.small") // DBInstanceClass
      .mockResolvedValueOnce("postgres") // Engine
      .mockResolvedValueOnce("16") // EngineVersion (postgres variant, matched by showIf)
      .mockResolvedValueOnce("false") // MultiAZ
      .mockResolvedValueOnce("false") // DeletionProtection
      .mockResolvedValueOnce("gp3") // StorageType
      .mockResolvedValueOnce("20"); // AllocatedStorage

    vi.mocked(text)
      .mockResolvedValueOnce("myappdb") // DBName
      .mockResolvedValueOnce("appuser") // MasterUsername
      .mockResolvedValueOnce("SecurePass123!") // MasterUserPassword
      .mockResolvedValueOnce(""); // Tags (skipped)

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(
      makeElicitorState({
        resourceType: "AWS::RDS::DBInstance",
        userIntent: "Create a PostgreSQL RDS instance",
      }),
    );

    const elicited = result.elicitedOptions ?? {};
    expect(elicited["Engine"]).toBe("postgres");
    expect(elicited["DBInstanceClass"]).toBe("db.t3.small");
    expect(elicited["MasterUsername"]).toBe("appuser");
    expect(elicited["MasterUserPassword"]).toBe("SecurePass123!");
    expect(elicited["DBName"]).toBe("myappdb");
    expect(elicited["StorageType"]).toBe("gp3");
    expect(elicited["AllocatedStorage"]).toBe("20");

    expect(elicited["EngineVersion"]).toBe("16");

    // No placeholders
    const placeholder = containsPlaceholder(elicited);
    expect(placeholder).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAMBDA FLOWS
// ═════════════════════════════════════════════════════════════════════════════

describe("Lambda full flow", () => {
  it("captures function name, runtime, handler, memory, timeout", async () => {
    // Lambda commonFields:
    //   1. FunctionName (string) → text
    //   2. Runtime (enum) → select
    //   3. Handler (string) → text
    //   4. Role (string) → text
    //   5. MemorySize (enum) → select
    //   6. Timeout (string) → text
    //   7. Environment (string, toCfn) → text
    //   8. Tags (string) → text

    vi.mocked(text)
      .mockResolvedValueOnce("my-api-handler") // FunctionName
      .mockResolvedValueOnce("index.handler") // Handler
      .mockResolvedValueOnce("") // Role (skipped — will be auto-created)
      .mockResolvedValueOnce("30") // Timeout
      .mockResolvedValueOnce("DB_HOST=localhost") // Environment
      .mockResolvedValueOnce(""); // Tags (skipped)

    vi.mocked(select)
      .mockResolvedValueOnce("nodejs22.x") // Runtime
      .mockResolvedValueOnce("256"); // MemorySize

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(
      makeElicitorState({
        resourceType: "AWS::Lambda::Function",
        userIntent: "Create a Lambda function for API",
      }),
    );

    const elicited = result.elicitedOptions ?? {};
    expect(elicited["FunctionName"]).toBe("my-api-handler");
    expect(elicited["Runtime"]).toBe("nodejs22.x");
    expect(elicited["Handler"]).toBe("index.handler");
    expect(elicited["MemorySize"]).toBe("256");
    expect(elicited["Timeout"]).toBe("30");
    expect(elicited["Environment"]).toBe("DB_HOST=localhost");

    // No placeholders
    const placeholder = containsPlaceholder(elicited);
    expect(placeholder).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PLAN GENERATOR — PLACEHOLDER LEAK REGRESSION
// ═════════════════════════════════════════════════════════════════════════════

describe("Plan generator does not inject placeholder values", () => {
  it("strips empty values from LLM response via stripEmpty", async () => {
    // Simulate an LLM that returns placeholder-looking values
    const llmResponse = JSON.stringify({
      InstanceType: "t3.small",
      ImageId: "", // empty — should be stripped
      KeyName: "", // empty — should be stripped
      SubnetId: "", // empty — should be stripped
    });

    const mock = new MockLlmAdapter(undefined, llmResponse);
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makePlanState({
        elicitedOptions: {
          InstanceType: "t3.small",
        },
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    expect(ds["InstanceType"]).toBe("t3.small");
    // Empty strings from LLM should have been stripped
    expect(ds["ImageId"]).toBeUndefined();
    expect(ds["KeyName"]).toBeUndefined();
    expect(ds["SubnetId"]).toBeUndefined();
  });

  it("elicited options override LLM values without introducing placeholders", async () => {
    const llmResponse = JSON.stringify({
      InstanceType: "t3.micro", // LLM guess
      ImageId: "ami-0abcdef1234567890", // placeholder from LLM
    });

    const mock = new MockLlmAdapter(undefined, llmResponse);
    const node = createPlanGeneratorNode({ llmClient: mock });

    // User only provided InstanceType, skipped ImageId
    const result = await node(
      makePlanState({
        elicitedOptions: {
          InstanceType: "t3.small",
          // ImageId not provided by user — should still show LLM value
        },
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    // User's choice overrides LLM
    expect(ds["InstanceType"]).toBe("t3.small");
  });

  it("S3 toCfn transforms produce correct CFN structure, not raw booleans", async () => {
    const llmResponse = JSON.stringify({
      BucketName: "my-bucket",
    });

    const mock = new MockLlmAdapter(undefined, llmResponse);
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makePlanState({
        resourceType: "AWS::S3::Bucket",
        resourceSchema: {
          properties: {
            BucketName: { type: "string" },
            BucketEncryption: { type: "object" },
            PublicAccessBlockConfiguration: { type: "object" },
            VersioningConfiguration: { type: "object" },
          },
          required: ["BucketName"],
        },
        elicitedOptions: {
          BucketName: "my-bucket",
          BucketEncryption: true,
          PublicAccessBlockConfiguration: true,
          VersioningConfiguration: false, // user said No
        },
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    expect(ds["BucketName"]).toBe("my-bucket");

    // BucketEncryption should be transformed to CFN structure
    expect(ds["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });

    // PublicAccessBlockConfiguration should be transformed
    expect(ds["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });

    // VersioningConfiguration was false → toCfn returns undefined → omitted
    expect(ds["VersioningConfiguration"]).toBeUndefined();
  });

  it("empty elicitedOptions values do not produce placeholder CFN output", async () => {
    const llmResponse = JSON.stringify({
      InstanceType: "t3.small",
    });

    const mock = new MockLlmAdapter(undefined, llmResponse);
    const node = createPlanGeneratorNode({ llmClient: mock });

    // Simulate user who skipped all optional fields
    const result = await node(
      makePlanState({
        elicitedOptions: {
          InstanceType: "t3.small",
          // All other fields skipped (empty strings filtered out by optionElicitorNode)
        },
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    const placeholder = containsPlaceholder(ds);
    expect(placeholder).toBeNull();
    expect(ds["InstanceType"]).toBe("t3.small");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// toCfn TRANSFORM INTEGRATION — EC2 Tags
// ═════════════════════════════════════════════════════════════════════════════

describe("EC2 Tags toCfn transform", () => {
  it("transforms comma-separated tag string to CFN Tags array", () => {
    const result = applyToCfnTransforms(
      {
        InstanceType: "t3.small",
        Tags: "env:production, team:backend",
      },
      "AWS::EC2::Instance",
    );

    expect(result["InstanceType"]).toBe("t3.small");
    expect(result["Tags"]).toEqual([
      { Key: "env", Value: "production" },
      { Key: "team", Value: "backend" },
    ]);
  });

  it("omits Tags when user provides empty string", () => {
    const result = applyToCfnTransforms(
      {
        InstanceType: "t3.small",
        Tags: "",
      },
      "AWS::EC2::Instance",
    );

    expect(result["Tags"]).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Lambda Environment toCfn transform
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// EC2 "Other" FLOW — LLM-ASSISTED VALUE INPUT
// ═════════════════════════════════════════════════════════════════════════════

describe('EC2 "Other" flow — user types a description (not exact value)', () => {
  it("uses LLM to suggest an instance type from a description", async () => {
    const mockLlm = new MockLlmAdapter(
      // structuredResponse — for classifyWorkload
      { profile: "general-purpose", confidence: 0.9 },
      // textResponse — for "Other" LLM suggestion
      "p3.2xlarge",
    );

    // InstanceType categorySelect: category → __other__
    vi.mocked(select).mockResolvedValueOnce("__other__");

    // ImageId: static fallback (discovery fails, static options present) → select
    vi.mocked(select).mockResolvedValueOnce("amazon-linux-2023");

    // "Other" flow: text input for description
    vi.mocked(text).mockResolvedValueOnce("gpu for ml training");

    // "Other" flow: confirm LLM suggestion
    vi.mocked(confirm).mockResolvedValueOnce(true);

    // Remaining text fields: KeyName, SubnetId, SecurityGroupIds (multi→string), Tags
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName
      .mockResolvedValueOnce("") // SubnetId
      .mockResolvedValueOnce("") // SecurityGroupIds
      .mockResolvedValueOnce(""); // Tags

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState(), [], mockLlm);

    expect(result.elicitedOptions?.["InstanceType"]).toBe("p3.2xlarge");
    expect(result.elicitedOptions?.["ImageId"]).toBe("amazon-linux-2023");
  });
});

describe('EC2 "Other" flow — user types exact value like "t3.nano"', () => {
  it("accepts exact AWS value without LLM call", async () => {
    // InstanceType categorySelect: category → __other__
    vi.mocked(select).mockResolvedValueOnce("__other__");

    // "Other" flow: text input — exact value with dot (no LLM needed)
    vi.mocked(text).mockResolvedValueOnce("t3.nano");

    // ImageId: static fallback → select
    vi.mocked(select).mockResolvedValueOnce("amazon-linux-2023");

    // Remaining text fields: KeyName, SubnetId, SecurityGroupIds, Tags
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName
      .mockResolvedValueOnce("") // SubnetId
      .mockResolvedValueOnce("") // SecurityGroupIds
      .mockResolvedValueOnce(""); // Tags

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState());

    expect(result.elicitedOptions?.["InstanceType"]).toBe("t3.nano");
  });
});

describe('EC2 "Other" flow — user types plain word "linux" (goes to LLM)', () => {
  it("sends plain description to LLM for suggestion", async () => {
    const mockLlm = new MockLlmAdapter(
      { profile: "burstable", confidence: 0.8 },
      "t3.small",
    );

    // InstanceType categorySelect: category → __other__
    vi.mocked(select).mockResolvedValueOnce("__other__");

    // "Other" flow: text input — plain word (no dot, no prefix → LLM)
    vi.mocked(text).mockResolvedValueOnce("linux");

    // "Other" flow: confirm LLM suggestion
    vi.mocked(confirm).mockResolvedValueOnce(true);

    // ImageId: static fallback → select
    vi.mocked(select).mockResolvedValueOnce("amazon-linux-2023");

    // Remaining text fields: KeyName, SubnetId, SecurityGroupIds, Tags
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName
      .mockResolvedValueOnce("") // SubnetId
      .mockResolvedValueOnce("") // SecurityGroupIds
      .mockResolvedValueOnce(""); // Tags

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState(), [], mockLlm);

    expect(result.elicitedOptions?.["InstanceType"]).toBe("t3.small");
  });
});

describe("EC2 ImageId with static fallback — user picks OS from menu", () => {
  it("stays as enum when discovery fails but static options exist", async () => {
    // InstanceType categorySelect
    vi.mocked(select)
      .mockResolvedValueOnce("burstable") // category
      .mockResolvedValueOnce("t3.micro"); // instance type

    // ImageId: discovery returns [] → static fallback options stay as enum → select
    vi.mocked(select).mockResolvedValueOnce("amazon-linux-2023");

    // Text fields: KeyName, SubnetId, SecurityGroupIds, Tags
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName
      .mockResolvedValueOnce("") // SubnetId
      .mockResolvedValueOnce("") // SecurityGroupIds
      .mockResolvedValueOnce(""); // Tags

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState());

    // ImageId should be the OS shorthand, NOT an ami- ID
    expect(result.elicitedOptions?.["ImageId"]).toBe("amazon-linux-2023");
    expect(result.elicitedOptions?.["InstanceType"]).toBe("t3.micro");
  });
});

describe("EC2 all fields skipped except InstanceType and ImageId", () => {
  it("elicitedOptions only contains fields with non-empty values", async () => {
    // InstanceType categorySelect
    vi.mocked(select)
      .mockResolvedValueOnce("burstable") // category
      .mockResolvedValueOnce("t3.micro"); // instance type

    // ImageId static fallback → select
    vi.mocked(select).mockResolvedValueOnce("amazon-linux-2023");

    // All text fields blank: KeyName, SubnetId, SecurityGroupIds, Tags
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName
      .mockResolvedValueOnce("") // SubnetId
      .mockResolvedValueOnce("") // SecurityGroupIds
      .mockResolvedValueOnce(""); // Tags

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState());

    const elicited = result.elicitedOptions ?? {};
    // Only InstanceType and ImageId should be present
    expect(elicited["InstanceType"]).toBe("t3.micro");
    expect(elicited["ImageId"]).toBe("amazon-linux-2023");

    // Blanks should be excluded (common fields skipped by user)
    expect(elicited["KeyName"]).toBeUndefined();
    expect(elicited["SubnetId"]).toBeUndefined();
    expect(elicited["SecurityGroupIds"]).toBeUndefined();
    expect(elicited["Tags"]).toBeUndefined();

    // Story 41.2: When advanced is skipped, secure defaults are applied
    // So elicited now includes InstanceType, ImageId + advanced field defaults
    const keys = Object.keys(elicited);
    expect(keys).toEqual(expect.arrayContaining(["InstanceType", "ImageId"]));
    expect(keys.length).toBeGreaterThanOrEqual(2);

    // Secure advanced defaults should be present (Story 41.1)
    expect(elicited["EbsEncrypted"]).toBe(true);
    expect(elicited["EbsOptimized"]).toBe(true);
    expect(elicited["DisableApiTermination"]).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RDS ENGINE VERSION — showIf CONDITIONAL PROMPTING
// ═════════════════════════════════════════════════════════════════════════════

describe("RDS Engine version is prompted when engine is postgres", () => {
  it("shows EngineVersion prompt matching showIf Engine=postgres", async () => {
    vi.mocked(select)
      .mockResolvedValueOnce("db.t3.small") // DBInstanceClass
      .mockResolvedValueOnce("postgres") // Engine
      .mockResolvedValueOnce("16") // EngineVersion (showIf Engine=postgres)
      .mockResolvedValueOnce("false") // MultiAZ
      .mockResolvedValueOnce("false") // DeletionProtection
      .mockResolvedValueOnce("gp3") // StorageType
      .mockResolvedValueOnce("20"); // AllocatedStorage

    vi.mocked(text)
      .mockResolvedValueOnce("testdb") // DBName
      .mockResolvedValueOnce("admin") // MasterUsername
      .mockResolvedValueOnce("Pass123!") // MasterUserPassword
      .mockResolvedValueOnce(""); // Tags (skipped)

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(
      makeElicitorState({
        resourceType: "AWS::RDS::DBInstance",
        userIntent: "Create a PostgreSQL RDS instance",
      }),
    );

    const elicited = result.elicitedOptions ?? {};
    expect(elicited["Engine"]).toBe("postgres");
    expect(elicited["EngineVersion"]).toBe("16");
    expect(elicited["DBInstanceClass"]).toBe("db.t3.small");
  });
});

describe("RDS Engine version skipped for wrong showIf (mysql engine, no mysql EngineVersion prompt for postgres)", () => {
  it("does not prompt EngineVersion for postgres when engine is mysql", async () => {
    vi.mocked(select)
      .mockResolvedValueOnce("db.t3.small") // DBInstanceClass
      .mockResolvedValueOnce("mysql") // Engine
      .mockResolvedValueOnce("8.4") // EngineVersion (showIf Engine=mysql)
      .mockResolvedValueOnce("false") // MultiAZ
      .mockResolvedValueOnce("false") // DeletionProtection
      .mockResolvedValueOnce("gp3") // StorageType
      .mockResolvedValueOnce("20"); // AllocatedStorage

    vi.mocked(text)
      .mockResolvedValueOnce("testdb") // DBName
      .mockResolvedValueOnce("admin") // MasterUsername
      .mockResolvedValueOnce("Pass123!") // MasterUserPassword
      .mockResolvedValueOnce(""); // Tags (skipped)

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(
      makeElicitorState({
        resourceType: "AWS::RDS::DBInstance",
        userIntent: "Create a MySQL database",
      }),
    );

    const elicited = result.elicitedOptions ?? {};
    expect(elicited["Engine"]).toBe("mysql");
    // EngineVersion should be the mysql variant, not postgres
    expect(elicited["EngineVersion"]).toBe("8.4");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EC2 "Other" FLOW — USER REJECTS SUGGESTION, RE-PROMPTED
// ═════════════════════════════════════════════════════════════════════════════

describe('EC2 "Other" flow — user rejects suggestion, gets re-prompted', () => {
  it("re-prompts after rejection and accepts exact value on second attempt", async () => {
    const mockLlm = new MockLlmAdapter(
      { profile: "compute-heavy", confidence: 0.9 },
      "c5.xlarge",
    );

    // InstanceType categorySelect: category → __other__
    vi.mocked(select).mockResolvedValueOnce("__other__");

    // First "Other" attempt: description → LLM suggests → user rejects
    vi.mocked(text).mockResolvedValueOnce("something fast");
    vi.mocked(confirm).mockResolvedValueOnce(false); // reject suggestion

    // Second attempt: the while loop in promptWithHelp re-prompts renderOptionPrompt
    // which renders the categorySelect again. User picks __other__ again.
    vi.mocked(select).mockResolvedValueOnce("__other__");

    // Second "Other" attempt: user types exact value
    vi.mocked(text).mockResolvedValueOnce("c6i.large");

    // ImageId: static fallback → select
    vi.mocked(select).mockResolvedValueOnce("amazon-linux-2023");

    // Remaining text fields: KeyName, SubnetId, SecurityGroupIds, Tags
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName
      .mockResolvedValueOnce("") // SubnetId
      .mockResolvedValueOnce("") // SecurityGroupIds
      .mockResolvedValueOnce(""); // Tags

    // Advanced = no
    vi.mocked(confirm).mockResolvedValueOnce(false);

    const result = await optionElicitorNode(makeElicitorState(), [], mockLlm);

    expect(result.elicitedOptions?.["InstanceType"]).toBe("c6i.large");
  });
});

describe('EC2 "Other" flow — LLM returns paragraph instead of value', () => {
  it("rejects paragraph response and re-prompts for exact value", async () => {
    const paragraphResponse =
      "To configure an EC2 instance for ML tasks, a popular choice is the Deep Learning AMI which includes TensorFlow and PyTorch.";
    const mockLlm = new MockLlmAdapter(
      { profile: "compute-heavy", confidence: 0.9 },
      paragraphResponse,
    );

    // First: category → __other__
    vi.mocked(select).mockResolvedValueOnce("__other__");
    // Description
    vi.mocked(text).mockResolvedValueOnce("ML");
    // LLM returns paragraph (>100 chars) → rejected automatically, re-prompts

    // Re-prompt: category → __other__
    vi.mocked(select).mockResolvedValueOnce("__other__");
    // User types exact value this time
    vi.mocked(text).mockResolvedValueOnce("p3.2xlarge");

    // ImageId: static fallback
    vi.mocked(select).mockResolvedValueOnce("amazon-linux-2023");

    // Remaining text fields
    vi.mocked(text)
      .mockResolvedValueOnce("") // KeyName
      .mockResolvedValueOnce("") // SubnetId
      .mockResolvedValueOnce("") // SecurityGroupIds
      .mockResolvedValueOnce(""); // Tags

    vi.mocked(confirm).mockResolvedValueOnce(false); // Advanced = no

    const result = await optionElicitorNode(makeElicitorState(), [], mockLlm);

    // Paragraph was rejected, exact value used
    expect(result.elicitedOptions?.["InstanceType"]).toBe("p3.2xlarge");
    // No paragraph leaked into any field
    const values = Object.values(result.elicitedOptions ?? {});
    for (const v of values) {
      if (typeof v === "string") {
        expect(v.length).toBeLessThan(100);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Lambda Environment toCfn transform
// ═════════════════════════════════════════════════════════════════════════════

describe("Lambda Environment toCfn transform", () => {
  it("transforms comma-separated env vars to CFN Variables structure", () => {
    const result = applyToCfnTransforms(
      {
        FunctionName: "my-fn",
        Environment: "DB_HOST=localhost,API_KEY=secret123",
      },
      "AWS::Lambda::Function",
    );

    expect(result["Environment"]).toEqual({
      Variables: {
        DB_HOST: "localhost",
        API_KEY: "secret123",
      },
    });
  });

  it("omits Environment when user provides empty string", () => {
    const result = applyToCfnTransforms(
      {
        FunctionName: "my-fn",
        Environment: "",
      },
      "AWS::Lambda::Function",
    );

    expect(result["Environment"]).toBeUndefined();
  });
});
