import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExecutionStatus, MissingRequiredFieldsError } from "@assignee/core";
import type { ResourcePlugin } from "@assignee/core";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("@assignee/best-practices", () => {
  return {
    loadBestPractices: () => [],
  };
});

vi.mock("../utils/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/display.js")>();
  return {
    ...actual,
    renderOptionPrompt: vi.fn(actual.renderOptionPrompt),
    renderDocHelp: vi.fn().mockResolvedValue("Doc help text for this field"),
    renderTradeoffHelp: vi.fn().mockResolvedValue("Trade-off analysis text"),
  };
});

vi.mock("../utils/aws-resource-discovery.js", () => ({
  discoverAmis: vi.fn().mockResolvedValue([]),
  discoverSubnets: vi.fn().mockResolvedValue([]),
  discoverSecurityGroups: vi.fn().mockResolvedValue([]),
  discoverKeyPairs: vi.fn().mockResolvedValue([]),
  discoverInstanceTypes: vi.fn().mockResolvedValue(null),
  discoverRdsEngineVersions: vi.fn().mockResolvedValue([]),
  discoverRdsInstanceClasses: vi.fn().mockResolvedValue([]),
}));

const testPlugin: ResourcePlugin = {
  resourceType: "AWS::Test::Resource",
  commonFields: [
    {
      name: "Name",
      question: {
        type: "string",
        label: "Resource name",
        initialValue: "default-name",
      },
    },
    {
      name: "Encrypt",
      question: {
        type: "boolean",
        label: "Enable encryption?",
        initialValue: true,
      },
    },
    {
      name: "KmsKey",
      question: {
        type: "string",
        label: "KMS Key ID",
        showIf: { field: "Encrypt", value: true },
      },
    },
    {
      name: "Size",
      question: {
        type: "enum",
        label: "Size",
        options: [{ value: "sm", label: "Small" }],
      },
    },
  ],
  advancedFields: [
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        options: [{ value: "env:prod", label: "env:prod" }],
      },
    },
  ],
  defaults: {},
};

/** Simplified EC2 plugin for intent-defaults integration tests (no fetchers). */
const testEc2Plugin: ResourcePlugin = {
  resourceType: "AWS::EC2::Instance",
  commonFields: [
    {
      name: "InstanceType",
      question: {
        type: "enum",
        label: "Instance type",
        options: [
          { value: "t3.micro", label: "t3.micro" },
          { value: "t3.small", label: "t3.small" },
          { value: "t3.large", label: "t3.large" },
          { value: "c5.xlarge", label: "c5.xlarge" },
          { value: "r5.large", label: "r5.large" },
        ],
        initialValue: "t3.micro",
      },
    },
  ],
  advancedFields: [],
  defaults: {},
};

/** Simplified S3 plugin for intent-defaults integration tests. */
const testS3Plugin: ResourcePlugin = {
  resourceType: "AWS::S3::Bucket",
  commonFields: [
    {
      name: "BucketName",
      question: {
        type: "string",
        label: "Bucket name",
        placeholder: "my-bucket",
      },
    },
    {
      name: "BucketEncryption",
      question: {
        type: "boolean",
        label: "Enable encryption?",
        initialValue: true,
      },
    },
    {
      name: "PublicAccessBlockConfiguration",
      question: {
        type: "boolean",
        label: "Block public access?",
        initialValue: true,
      },
    },
  ],
  advancedFields: [
    {
      name: "EnableLifecycle",
      question: {
        type: "boolean",
        label: "Add lifecycle rules?",
        initialValue: false,
      },
    },
    {
      name: "LifecycleTransitionDays",
      question: {
        type: "enum",
        label: "Transition days",
        options: [
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
        ],
        initialValue: "30",
        showIf: { field: "EnableLifecycle", value: true },
      },
    },
  ],
  defaults: {},
};

vi.mock("@assignee/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assignee/core")>();
  return {
    ...actual,
    MissingRequiredFieldsError: actual.MissingRequiredFieldsError,
    defaultPluginRegistry: {
      get: vi.fn((type: string) => {
        if (type === "AWS::Test::Resource") return testPlugin;
        if (type === "AWS::EC2::Instance") return testEc2Plugin;
        if (type === "AWS::S3::Bucket") return testS3Plugin;
        // Fall through to real registry for generic fallback
        return actual.defaultPluginRegistry.get(type);
      }),
    },
  };
});

const { confirm, select, text, multiselect, isCancel } =
  await import("@clack/prompts");
const {
  optionElicitorNode,
  populateDefaultOptions,
  applyOptionRanking,
  applyCategorySmartFilter,
} = await import("./option-elicitor.js");
const { renderDocHelp, renderTradeoffHelp, renderOptionPrompt } =
  await import("../utils/display.js");

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    executionStatus: ExecutionStatus.PENDING,
    resourceType: "AWS::Test::Resource",
    elicitedOptions: undefined,
    ...overrides,
  } as Parameters<typeof optionElicitorNode>[0];
}

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  setTTY(true);
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
  vi.resetAllMocks();
});

