/**
 * Tests for `ensureAssigneeHomeDir` have moved to:
 *   `../utils/fs/ensure-assignee-home-dir.test.ts`
 *
 * This stub verifies that the shim re-export still works — i.e. the
 * canonical symbols are importable from the old audit path.
 */

import { describe, it, expect } from "vitest";
import {
  ensureAssigneeHomeDir,
  resolveAssigneeHomeDir,
} from "./ensure-assignee-home-dir.js";

describe("ensure-assignee-home-dir shim (audit → utils/fs redirect)", () => {
  it("re-exports ensureAssigneeHomeDir as a function", () => {
    expect(typeof ensureAssigneeHomeDir).toBe("function");
  });

  it("re-exports resolveAssigneeHomeDir as a function", () => {
    expect(typeof resolveAssigneeHomeDir).toBe("function");
  });
});
