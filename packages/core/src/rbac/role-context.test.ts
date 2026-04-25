/**
 * W3-02 — Role context tests.
 */

import { describe, it, expect } from "vitest";
import { getCurrentRole, ROLE_OPERATOR } from "./role-context.js";

describe("getCurrentRole", () => {
  it("returns a non-empty string", () => {
    const role = getCurrentRole();
    expect(typeof role).toBe("string");
    expect(role.length).toBeGreaterThan(0);
  });

  it("returns 'operator' in the scaffold wave (hardcoded; Epic 101 reads OIDC)", () => {
    expect(getCurrentRole()).toBe(ROLE_OPERATOR);
  });
});