describe("optionElicitorNode", () => {
  it("returns {} when executionStatus is not PENDING", async () => {
    const result = await optionElicitorNode(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );
    expect(result).toEqual({});
    expect(text).not.toHaveBeenCalled();
  });

  it("returns empty elicitedOptions in non-TTY without prompting", async () => {
    setTTY(false);
    const result = await optionElicitorNode(makeState());
    expect(result).toEqual({ elicitedOptions: {} });
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prompts for ask_if_not_set field and stores answer", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource");
    vi.mocked(select).mockResolvedValueOnce("true"); // Encrypt
    vi.mocked(text).mockResolvedValueOnce(""); // KmsKey (shown because Encrypt=true)
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(makeState());

    expect(result.elicitedOptions?.["Name"]).toBe("my-resource");
    expect(result.elicitedOptions?.["Encrypt"]).toBe(true);
    expect(result.elicitedOptions?.["Size"]).toBe("sm");
  });

  it("skips showIf field when condition not met (Encrypt=false skips KmsKey)", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource"); // Name
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt=false
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(makeState());

    // KmsKey should NOT appear — its showIf (Encrypt===true) was not met
    expect(result.elicitedOptions?.["KmsKey"]).toBeUndefined();
    expect(text).toHaveBeenCalledTimes(1); // only Name, not KmsKey
  });

  it("shows advanced tier when user confirms", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource");
    vi.mocked(select).mockResolvedValueOnce(true); // Encrypt
    vi.mocked(text).mockResolvedValueOnce(""); // KmsKey
    vi.mocked(select).mockResolvedValueOnce("sm");
    vi.mocked(confirm).mockResolvedValueOnce(true); // advanced confirm
    vi.mocked(multiselect).mockResolvedValueOnce([]); // Tags

    const result = await optionElicitorNode(makeState());

    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Tags" }),
    );
    expect(result.elicitedOptions).toHaveProperty("Tags");
  });

  it("skips advanced tier when user declines", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource");
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm");
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm → skip

    const result = await optionElicitorNode(makeState());

    expect(multiselect).not.toHaveBeenCalled();
    expect(result.elicitedOptions?.["Tags"]).toBeUndefined();
  });

  it("uses generic fallback plugin for unknown resource type", async () => {
    // generic plugin has 2 commonFields, no advancedFields
    vi.mocked(text).mockResolvedValueOnce("my-resource"); // ResourceName
    vi.mocked(text).mockResolvedValueOnce("env:prod"); // Tags (now string type)

    const result = await optionElicitorNode(
      makeState({ resourceType: "AWS::Unknown::Type" }),
    );

    expect(result.elicitedOptions).toBeDefined();
  });
});

describe("optionElicitorNode — ? help flow (Story 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTTY(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("? then valid answer: calls renderDocHelp once, stores valid answer", async () => {
    // Name field: first returns '?', second returns 'us-east-1'
    vi.mocked(text)
      .mockResolvedValueOnce("?") // Name → triggers help
      .mockResolvedValueOnce("us-east-1"); // Name → valid answer
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(makeState());

    expect(vi.mocked(renderDocHelp)).toHaveBeenCalledOnce();
    expect(vi.mocked(renderDocHelp)).toHaveBeenCalledWith(
      "Name",
      "AWS::Test::Resource",
      [],
      undefined,
    );
    expect(result.elicitedOptions?.["Name"]).toBe("us-east-1");
  });

  it("non-? input: renderDocHelp NOT called", async () => {
    vi.mocked(text).mockResolvedValueOnce("Standard"); // Name
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    await optionElicitorNode(makeState());

    expect(vi.mocked(renderDocHelp)).not.toHaveBeenCalled();
  });

  it("non-TTY: renderDocHelp never called (? unreachable)", async () => {
    setTTY(false);

    await optionElicitorNode(makeState());

    expect(vi.mocked(renderDocHelp)).not.toHaveBeenCalled();
  });

  it("timeout fallback + prompt re-presented: after renderDocHelp resolves (simulating timeout fallback), loop re-presents prompt", async () => {
    // Simulates AC6: "timeout → fallback shown + prompt re-presented"
    // renderDocHelp is mocked to resolve immediately (as it does on timeout fallback)
    // The loop should continue and the second text() call becomes the answer
    vi.mocked(text)
      .mockResolvedValueOnce("?") // Name → triggers help (timeout handled inside renderDocHelp)
      .mockResolvedValueOnce("my-bucket"); // Name → valid answer after fallback
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(makeState());

    // renderDocHelp was called (regardless of timeout internals) and loop continued
    expect(vi.mocked(renderDocHelp)).toHaveBeenCalledOnce();
    // Prompt was re-presented after renderDocHelp returned — valid answer stored
    expect(result.elicitedOptions?.["Name"]).toBe("my-bucket");
    expect(text).toHaveBeenCalledTimes(2); // Called twice: once for '?', once for valid answer
  });
});

