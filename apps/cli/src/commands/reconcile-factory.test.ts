/**
 * Tests for reconcile-factory.ts.
 *
 * Covers:
 *  - M-S9: cancel via Ctrl-C throws UserCancelledError instead of being
 *    silently mapped to "Skip" / false.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserCancelledError } from "@assignee/core";

const cancelSymbol = Symbol("__clack_cancel__");

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: (v: unknown) => v === cancelSymbol,
}));

import * as clack from "@clack/prompts";
import { defaultPromptFn, defaultConfirmFn } from "./reconcile-factory.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultPromptFn (M-S9)", () => {
  it("returns the user-selected choice on success", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(
      "Reconcile" as unknown as symbol,
    );
    const result = await defaultPromptFn("Action?", [
      "Reconcile",
      "Accept",
      "Skip",
    ]);
    expect(result).toBe("Reconcile");
  });

  it("throws UserCancelledError when the user cancels (Ctrl-C)", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(
      cancelSymbol as unknown as symbol,
    );
    await expect(
      defaultPromptFn("Action?", ["Reconcile", "Accept", "Skip"]),
    ).rejects.toBeInstanceOf(UserCancelledError);
  });

  it("does NOT silently fall back to 'Skip' on cancel", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(
      cancelSymbol as unknown as symbol,
    );
    let resolved: string | undefined;
    let thrown: unknown;
    try {
      resolved = await defaultPromptFn("Action?", ["Reconcile", "Skip"]);
    } catch (err) {
      thrown = err;
    }
    expect(resolved).toBeUndefined();
    expect(thrown).toBeInstanceOf(UserCancelledError);
  });
});

describe("defaultConfirmFn (M-S9)", () => {
  it("returns true when the user confirms", async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(true as unknown as symbol);
    expect(await defaultConfirmFn("ok?")).toBe(true);
  });

  it("returns false when the user declines", async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(false as unknown as symbol);
    expect(await defaultConfirmFn("ok?")).toBe(false);
  });

  it("throws UserCancelledError when the user cancels", async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(
      cancelSymbol as unknown as symbol,
    );
    await expect(defaultConfirmFn("ok?")).rejects.toBeInstanceOf(
      UserCancelledError,
    );
  });
});
