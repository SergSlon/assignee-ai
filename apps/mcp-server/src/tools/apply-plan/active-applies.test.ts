import { afterEach, describe, expect, it } from "vitest";

import {
  _resetActiveApplies,
  MAX_ACTIVE_APPLIES,
  isApplyActive,
  markApplyActive,
  releaseApply,
} from "./active-applies.js";

describe("active-applies concurrency guard", () => {
  afterEach(() => {
    _resetActiveApplies();
  });

  it("mark/is/release happy path tracks the checkpoint path", () => {
    const path = "/tmp/checkpoint-happy.json";

    expect(isApplyActive(path)).toBe(false);

    markApplyActive(path);
    expect(isApplyActive(path)).toBe(true);

    releaseApply(path);
    expect(isApplyActive(path)).toBe(false);
  });

  it("release-then-remark under the cap works", () => {
    const path = "/tmp/checkpoint-cycle.json";

    markApplyActive(path);
    releaseApply(path);
    expect(isApplyActive(path)).toBe(false);

    // Re-mark after release should succeed without throwing.
    expect(() => markApplyActive(path)).not.toThrow();
    expect(isApplyActive(path)).toBe(true);
  });

  it("marking MAX_ACTIVE_APPLIES distinct paths succeeds; the next one throws", () => {
    for (let index = 0; index < MAX_ACTIVE_APPLIES; index += 1) {
      markApplyActive(`/tmp/checkpoint-${index}.json`);
    }

    expect(() =>
      markApplyActive(`/tmp/checkpoint-${MAX_ACTIVE_APPLIES}.json`),
    ).toThrow(
      `Active-applies cap reached (${MAX_ACTIVE_APPLIES}). This likely indicates a release leak; check apply-plan handler for missing finally/release paths.`,
    );

    // Re-marking an already-active path at the cap is idempotent and
    // must not throw — only genuinely new entries are rejected.
    expect(() => markApplyActive("/tmp/checkpoint-0.json")).not.toThrow();
  });

  it("releasing one entry at the cap frees a slot for a new apply", () => {
    for (let index = 0; index < MAX_ACTIVE_APPLIES; index += 1) {
      markApplyActive(`/tmp/checkpoint-${index}.json`);
    }

    expect(() => markApplyActive("/tmp/checkpoint-new.json")).toThrow();

    releaseApply("/tmp/checkpoint-0.json");

    expect(() => markApplyActive("/tmp/checkpoint-new.json")).not.toThrow();
    expect(isApplyActive("/tmp/checkpoint-new.json")).toBe(true);
  });

  it("_resetActiveApplies clears all tracked entries", () => {
    markApplyActive("/tmp/checkpoint-a.json");
    markApplyActive("/tmp/checkpoint-b.json");
    expect(isApplyActive("/tmp/checkpoint-a.json")).toBe(true);
    expect(isApplyActive("/tmp/checkpoint-b.json")).toBe(true);

    _resetActiveApplies();

    expect(isApplyActive("/tmp/checkpoint-a.json")).toBe(false);
    expect(isApplyActive("/tmp/checkpoint-b.json")).toBe(false);

    // After reset, we can fill the set from scratch up to the cap.
    for (let index = 0; index < MAX_ACTIVE_APPLIES; index += 1) {
      markApplyActive(`/tmp/checkpoint-post-reset-${index}.json`);
    }
    expect(() =>
      markApplyActive("/tmp/checkpoint-post-reset-overflow.json"),
    ).toThrow();
  });
});