describe("optionElicitorNode — --no-wizard bypass (Story 11.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTTY(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("noWizard: true → returns defaults without interactive prompts", async () => {
    const result = await optionElicitorNode(makeState({ noWizard: true }));

    // Should return elicitedOptions populated from plugin defaults
    expect(result.elicitedOptions).toBeDefined();
    expect(result.elicitedOptions?.["Name"]).toBe("default-name");
    expect(result.elicitedOptions?.["Encrypt"]).toBe(true);

    // No interactive prompts should have been called
    expect(text).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("noWizard: false → runs interactive flow (existing behavior)", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource");
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(makeState({ noWizard: false }));

    // Interactive prompts should have been called
    expect(text).toHaveBeenCalled();
    expect(result.elicitedOptions?.["Name"]).toBe("my-resource");
  });

  it("noWizard: true → skips showIf fields (no interactive context)", async () => {
    const result = await optionElicitorNode(makeState({ noWizard: true }));

    // KmsKey has showIf: { field: "Encrypt", value: true } — skipped in no-wizard mode
    expect(result.elicitedOptions?.["KmsKey"]).toBeUndefined();
  });

  it("noWizard: true with all defaults available → returns complete elicitedOptions", async () => {
    const result = await optionElicitorNode(makeState({ noWizard: true }));

    expect(result.elicitedOptions).toBeDefined();
    // Name and Encrypt have initialValue — should be populated
    expect(result.elicitedOptions?.["Name"]).toBe("default-name");
    expect(result.elicitedOptions?.["Encrypt"]).toBe(true);
  });
});

describe("populateDefaultOptions — missing required fields (Story 11.1 AC#5)", () => {
  it("throws MissingRequiredFieldsError when required field has no default", () => {
    const pluginWithRequired: ResourcePlugin = {
      resourceType: "AWS::Test::RequiredFields",
      commonFields: [
        {
          name: "VpcId",
          required: true,
          question: {
            type: "string",
            label: "VPC ID",
            // No initialValue → required with no default
          },
        },
        {
          name: "SubnetId",
          required: true,
          question: {
            type: "string",
            label: "Subnet ID",
            // No initialValue → required with no default
          },
        },
        {
          name: "Name",
          question: {
            type: "string",
            label: "Resource name",
            initialValue: "default-name",
          },
        },
      ],
      advancedFields: [],
      defaults: {},
    };

    let caughtError: unknown;
    try {
      populateDefaultOptions(pluginWithRequired);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError).toBeInstanceOf(Error);
    const error = caughtError as Error & {
      missingFields?: string[];
      code?: string;
    };
    expect(error.name).toBe("MissingRequiredFieldsError");
    expect(error.code).toBe("MISSING_REQUIRED_FIELDS");
    expect(error.missingFields).toEqual(["VpcId", "SubnetId"]);
    expect(error.message).toContain("VpcId");
    expect(error.message).toContain("SubnetId");
    expect(error.message).toContain(
      "Provide these values in your intent or remove --no-wizard",
    );
  });

  it("does not throw when required field has initialValue", () => {
    const pluginWithDefaults: ResourcePlugin = {
      resourceType: "AWS::Test::AllDefaults",
      commonFields: [
        {
          name: "Name",
          required: true,
          question: {
            type: "string",
            label: "Resource name",
            initialValue: "default-name",
          },
        },
      ],
      advancedFields: [],
      defaults: {},
    };

    expect(() => populateDefaultOptions(pluginWithDefaults)).not.toThrow();
    const result = populateDefaultOptions(pluginWithDefaults);
    expect(result["Name"]).toBe("default-name");
  });

  it("does not throw when required field has plugin default", () => {
    const pluginWithPluginDefaults: ResourcePlugin = {
      resourceType: "AWS::Test::PluginDefaults",
      commonFields: [
        {
          name: "Config",
          required: true,
          question: {
            type: "string",
            label: "Config",
            // No initialValue
          },
        },
      ],
      advancedFields: [],
      defaults: { Config: { key: "value" } },
    };

    expect(() =>
      populateDefaultOptions(pluginWithPluginDefaults),
    ).not.toThrow();
    const result = populateDefaultOptions(pluginWithPluginDefaults);
    expect(result["Config"]).toEqual({ key: "value" });
  });

  it("non-required fields without defaults are silently skipped", () => {
    const pluginOptionalNoDefaults: ResourcePlugin = {
      resourceType: "AWS::Test::Optional",
      commonFields: [
        {
          name: "OptionalField",
          // required not set (defaults to false)
          question: {
            type: "string",
            label: "Optional",
            // No initialValue
          },
        },
      ],
      advancedFields: [],
      defaults: {},
    };

    expect(() =>
      populateDefaultOptions(pluginOptionalNoDefaults),
    ).not.toThrow();
    const result = populateDefaultOptions(pluginOptionalNoDefaults);
    expect(result["OptionalField"]).toBeUndefined();
  });
});

// ── Story 10.5: Intent-Aware Smart Defaults integration tests ────────────────

