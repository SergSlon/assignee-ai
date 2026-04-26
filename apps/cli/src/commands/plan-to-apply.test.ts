/**
 * Tests for the plan-to-apply single session flow (Story 10.3).
 * Tests renderHitlConfirm (formerly renderHitlConfirm) and the --no-apply flag behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as clack from "@clack/prompts";
import { renderHitlConfirm } from "../utils/display.js";
import type { RenderableState } from "../utils/display.js";
import { LOG_ACTIONS } from "../utils/logger.js";

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
  cancel: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  note: vi.fn(),
  log: { info: vi.fn() },
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
}));

const mockState: RenderableState = {
  resourceType: "AWS::S3::Bucket",
  desiredState: { BucketName: "test-bucket" },
  estimatedMonthlyCost: "$0.023/GB-month",
  runId: "test-run-id",
};

describe("renderHitlConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when user confirms Y", async () => {
    // Simulate TTY
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
    });

    vi.mocked(clack.confirm).mockResolvedValue(true);
    vi.mocked(clack.isCancel).mockReturnValue(false);

    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(true);
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Apply now?"),
      }),
    );
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("AWS::S3::Bucket"),
      }),
    );

    Object.defineProperty(process.stdin, "isTTY", {
      value: origTTY,
      writable: true,
    });
  });

  it("returns false when user responds N", async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
    });

    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.isCancel).mockReturnValue(false);

    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);

    Object.defineProperty(process.stdin, "isTTY", {
      value: origTTY,
      writable: true,
    });
  });

  it("throws UserCancelledError on Ctrl-C (clack.isCancel)", async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
    });

    const cancelSymbol = Symbol("cancel");
    vi.mocked(clack.confirm).mockResolvedValue(
      cancelSymbol as unknown as boolean,
    );
    vi.mocked(clack.isCancel).mockReturnValue(true);

    await expect(renderHitlConfirm(mockState)).rejects.toThrow(
      "Operation cancelled by user.",
    );

    Object.defineProperty(process.stdin, "isTTY", {
      value: origTTY,
      writable: true,
    });
  });

  it("returns false in non-TTY mode without prompting", async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
    });

    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();

    Object.defineProperty(process.stdin, "isTTY", {
      value: origTTY,
      writable: true,
    });
  });

  it("includes cost estimate in prompt message", async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
    });

    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.isCancel).mockReturnValue(false);

    await renderHitlConfirm(mockState);
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("$0.023/GB-month"),
      }),
    );

    Object.defineProperty(process.stdin, "isTTY", {
      value: origTTY,
      writable: true,
    });
  });

  it("shows N/A when cost estimate is missing", async () => {
    const origTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
    });

    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.isCancel).mockReturnValue(false);

    await renderHitlConfirm({
      ...mockState,
      estimatedMonthlyCost: undefined,
    });
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("N/A"),
      }),
    );

    Object.defineProperty(process.stdin, "isTTY", {
      value: origTTY,
      writable: true,
    });
  });
});

describe("LOG_ACTIONS for plan-to-apply", () => {
  it("includes PLAN_TO_APPLY_STARTED", () => {
    expect(LOG_ACTIONS.PLAN_TO_APPLY_STARTED).toBe("plan_to_apply_started");
  });

  it("includes PLAN_TO_APPLY_DECLINED", () => {
    expect(LOG_ACTIONS.PLAN_TO_APPLY_DECLINED).toBe("plan_to_apply_declined");
  });
});
