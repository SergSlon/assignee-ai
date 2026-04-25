/**
 * W3-02 — RBAC policy store round-trip contract tests.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { InMemoryPolicyStore, FilePolicyStore } from "./policy-store.js";
import type { Policy } from "./policy-schema.js";

// ── Test data ────────────────────────────────────────────────────────────

const adminPolicy: Policy = {
  role: "admin",
  actions: ["*"],
  resourceGlob: "*",
};

const operatorPolicy: Policy = {
  role: "operator",
  actions: ["plan", "apply", "destroy", "list"],
  resourceGlob: "*",
};

const readOnlyPolicy: Policy = {
  role: "read-only",
  actions: ["list", "status"],
  resourceGlob: "*",
};

// ── InMemoryPolicyStore ──────────────────────────────────────────────────

describe("InMemoryPolicyStore", () => {
  it("set + get round-trips a policy", async () => {
    const store = new InMemoryPolicyStore();
    await store.set(adminPolicy);
    const got = await store.get("admin");
    expect(got).toEqual(adminPolicy);
  });

  it("returns undefined for an unknown role", async () => {
    const store = new InMemoryPolicyStore();
    const got = await store.get("nonexistent");
    expect(got).toBeUndefined();
  });

  it("list returns all stored policies", async () => {
    const store = new InMemoryPolicyStore();
    await store.set(adminPolicy);
    await store.set(operatorPolicy);
    await store.set(readOnlyPolicy);
    const all = await store.list();
    expect(all.length).toBe(3);
    const roles = all.map((p) => p.role).sort();
    expect(roles).toEqual(["admin", "operator", "read-only"]);
  });

  it("set overwrites an existing policy for the same role", async () => {
    const store = new InMemoryPolicyStore();
    await store.set(operatorPolicy);
    const updated: Policy = { ...operatorPolicy, actions: ["list"] };
    await store.set(updated);
    const got = await store.get("operator");
    expect(got?.actions).toEqual(["list"]);
  });

  it("delete removes a policy; subsequent get returns undefined", async () => {
    const store = new InMemoryPolicyStore();
    await store.set(adminPolicy);
    await store.delete("admin");
    const got = await store.get("admin");
    expect(got).toBeUndefined();
  });

  it("delete is a no-op for an unknown role", async () => {
    const store = new InMemoryPolicyStore();
    await expect(store.delete("ghost")).resolves.not.toThrow();
  });
});

// ── FilePolicyStore ──────────────────────────────────────────────────────

function tempFile(): string {
  return path.join(
    os.tmpdir(),
    `assignee-policy-test-${randomBytes(6).toString("hex")}.json`,
  );
}

describe("FilePolicyStore", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tempFile();
  });

  afterEach(async () => {
    await fs.unlink(filePath).catch(() => {});
  });

  it("set + get round-trips a policy", async () => {
    const store = new FilePolicyStore(filePath);
    await store.set(adminPolicy);
    const got = await store.get("admin");
    expect(got).toEqual(adminPolicy);
  });

  it("returns undefined for an unknown role on an empty store", async () => {
    const store = new FilePolicyStore(filePath);
    const got = await store.get("unknown");
    expect(got).toBeUndefined();
  });

  it("list returns all stored policies after multiple sets", async () => {
    const store = new FilePolicyStore(filePath);
    await store.set(adminPolicy);
    await store.set(operatorPolicy);
    await store.set(readOnlyPolicy);
    const all = await store.list();
    expect(all.length).toBe(3);
  });

  it("persists to disk: a new FilePolicyStore instance reads the same data", async () => {
    const store1 = new FilePolicyStore(filePath);
    await store1.set(operatorPolicy);

    const store2 = new FilePolicyStore(filePath);
    const got = await store2.get("operator");
    expect(got).toEqual(operatorPolicy);
  });

  it("set overwrites the policy for an existing role", async () => {
    const store = new FilePolicyStore(filePath);
    await store.set(operatorPolicy);
    const updated: Policy = { ...operatorPolicy, actions: ["list"] };
    await store.set(updated);
    const got = await store.get("operator");
    expect(got?.actions).toEqual(["list"]);
  });

  it("delete removes a policy and persists the change", async () => {
    const store = new FilePolicyStore(filePath);
    await store.set(adminPolicy);
    await store.set(operatorPolicy);
    await store.delete("admin");
    const all = await store.list();
    expect(all.map((p) => p.role)).not.toContain("admin");
    expect(all.map((p) => p.role)).toContain("operator");
  });

  it("returns empty list when backing file does not exist", async () => {
    const store = new FilePolicyStore(filePath);
    const all = await store.list();
    expect(all).toEqual([]);
  });
});