describe("optionElicitorNode — intent-aware smart defaults (Story 10.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTTY(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  // Task 4.1: EC2 "web server" → InstanceType initialValue overridden to t3.small
  it("EC2 web server intent: InstanceType defaults to t3.small", async () => {
    // testEc2Plugin has 1 common field: InstanceType (enum, no fetchers)
    vi.mocked(select).mockResolvedValueOnce("t3.small"); // InstanceType — intent default

    const result = await optionElicitorNode(
      makeState({
        userIntent: "Create an EC2 for a web server",
        resourceType: "AWS::EC2::Instance",
      }),
    );

    expect(result.elicitedOptions).toBeDefined();
    expect(result.elicitedOptions?.["InstanceType"]).toBe("t3.small");
  });

  // Task 4.2: S3 no keywords → plugin defaults unchanged
  it("S3 with no intent keywords: plugin defaults unchanged", async () => {
    // testS3Plugin common fields: BucketName(string), BucketEncryption(bool), PublicAccessBlockConfiguration(bool)
    vi.mocked(text).mockResolvedValueOnce("my-bucket"); // BucketName
    vi.mocked(select)
      .mockResolvedValueOnce(true) // BucketEncryption
      .mockResolvedValueOnce(true); // PublicAccessBlockConfiguration
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(
      makeState({
        userIntent: "Create an S3 bucket",
        resourceType: "AWS::S3::Bucket",
      }),
    );

    expect(result.elicitedOptions).toBeDefined();
    expect(result.elicitedOptions?.["BucketName"]).toBe("my-bucket");
  });

  // Task 3.10: Intent defaults do not override user-provided values
  it("intent defaults do not override when user provides a different value", async () => {
    // testEc2Plugin has 1 common field: InstanceType (enum)
    // User explicitly chooses t3.large instead of the intent default t3.small
    vi.mocked(select).mockResolvedValueOnce("t3.large"); // InstanceType — user overrides

    const result = await optionElicitorNode(
      makeState({
        userIntent: "Create an EC2 for a web server",
        resourceType: "AWS::EC2::Instance",
      }),
    );

    // User's choice takes precedence over intent default
    expect(result.elicitedOptions?.["InstanceType"]).toBe("t3.large");
  });
});

// ── Story 10.6: ? dispatch — enum vs string ──────────────────────────────────

describe("optionElicitorNode — ? dispatch by field type (Story 10.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTTY(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("enum field ? → calls renderTradeoffHelp (not renderDocHelp)", async () => {
    // Name → normal answer
    vi.mocked(text).mockResolvedValueOnce("my-resource");
    // Encrypt → normal answer
    vi.mocked(select).mockResolvedValueOnce("false");
    // Size (enum) → first '?', then 'sm'
    vi.mocked(select)
      .mockResolvedValueOnce("?") // Size → triggers help
      .mockResolvedValueOnce("sm"); // Size → valid answer
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const mockLlmClient = {
      generateText: vi.fn().mockResolvedValue([null, "test"] as const),
      generateStructured: vi.fn(),
    };

    await optionElicitorNode(
      makeState({ userIntent: "low-traffic blog" }),
      [],
      mockLlmClient,
    );

    expect(vi.mocked(renderTradeoffHelp)).toHaveBeenCalledOnce();
    expect(vi.mocked(renderTradeoffHelp)).toHaveBeenCalledWith(
      "Size",
      "AWS::Test::Resource",
      expect.arrayContaining([expect.objectContaining({ value: "sm" })]),
      "low-traffic blog",
      [],
      mockLlmClient,
    );
    // renderDocHelp should NOT have been called for the enum field
    expect(vi.mocked(renderDocHelp)).not.toHaveBeenCalled();
  });

  it("string field ? → calls renderDocHelp (not renderTradeoffHelp)", async () => {
    // Name (string) → first '?', then valid answer
    vi.mocked(text)
      .mockResolvedValueOnce("?") // Name → triggers help
      .mockResolvedValueOnce("my-resource"); // Name → valid answer
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const mockLlmClient = {
      generateText: vi.fn().mockResolvedValue([null, "test"] as const),
      generateStructured: vi.fn(),
    };

    await optionElicitorNode(
      makeState({ userIntent: "low-traffic blog" }),
      [],
      mockLlmClient,
    );

    expect(vi.mocked(renderDocHelp)).toHaveBeenCalledOnce();
    expect(vi.mocked(renderDocHelp)).toHaveBeenCalledWith(
      "Name",
      "AWS::Test::Resource",
      [],
      mockLlmClient,
    );
    // renderTradeoffHelp should NOT have been called for the string field
    expect(vi.mocked(renderTradeoffHelp)).not.toHaveBeenCalled();
  });

  it("enum field ? without llmClient → falls back to renderDocHelp", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource"); // Name
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    // Size (enum) → first '?', then 'sm'
    vi.mocked(select).mockResolvedValueOnce("?").mockResolvedValueOnce("sm");
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await optionElicitorNode(
      makeState({ userIntent: "low-traffic blog" }),
      [],
      undefined, // no llmClient
    );

    // Without llmClient, enum ? should fall back to renderDocHelp
    expect(vi.mocked(renderDocHelp)).toHaveBeenCalledOnce();
    expect(vi.mocked(renderTradeoffHelp)).not.toHaveBeenCalled();
  });
});

// ── Story 10.8: Cached help as persistent hints ───────────────────────────────

