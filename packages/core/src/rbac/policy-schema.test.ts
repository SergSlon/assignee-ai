/**
 * W3-02 — RBAC policy schema tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePolicy,
  safeParsePolicies,
  PolicySchema,
} from "./policy-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "__fixtures__");

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(FIXTURES_DIR, name), "utf-8");
  return JSON.parse(raw);
}

// ── Schema validation ────────────────────────────────────────────────────

describe("PolicySchema — valid fixtures", () => {
  const fixtures = [
    "admin-policy.json",
    "operator-policy.json",
    "read-only-policy.json",
    "auditor-policy.json",
    "restricted-policy.json",
  ] as const;

  it.each(fixtures)("validates %s", (fixture) => {
    const raw = loadFixture(fixture);
    expect(() => parsePolicy(raw)).not.toThrow();
    const policy = parsePolicy(raw);
    expect(typeof policy.role).toBe("string");
    expect(policy.role.length).toBeGreaterThan(0);
    expect(Array.isArray(policy.actions)).toBe(true);
    expect(policy.actions.length).toBeGreaterThan(0);
    expect(typeof policy.resourceGlob).toBe("string");
    expect(policy.resourceGlob.length).toBeGreaterThan(0);
  });

  it("admin policy has wildcard actions and resource", () => {
    const admin = parsePolicy(loadFixture("admin-policy.json"));
    expect(admin.role).toBe("admin");
    expect(admin.actions).toContain("*");
    expect(admin.resourceGlob).toBe("*");
  });

  it("restricted policy scopes resource glob to S3", () => {
    const restricted = parsePolicy(loadFixture("restricted-policy.json"));
    expect(restricted.role).toBe("restricted");
    expect(restricted.resourceGlob).toBe("AWS::S3::*");
  });

  it("read-only policy includes audit-verify action", () => {
    const readOnly = parsePolicy(loadFixture("read-only-policy.json"));
    expect(readOnly.actions).toContain("audit-verify");
  });
});

describe("PolicySchema — invalid inputs", () => {
  it("rejects missing role", () => {
    const result = PolicySchema.safeParse({
      actions: ["plan"],
      resourceGlob: "*",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty role string", () => {
    const result = PolicySchema.safeParse({
      role: "",
      actions: ["plan"],
      resourceGlob: "*",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty actions array", () => {
    const result = PolicySchema.safeParse({
      role: "x",
      actions: [],
      resourceGlob: "*",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing resourceGlob", () => {
    const result = PolicySchema.safeParse({ role: "x", actions: ["plan"] });
    expect(result.success).toBe(false);
  });

  it("rejects non-object input", () => {
    const result = PolicySchema.safeParse("not-an-object");
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = PolicySchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

describe("safeParsePolicies", () => {
  it("returns success:true for valid items and success:false for invalid ones", () => {
    const input = [
      { role: "admin", actions: ["*"], resourceGlob: "*" },
      { role: "", actions: [], resourceGlob: "*" }, // invalid
      { role: "read-only", actions: ["list"], resourceGlob: "AWS::S3::*" },
    ];
    const results = safeParsePolicies(input);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[2]!.success).toBe(true);
  });
});
