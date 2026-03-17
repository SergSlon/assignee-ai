import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import type { ResourcePlugin } from "@assignee/core";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(() => false),
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

vi.mock("@assignee/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assignee/core")>();
  return {
    ...actual,
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
const { optionElicitorNode } = await import("./option-elicitor.js");

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
    vi.mocked(confirm).mockResolvedValueOnce(true); // Encrypt
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
    vi.mocked(confirm).mockResolvedValueOnce(false); // Encrypt=false
    vi.mocked(select).mockResolvedValueOnce("sm"); // Size
    vi.mocked(confirm).mockResolvedValueOnce(false); // advanced confirm

    const result = await optionElicitorNode(makeState());

    // KmsKey should NOT appear — its showIf (Encrypt===true) was not met
    expect(result.elicitedOptions?.["KmsKey"]).toBeUndefined();
    expect(text).toHaveBeenCalledTimes(1); // only Name, not KmsKey
  });

  it("shows advanced tier when user confirms", async () => {
    vi.mocked(text).mockResolvedValueOnce("my-resource");
    vi.mocked(confirm).mockResolvedValueOnce(true); // Encrypt
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
    vi.mocked(confirm).mockResolvedValueOnce(false); // Encrypt
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