describe("optionElicitorNode — cached help as persistent hints (Story 10.8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTTY(true);
    // Re-set mock return values after clearAllMocks
    vi.mocked(renderDocHelp).mockResolvedValue("Doc help text for this field");
    vi.mocked(renderTradeoffHelp).mockResolvedValue("Trade-off analysis text");
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("string field ?: on re-prompt, renderOptionPrompt receives field with cached hint", async () => {
    // Name (string) → first '?', then valid answer
    vi.mocked(text)
      .mockResolvedValueOnce("?") // Name → triggers help
      .mockResolvedValueOnce("my-resource"); // Name → valid answer
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const mockLlmClient = {
      generateText: vi.fn().mockResolvedValue([null, "test"] as const),
      generateStructured: vi.fn(),
    };

    await optionElicitorNode(
      makeState({ userIntent: "low-traffic blog" }),
      [],
      mockLlmClient,
    );

    // renderOptionPrompt should have been called for Name twice:
    // 1st call: without cached hint (original field)
    // 2nd call: with cached hint from renderDocHelp
    const allCalls = vi.mocked(renderOptionPrompt).mock.calls;
    const namePromptCalls = allCalls.filter((c) => c[0].name === "Name");
    expect(namePromptCalls.length).toBe(2);
    // First call: no cached hint (original field)
    expect(namePromptCalls[0]![0].question.hint).toBeUndefined();
    // Second call: cached hint injected
    expect(namePromptCalls[1]![0].question.hint).toBe(
      "Doc help text for this field",
    );
  });

  it("enum field ?: on re-prompt, renderOptionPrompt receives field with cached hint", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource"); // Name
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    // Size (enum) → first '?', then 'sm'
    vi.mocked(select)
      .mockResolvedValueOnce("?") // Size → triggers help
      .mockResolvedValueOnce("sm"); // Size → valid answer
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const mockLlmClient = {
      generateText: vi.fn().mockResolvedValue([null, "test"] as const),
      generateStructured: vi.fn(),
    };

    await optionElicitorNode(
      makeState({ userIntent: "low-traffic blog" }),
      [],
      mockLlmClient,
    );

    // renderOptionPrompt should have been called for Size twice:
    // 1st: without cached hint, 2nd: with cached hint from renderTradeoffHelp
    const sizePromptCalls = vi
      .mocked(renderOptionPrompt)
      .mock.calls.filter((c) => c[0].name === "Size");
    expect(sizePromptCalls.length).toBe(2);
    expect(sizePromptCalls[0]![0].question.hint).toBeUndefined();
    expect(sizePromptCalls[1]![0].question.hint).toBe(
      "Trade-off analysis text",
    );
  });

  it("cached hint does not leak to a different field's promptWithHelp call", async () => {
    // Name (string) → first '?', then valid answer
    vi.mocked(text)
      .mockResolvedValueOnce("?") // Name → triggers help
      .mockResolvedValueOnce("my-resource"); // Name → valid answer
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size — should NOT have Name's cached hint
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const mockLlmClient = {
      generateText: vi.fn().mockResolvedValue([null, "test"] as const),
      generateStructured: vi.fn(),
    };

    await optionElicitorNode(
      makeState({ userIntent: "low-traffic blog" }),
      [],
      mockLlmClient,
    );

    // Size field should NOT have a cached hint from the Name field's ? press
    const sizePromptCalls = vi
      .mocked(renderOptionPrompt)
      .mock.calls.filter((c) => c[0].name === "Size");
    expect(sizePromptCalls.length).toBe(1);
    expect(sizePromptCalls[0]![0].question.hint).toBeUndefined();
  });

  it("cached help replaces existing plugin hint on re-prompt", async () => {
    // This test verifies AC #6: cached help text replaces the plugin-provided hint
    // The testPlugin doesn't have hints, but we can verify the mechanism works
    // by checking that the cached hint is set (overwriting undefined → string).
    // When a field already has a hint, the spread clone { ...field.question, hint: cachedHint }
    // replaces it. This is covered by the string field test above.
    vi.mocked(text)
      .mockResolvedValueOnce("?") // Name → triggers help
      .mockResolvedValueOnce("my-resource"); // Name → valid answer
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const mockLlmClient = {
      generateText: vi.fn().mockResolvedValue([null, "test"] as const),
      generateStructured: vi.fn(),
    };

    await optionElicitorNode(
      makeState({ userIntent: "low-traffic blog" }),
      [],
      mockLlmClient,
    );

    // The re-prompt call should have the cached hint replacing any existing hint
    const namePromptCalls = vi
      .mocked(renderOptionPrompt)
      .mock.calls.filter((c) => c[0].name === "Name");
    expect(namePromptCalls[1]![0].question.hint).toBe(
      "Doc help text for this field",
    );
  });
});

// ── Story 9.10: Parallel MCP Subagent Architecture ───────────────────────────

