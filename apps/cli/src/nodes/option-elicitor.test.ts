import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExecutionStatus, MissingRequiredFieldsError } from "@assignee/core";
import type { ResourcePlugin } from "@assignee/core";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(() => false),
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
    renderDocHelp: vi.fn().mockResolvedValue(undefined),
  };
});

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

vi.mock("@assignee/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assignee/core")>();
  return {
    ...actual,
    MissingRequiredFieldsError: actual.MissingRequiredFieldsError,
    defaultPluginRegistry: {
      get: vi.fn((type: string) => {
        if (type === "AWS::Test::Resource") return testPlugin;
        // Fall through to real registry for generic fallback
        return actual.defaultPluginRegistry.get(type);
      }),
    },
  };
});

const { confirm, select, text, multiselect, isCancel } =
  await import("@clack/prompts");
const { optionElicitorNode, populateDefaultOptions } =
  await import("./option-elicitor.js");
const { renderDocHelp } = await import("../utils/display.js");

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
    vi.mocked(multiselect).mockResolvedValueOnce([]); // Tags (multi, no advanced confirm since no advancedFields)

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
