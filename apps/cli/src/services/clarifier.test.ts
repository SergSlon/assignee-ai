import { describe, expect, it, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import type { AgentState } from "./graph-state.js";

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  isCancel: vi.fn((v) => v === CANCEL_SYMBOL),
}));

const CANCEL_SYMBOL = Symbol("clack-cancel");

import * as clack from "@clack/prompts";
import {
  askClarifyingQuestion,
  buildClarifyingQuestion,
  isClarifiableFailure,
} from "./clarifier.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "do something",
    runId: "test-run",
    executionStatus: ExecutionStatus.FAILED,
    errorMessage: undefined,
    resourceType: "",
    ...overrides,
  } as AgentState;
}

describe("isClarifiableFailure", () => {
  it("returns true for UNSUPPORTED_RESOURCE", () => {
    const s = makeState({
      executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
    });
    expect(isClarifiableFailure(s)).toBe(true);
  });

  it("returns true for FAILED with no resourceType", () => {
    const s = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "",
    });
    expect(isClarifiableFailure(s)).toBe(true);
  });

  it("returns false for FAILED with a resourceType (downstream failure, not intent)", () => {
    const s = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
    });
    expect(isClarifiableFailure(s)).toBe(false);
  });

  it("returns false for CANCELLED", () => {
    const s = makeState({ executionStatus: ExecutionStatus.CANCELLED });
    expect(isClarifiableFailure(s)).toBe(false);
  });

  it("returns false for SUCCESS", () => {
    const s = makeState({ executionStatus: ExecutionStatus.SUCCESS });
    expect(isClarifiableFailure(s)).toBe(false);
  });
});

describe("buildClarifyingQuestion", () => {
  it("quotes both intent and error when both present", () => {
    const s = makeState({
      userIntent: "make a thing",
      errorMessage: "No supported resource match",
    });
    const q = buildClarifyingQuestion(s);
    expect(q).toContain('"make a thing"');
    expect(q).toContain("No supported resource match");
  });

  it("uses intent-only phrasing when errorMessage is empty", () => {
    const s = makeState({ userIntent: "make a thing" });
    const q = buildClarifyingQuestion(s);
    expect(q).toContain('"make a thing"');
    expect(q).not.toContain("(");
  });

  it("falls back to generic prompt when intent is empty", () => {
    const s = makeState({ userIntent: "" });
    const q = buildClarifyingQuestion(s);
    expect(q.toLowerCase()).toContain("resource type");
  });
});

describe("askClarifyingQuestion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(clack.isCancel).mockImplementation((v) => v === CANCEL_SYMBOL);
  });

  it("returns the rephrased intent on happy path", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce(
      "Create an S3 bucket named logs",
    );
    const result = await askClarifyingQuestion({
      state: makeState(),
      autoApprove: false,
      quick: false,
      isTty: true,
    });
    expect(result).toBe("Create an S3 bucket named logs");
  });

  it("returns null when user Ctrl-C cancels", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce(CANCEL_SYMBOL as never);
    const result = await askClarifyingQuestion({
      state: makeState(),
      autoApprove: false,
      quick: false,
      isTty: true,
    });
    expect(result).toBeNull();
  });

  it("returns null when user submits empty", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce("   ");
    const result = await askClarifyingQuestion({
      state: makeState(),
      autoApprove: false,
      quick: false,
      isTty: true,
    });
    expect(result).toBeNull();
  });

  it("returns null when user types 'cancel'", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce("cancel");
    const result = await askClarifyingQuestion({
      state: makeState(),
      autoApprove: false,
      quick: false,
      isTty: true,
    });
    expect(result).toBeNull();
  });

  it("bypasses when not a TTY (CI-safe)", async () => {
    const result = await askClarifyingQuestion({
      state: makeState(),
      autoApprove: false,
      quick: false,
      isTty: false,
    });
    expect(result).toBeNull();
    expect(clack.text).not.toHaveBeenCalled();
  });

  it("bypasses when --yes was passed", async () => {
    const result = await askClarifyingQuestion({
      state: makeState(),
      autoApprove: true,
      quick: false,
      isTty: true,
    });
    expect(result).toBeNull();
    expect(clack.text).not.toHaveBeenCalled();
  });

  it("bypasses when --quick was passed", async () => {
    const result = await askClarifyingQuestion({
      state: makeState(),
      autoApprove: false,
      quick: true,
      isTty: true,
    });
    expect(result).toBeNull();
    expect(clack.text).not.toHaveBeenCalled();
  });

  it("bypasses when failure is not clarifiable (e.g. downstream FAILED with resourceType)", async () => {
    const result = await askClarifyingQuestion({
      state: makeState({
        executionStatus: ExecutionStatus.FAILED,
        resourceType: "AWS::S3::Bucket",
      }),
      autoApprove: false,
      quick: false,
      isTty: true,
    });
    expect(result).toBeNull();
    expect(clack.text).not.toHaveBeenCalled();
  });
});