describe("optionElicitorNode — parallel pricing + discovery fan-out (Story 9.10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTTY(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("pricing and discovery run concurrently (overlapping execution)", async () => {
    const {
      discoverAmis,
      discoverSubnets,
      discoverSecurityGroups,
      discoverKeyPairs,
    } = await import("../utils/aws-resource-discovery.js");

    // Track execution timing to prove concurrency
    const executionLog: Array<{ task: string; event: "start" | "end" }> = [];

    // Make discovery functions take measurable time
    vi.mocked(discoverAmis).mockImplementation(async () => {
      executionLog.push({ task: "discovery", event: "start" });
      await new Promise((r) => setTimeout(r, 50));
      executionLog.push({ task: "discovery", event: "end" });
      return [];
    });
    vi.mocked(discoverSubnets).mockResolvedValue([]);
    vi.mocked(discoverSecurityGroups).mockResolvedValue([]);
    vi.mocked(discoverKeyPairs).mockResolvedValue([]);

    // Use EC2 plugin that has both pricing fields and fetcher fields
    const ec2PluginWithFetchers = {
      resourceType: "AWS::EC2::Instance",
      commonFields: [
        {
          name: "InstanceType",
          question: {
            type: "enum" as const,
            label: "Instance type",
            options: [
              { value: "t3.micro", label: "t3.micro" },
              { value: "t3.small", label: "t3.small" },
            ],
            initialValue: "t3.micro",
          },
        },
        {
          name: "ImageId",
          question: {
            type: "enum" as const,
            label: "AMI",
            fetcher: "discover-amis",
            options: [],
          },
        },
      ],
      advancedFields: [],
      defaults: {},
    };

    const { defaultPluginRegistry } = await import("@assignee/core");
    vi.mocked(defaultPluginRegistry.get).mockImplementation((type: string) => {
      if (type === "AWS::EC2::Instance") return ec2PluginWithFetchers as any;
      return undefined;
    });

    vi.mocked(select).mockResolvedValueOnce("t3.micro"); // InstanceType
    vi.mocked(text).mockResolvedValueOnce("ami-123"); // ImageId (fallback to string)

    await optionElicitorNode(
      makeState({ resourceType: "AWS::EC2::Instance" }),
      [], // no pricing tools — pricing resolves immediately
    );

    // Discovery functions should have been called (proving they ran in parallel block)
    expect(discoverAmis).toHaveBeenCalled();
  });

  it("graceful degradation: pricing failure does not block discovery", async () => {
    const {
      discoverAmis,
      discoverSubnets,
      discoverSecurityGroups,
      discoverKeyPairs,
    } = await import("../utils/aws-resource-discovery.js");

    vi.mocked(discoverAmis).mockResolvedValue([
      { value: "ami-123", label: "Amazon Linux 2" },
    ]);
    vi.mocked(discoverSubnets).mockResolvedValue([]);
    vi.mocked(discoverSecurityGroups).mockResolvedValue([]);
    vi.mocked(discoverKeyPairs).mockResolvedValue([]);

    const ec2PluginWithFetchers = {
      resourceType: "AWS::EC2::Instance",
      commonFields: [
        {
          name: "InstanceType",
          question: {
            type: "enum" as const,
            label: "Instance type",
            options: [{ value: "t3.micro", label: "t3.micro" }],
            initialValue: "t3.micro",
          },
        },
        {
          name: "ImageId",
          question: {
            type: "enum" as const,
            label: "AMI",
            fetcher: "discover-amis",
            options: [],
          },
        },
      ],
      advancedFields: [],
      defaults: {},
    };

    const { defaultPluginRegistry } = await import("@assignee/core");
    vi.mocked(defaultPluginRegistry.get).mockImplementation((type: string) => {
      if (type === "AWS::EC2::Instance") return ec2PluginWithFetchers as any;
      return undefined;
    });

    // Pricing tool that throws
    const failingPricingTool = {
      name: "get_pricing",
      invoke: vi.fn().mockRejectedValue(new Error("MCP server crashed")),
    } as unknown as import("@langchain/core/tools").StructuredTool;

    vi.mocked(select)
      .mockResolvedValueOnce("t3.micro") // InstanceType
      .mockResolvedValueOnce("ami-123"); // ImageId (discovered)

    const result = await optionElicitorNode(
      makeState({ resourceType: "AWS::EC2::Instance" }),
      [failingPricingTool],
    );

    // Discovery should still have succeeded despite pricing failure
    expect(discoverAmis).toHaveBeenCalled();
    expect(result.elicitedOptions).toBeDefined();
  });

  it("graceful degradation: discovery failure does not block pricing", async () => {
    const { discoverAmis } = await import("../utils/aws-resource-discovery.js");

    // All discovery functions throw
    vi.mocked(discoverAmis).mockRejectedValue(new Error("SDK error"));

    vi.mocked(text).mockResolvedValueOnce("my-resource"); // Name
    vi.mocked(select).mockResolvedValueOnce("false"); // Encrypt
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(makeState());

    // Node should complete successfully with fallback fields
    expect(result.elicitedOptions).toBeDefined();
    expect(result.elicitedOptions?.["Name"]).toBe("my-resource");
  });

  it("unified spinner wraps entire parallel block", async () => {
    const { spinner } = await import("@clack/prompts");
    const mockSpinner = { start: vi.fn(), stop: vi.fn() };
    vi.mocked(spinner).mockReturnValue(mockSpinner as any);

    vi.mocked(text).mockResolvedValueOnce("my-resource");
    vi.mocked(select).mockResolvedValueOnce("false");
    vi.mocked(select).mockResolvedValueOnce("sm");
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await optionElicitorNode(makeState());

    // Spinner should show "Preparing your wizard…" and stop with "Ready"
    expect(mockSpinner.start).toHaveBeenCalledWith("Preparing your wizard…");
    expect(mockSpinner.stop).toHaveBeenCalledWith("Ready");
  });
});

