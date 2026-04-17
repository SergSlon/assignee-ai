/**
 * Unit tests for runReviewAnswers (Story 48.7).
 * Covers rendering (boolean/array/undefined/sensitive masking), cancel,
 * and edit-selection path mapping.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { ResourceField } from "../../resource-plugins/types.js";

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

const clack = await import("@clack/prompts");
const { runReviewAnswers } = await import("./review-answers.js");

function mkField(
  name: string,
  label: string,
  type: "string" | "boolean" | "multi" = "string",
  extra: Partial<ResourceField["question"]> = {},
): ResourceField {
  return {
    name,
    question: {
      type,
      label,
      ...extra,
    } as ResourceField["question"],
  };
}

describe("runReviewAnswers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clack.isCancel).mockReturnValue(false);
  });

  it("renders boolean as Yes/No, arrays comma-joined, undefined as <not set>", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("__cancel__");
    const fields = [
      mkField("Name", "Resource name"),
      mkField("Encrypt", "Enable encryption?", "boolean"),
      mkField("Tags", "Tags", "multi"),
      mkField("Note", "Note"),
    ];
    await runReviewAnswers({
      fields,
      elicitedOptions: {
        Name: "my-bucket",
        Encrypt: false,
        Tags: ["env:prod", "team:core"],
        Note: "",
      },
    });
    const callArg = vi.mocked(clack.select).mock.calls[0]![0] as {
      options: Array<{ label: string; value: string }>;
    };
    const labels = callArg.options.map((o) => o.label);
    expect(labels[0]).toBe("1. Resource name: my-bucket");
    expect(labels[1]).toBe("2. Enable encryption?: No");
    expect(labels[2]).toBe("3. Tags: env:prod, team:core");
    // "" → <not set>
    expect(labels[3]).toBe("4. Note: <not set>");
  });

  it("masks fields with question.sensitive=true as *** — raw value never appears", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("__cancel__");
    const rawPw = "SuperSecretPass123!";
    const fields = [
      mkField("DbPassword", "Master password", "string", {
        // sensitive is a tolerated optional field the render fn inspects
        sensitive: true,
      } as never),
    ];
    await runReviewAnswers({
      fields,
      elicitedOptions: { DbPassword: rawPw },
    });
    const callArg = vi.mocked(clack.select).mock.calls[0]![0] as {
      options: Array<{ label: string }>;
    };
    const labels = callArg.options.map((o) => o.label).join("\n");
    expect(labels).not.toContain(rawPw);
    expect(labels).toContain("***");
  });

  it("masks by name regex (/password|secret|token|key$/i) when sensitive flag absent", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("__cancel__");
    const fields = [
      mkField("ApiToken", "API token"),
      mkField("MasterUserPassword", "DB password"),
    ];
    await runReviewAnswers({
      fields,
      elicitedOptions: {
        ApiToken: "tok_12345_abcde",
        MasterUserPassword: "hunter2",
      },
    });
    const callArg = vi.mocked(clack.select).mock.calls[0]![0] as {
      options: Array<{ label: string }>;
    };
    const txt = callArg.options.map((o) => o.label).join("\n");
    expect(txt).not.toContain("tok_12345_abcde");
    expect(txt).not.toContain("hunter2");
    expect(txt).toContain("***");
  });

  it("returns { action: 'cancel' } when zero answers (no prompt shown)", async () => {
    const result = await runReviewAnswers({
      fields: [mkField("Name", "Name")],
      elicitedOptions: {},
    });
    expect(result).toEqual({ action: "cancel" });
    expect(clack.select).not.toHaveBeenCalled();
  });

  it("returns { action: 'cancel' } on __cancel__ selection", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("__cancel__");
    const result = await runReviewAnswers({
      fields: [mkField("Name", "Name")],
      elicitedOptions: { Name: "x" },
    });
    expect(result).toEqual({ action: "cancel" });
  });

  it("returns { action: 'cancel' } on clack.isCancel() (Ctrl+C)", async () => {
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);
    vi.mocked(clack.select).mockResolvedValueOnce(Symbol("cancel") as never);
    const result = await runReviewAnswers({
      fields: [mkField("Name", "Name")],
      elicitedOptions: { Name: "x" },
    });
    expect(result).toEqual({ action: "cancel" });
  });

  it("returns { action: 'edit', fieldIndex } mapping back to original fields index", async () => {
    // user picks row #1 (0-indexed among answered rows) — the second answered
    // field. Only 2 of 3 fields answered, so the mapping must skip the
    // unanswered middle field.
    vi.mocked(clack.select).mockResolvedValueOnce("1");
    const fields = [
      mkField("Name", "Name"), // answered (idx 0)
      mkField("Skipped", "Skipped"), // NOT answered (idx 1)
      mkField("Size", "Size"), // answered (idx 2) → this is row #1 in the UI
    ];
    const result = await runReviewAnswers({
      fields,
      elicitedOptions: { Name: "a", Size: "large" },
    });
    expect(result).toEqual({ action: "edit", fieldIndex: 2 });
  });
});