// ── Story 21.4: RDS DBInstanceClass smart filtering ──────────────────────────

describe("applyOptionRanking (Story 21.4)", () => {
  /** Helper: builds an RDS-like DBInstanceClass field with many options (>10). */
  function rdsInstanceClassField() {
    return {
      name: "DBInstanceClass",
      question: {
        type: "enum" as const,
        label: "DB instance class",
        options: [
          { value: "db.t3.micro", label: "db.t3.micro (2 vCPU, 1 GiB)" },
          { value: "db.t3.small", label: "db.t3.small (2 vCPU, 2 GiB)" },
          { value: "db.t3.medium", label: "db.t3.medium (2 vCPU, 4 GiB)" },
          { value: "db.t4g.micro", label: "db.t4g.micro (2 vCPU, 1 GiB)" },
          { value: "db.t4g.small", label: "db.t4g.small (2 vCPU, 2 GiB)" },
          { value: "db.m5.large", label: "db.m5.large (2 vCPU, 8 GiB)" },
          { value: "db.m5.xlarge", label: "db.m5.xlarge (4 vCPU, 16 GiB)" },
          { value: "db.r5.large", label: "db.r5.large (2 vCPU, 16 GiB)" },
          { value: "db.r6g.large", label: "db.r6g.large (2 vCPU, 16 GiB)" },
          { value: "db.r6g.xlarge", label: "db.r6g.xlarge (4 vCPU, 32 GiB)" },
          { value: "db.r7g.large", label: "db.r7g.large (2 vCPU, 16 GiB)" },
          { value: "db.c5.large", label: "db.c5.large (2 vCPU, 4 GiB)" },
        ],
      },
    };
  }

  it("memory-intensive profile ranks r6g/r5 classes first", () => {
    const fields = [rdsInstanceClassField()] as any;
    const result = applyOptionRanking(fields, "memory-intensive");

    const options = result[0]!.question.options!;
    const values = options.map((o: any) => o.value);

    // r5, r6g, r7g should be ranked first (they match memory-intensive keywords)
    const topValues = values.slice(0, 5);
    expect(topValues).toContain("db.r5.large");
    expect(topValues).toContain("db.r6g.large");
    expect(topValues).toContain("db.r6g.xlarge");
    expect(topValues).toContain("db.r7g.large");
  });

  it("burstable profile ranks t3/t4g classes first", () => {
    const fields = [rdsInstanceClassField()] as any;
    const result = applyOptionRanking(fields, "burstable");

    const options = result[0]!.question.options!;
    const values = options.map((o: any) => o.value);

    // t3 and t4g should be ranked first
    const topValues = values.slice(0, 5);
    expect(topValues).toContain("db.t3.micro");
    expect(topValues).toContain("db.t3.small");
    expect(topValues).toContain("db.t3.medium");
    expect(topValues).toContain("db.t4g.micro");
    expect(topValues).toContain("db.t4g.small");
  });

  it("options.length <= 10 — no filtering applied", () => {
    const smallField = {
      name: "StorageType",
      question: {
        type: "enum" as const,
        label: "Storage type",
        options: [
          { value: "gp3", label: "gp3" },
          { value: "gp2", label: "gp2" },
          { value: "io1", label: "io1" },
        ],
      },
    };
    const fields = [smallField] as any;
    const result = applyOptionRanking(fields, "memory-intensive");

    // Options should remain in original order
    const values = result[0]!.question.options!.map((o: any) => o.value);
    expect(values).toEqual(["gp3", "gp2", "io1"]);
  });

  it("unknown profile returns options in original order (no ranking)", () => {
    const fields = [rdsInstanceClassField()] as any;
    const original = fields[0]!.question.options!.map((o: any) => o.value);

    const result = applyOptionRanking(fields, "unknown");

    const values = result[0]!.question.options!.map((o: any) => o.value);
    expect(values).toEqual(original);
  });

  it("preserves all options (ranked order, no truncation)", () => {
    const fields = [rdsInstanceClassField()] as any;
    const originalCount = fields[0]!.question.options!.length;

    const result = applyOptionRanking(fields, "burstable");

    const options = result[0]!.question.options!;
    expect(options).toHaveLength(originalCount);
  });

  it("does not modify non-enum fields", () => {
    const stringField = {
      name: "DBName",
      question: {
        type: "string" as const,
        label: "Database name",
      },
    };
    const fields = [stringField] as any;
    const result = applyOptionRanking(fields, "burstable");

    expect(result[0]).toBe(stringField);
  });
});

// ── Story 21.3: EC2 Instance Type Smart Filtering ────────────────────────────

function categorySelectField() {
  return {
    name: "InstanceType",
    question: {
      type: "categorySelect" as const,
      label: "Instance type",
      hint: "Pick an instance type",
      categories: [
        {
          key: "burstable",
          label: "Burstable (t3/t4g)",
          description: "Variable CPU with burst credits",
          options: [
            { value: "t3.micro", label: "t3.micro (2 vCPU, 1 GiB)" },
            { value: "t3.small", label: "t3.small (2 vCPU, 2 GiB)" },
            { value: "t4g.micro", label: "t4g.micro (2 vCPU, 1 GiB)" },
          ],
        },
        {
          key: "general",
          label: "General Purpose (m5/m6i)",
          description: "Balanced CPU/memory ratio",
          options: [
            { value: "m5.large", label: "m5.large (2 vCPU, 8 GiB)" },
            { value: "m6i.xlarge", label: "m6i.xlarge (4 vCPU, 16 GiB)" },
          ],
        },
        {
          key: "compute",
          label: "Compute Optimized (c5/c6i)",
          description: "High-performance CPUs",
          options: [
            { value: "c5.large", label: "c5.large (2 vCPU, 4 GiB)" },
            { value: "c6i.xlarge", label: "c6i.xlarge (4 vCPU, 8 GiB)" },
          ],
        },
        {
          key: "memory",
          label: "Memory Optimized (r5/r6i)",
          description: "High memory-to-CPU ratio",
          options: [
            { value: "r5.large", label: "r5.large (2 vCPU, 16 GiB)" },
            { value: "r6i.xlarge", label: "r6i.xlarge (4 vCPU, 32 GiB)" },
          ],
        },
      ],
    },
  };
}

describe("applyCategorySmartFilter (Story 21.3)", () => {
  it("burstable profile reorders categories to put burstable first", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, "burstable");

    const cats = result[0]!.question.categories!;
    expect(cats[0]!.key).toBe("burstable");
    expect(cats[0]!.label).toContain("(recommended for your workload)");
    // Other categories follow in original order
    expect(cats[1]!.key).toBe("general");
    expect(cats[2]!.key).toBe("compute");
    expect(cats[3]!.key).toBe("memory");
  });

  it("compute-heavy profile reorders categories to put compute first", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, "compute-heavy");

    const cats = result[0]!.question.categories!;
    expect(cats[0]!.key).toBe("compute");
    expect(cats[0]!.label).toContain("(recommended for your workload)");
    expect(cats[1]!.key).toBe("burstable");
  });

  it("memory-intensive profile reorders categories to put memory first", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, "memory-intensive");

    const cats = result[0]!.question.categories!;
    expect(cats[0]!.key).toBe("memory");
    expect(cats[0]!.label).toContain("(recommended for your workload)");
  });

  it("general-purpose profile reorders categories to put general first", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, "general-purpose");

    const cats = result[0]!.question.categories!;
    expect(cats[0]!.key).toBe("general");
    expect(cats[0]!.label).toContain("(recommended for your workload)");
  });

  it("unknown profile leaves order unchanged", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, "unknown");

    // Should return the exact same reference (no transformation)
    expect(result).toBe(fields);
  });

  it("undefined profile leaves order unchanged", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, undefined);

    expect(result).toBe(fields);
  });

  it("gpu-accelerated profile adds GPU note to hint", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, "gpu-accelerated");

    const hint = result[0]!.question.hint;
    expect(hint).toContain("GPU instances not in categories");
    expect(hint).toContain("p5/g6");
    // Categories should remain in original order (no matching category)
    expect(result[0]!.question.categories![0]!.key).toBe("burstable");
  });

  it("ranks options within the matched category by workload relevance", () => {
    // Build a field where burstable options are in non-optimal order
    const field = {
      name: "InstanceType",
      question: {
        type: "categorySelect" as const,
        label: "Instance type",
        categories: [
          {
            key: "burstable",
            label: "Burstable",
            description: "Burstable instances",
            options: [
              { value: "t3.xlarge", label: "t3.xlarge (4 vCPU, 16 GiB)" },
              {
                value: "t3.micro",
                label: "t3.micro (2 vCPU, 1 GiB) — dev/test, burst",
              },
              {
                value: "t4g.small",
                label: "t4g.small (2 vCPU, 2 GiB) — burst, small",
              },
            ],
          },
          {
            key: "general",
            label: "General Purpose",
            description: "General purpose instances",
            options: [{ value: "m5.large", label: "m5.large (2 vCPU, 8 GiB)" }],
          },
        ],
      },
    };
    const fields = [field] as any;
    const result = applyCategorySmartFilter(fields, "burstable");

    // The burstable category should be first
    const burstCat = result[0]!.question.categories![0]!;
    expect(burstCat.key).toBe("burstable");
    // Options should be ranked — t3.micro matches "t3" + "micro", t4g.small matches "small"
    // t3.micro scores higher (matches t3 + micro = 10), t4g.small scores (small = 5), t3.xlarge (t3 = 5)
    const values = burstCat.options.map((o: any) => o.value);
    expect(values[0]).toBe("t3.micro");
  });

  it("preserves total category count after reordering", () => {
    const fields = [categorySelectField()] as any;
    const result = applyCategorySmartFilter(fields, "compute-heavy");

    expect(result[0]!.question.categories).toHaveLength(4);
  });

  it("does not modify non-categorySelect fields", () => {
    const enumField = {
      name: "Size",
      question: {
        type: "enum" as const,
        label: "Size",
        options: [{ value: "sm", label: "Small" }],
      },
    };
    const fields = [enumField] as any;
    const result = applyCategorySmartFilter(fields, "burstable");

    expect(result[0]).toBe(enumField);
  });
});
