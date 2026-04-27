/**
 * Tests for TenantId + TenantScopedCache (MASTER-008 RW4a).
 *
 * Pinned focus: the cross-tenant isolation invariant. The original
 * five module-level singletons (rule-loader, marker-resolver,
 * free-tier, resolve-arn, ec2-instance-types) failed the
 * "tenant A's data must not be returned to tenant B" assertion
 * because their key was implicit "process". These tests pin the
 * isolation property so future refactors can't regress it silently.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  type TenantId,
  tenantIdToKey,
  createLegacySingleTenantId,
} from "./tenant-id.js";
import { TenantScopedCache } from "./tenant-scoped-cache.js";

const TENANT_A: TenantId = {
  accountId: "111111111111",
  region: "us-east-1",
};
const TENANT_B: TenantId = {
  accountId: "222222222222",
  region: "us-east-1",
};
const TENANT_A_DIFFERENT_REGION: TenantId = {
  accountId: "111111111111",
  region: "eu-west-1",
};
const TENANT_A_WITH_ROLE: TenantId = {
  accountId: "111111111111",
  region: "us-east-1",
  roleArn: "arn:aws:iam::111111111111:role/cross-account",
};

describe("tenantIdToKey", () => {
  it("produces a deterministic key for the same TenantId", () => {
    expect(tenantIdToKey(TENANT_A)).toBe(tenantIdToKey(TENANT_A));
  });

  it("produces distinct keys for different accountIds", () => {
    expect(tenantIdToKey(TENANT_A)).not.toBe(tenantIdToKey(TENANT_B));
  });

  it("produces distinct keys for the same account in different regions", () => {
    expect(tenantIdToKey(TENANT_A)).not.toBe(
      tenantIdToKey(TENANT_A_DIFFERENT_REGION),
    );
  });

  it("produces distinct keys for the same account+region with vs. without roleArn", () => {
    expect(tenantIdToKey(TENANT_A)).not.toBe(tenantIdToKey(TENANT_A_WITH_ROLE));
  });

  it("emits the empty trailing segment when roleArn is absent", () => {
    // Pinned format so a future change of the canonical-key shape
    // doesn't accidentally collapse two tenants into one cache slot.
    expect(tenantIdToKey(TENANT_A)).toBe("111111111111|us-east-1|");
    expect(tenantIdToKey(TENANT_A_WITH_ROLE)).toBe(
      "111111111111|us-east-1|arn:aws:iam::111111111111:role/cross-account",
    );
  });
});

describe("TenantScopedCache.get / set", () => {
  it("returns undefined before set", () => {
    const cache = new TenantScopedCache<string>();
    expect(cache.get(TENANT_A)).toBeUndefined();
  });

  it("returns the value after set", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "value-A");
    expect(cache.get(TENANT_A)).toBe("value-A");
  });

  it("overwrites the value when set is called again", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "first");
    cache.set(TENANT_A, "second");
    expect(cache.get(TENANT_A)).toBe("second");
  });

  it("isolates two distinct tenants — A's set must not leak into B", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "value-A");
    cache.set(TENANT_B, "value-B");
    expect(cache.get(TENANT_A)).toBe("value-A");
    expect(cache.get(TENANT_B)).toBe("value-B");
  });

  it("isolates same-account different-region — region must be part of the key", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "us-east-1-data");
    expect(cache.get(TENANT_A_DIFFERENT_REGION)).toBeUndefined();
  });

  it("isolates same-account+region with vs. without roleArn", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "no-role-data");
    expect(cache.get(TENANT_A_WITH_ROLE)).toBeUndefined();
  });

  it("supports complex object values without mutation surprise", () => {
    const cache = new TenantScopedCache<{ items: string[] }>();
    const value = { items: ["a", "b", "c"] };
    cache.set(TENANT_A, value);
    const retrieved = cache.get(TENANT_A);
    // Same reference — TenantScopedCache stores by reference, not by clone.
    expect(retrieved).toBe(value);
    expect(retrieved?.items).toEqual(["a", "b", "c"]);
  });
});

describe("TenantScopedCache.has", () => {
  it("returns false before set", () => {
    const cache = new TenantScopedCache<string>();
    expect(cache.has(TENANT_A)).toBe(false);
  });

  it("returns true after set, even if value is undefined-equivalent (empty string)", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "");
    expect(cache.has(TENANT_A)).toBe(true);
    expect(cache.get(TENANT_A)).toBe("");
  });

  it("isolation: set A → has(B) is still false", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "value-A");
    expect(cache.has(TENANT_B)).toBe(false);
  });
});

describe("TenantScopedCache.clear", () => {
  it("clear(tenant) only evicts the named tenant", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "value-A");
    cache.set(TENANT_B, "value-B");
    cache.clear(TENANT_A);
    expect(cache.get(TENANT_A)).toBeUndefined();
    expect(cache.get(TENANT_B)).toBe("value-B");
    expect(cache.size()).toBe(1);
  });

  it("clear() with no argument evicts every tenant", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "value-A");
    cache.set(TENANT_B, "value-B");
    cache.clear();
    expect(cache.get(TENANT_A)).toBeUndefined();
    expect(cache.get(TENANT_B)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("clear(tenant) on a tenant that was never set is a no-op", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "value-A");
    expect(() => cache.clear(TENANT_B)).not.toThrow();
    expect(cache.get(TENANT_A)).toBe("value-A");
    expect(cache.size()).toBe(1);
  });
});

describe("TenantScopedCache.size", () => {
  it("starts at 0", () => {
    expect(new TenantScopedCache<string>().size()).toBe(0);
  });

  it("counts distinct tenants, not set calls", () => {
    const cache = new TenantScopedCache<string>();
    cache.set(TENANT_A, "first");
    cache.set(TENANT_A, "second");
    cache.set(TENANT_A, "third");
    expect(cache.size()).toBe(1);
    cache.set(TENANT_B, "B");
    expect(cache.size()).toBe(2);
  });
});

describe("createLegacySingleTenantId", () => {
  const originalAccountId = process.env["AWS_ACCOUNT_ID"];
  const originalRegion = process.env["AWS_REGION"];

  beforeEach(() => {
    delete process.env["AWS_ACCOUNT_ID"];
    delete process.env["AWS_REGION"];
  });

  afterEach(() => {
    if (originalAccountId !== undefined) {
      process.env["AWS_ACCOUNT_ID"] = originalAccountId;
    } else {
      delete process.env["AWS_ACCOUNT_ID"];
    }
    if (originalRegion !== undefined) {
      process.env["AWS_REGION"] = originalRegion;
    } else {
      delete process.env["AWS_REGION"];
    }
  });

  it("falls back to placeholder account + us-east-1 when env unset", () => {
    const tenantId = createLegacySingleTenantId();
    expect(tenantId.accountId).toBe("000000000000");
    expect(tenantId.region).toBe("us-east-1");
    expect(tenantId.roleArn).toBeUndefined();
  });

  it("reads AWS_ACCOUNT_ID and AWS_REGION from env when set", () => {
    process.env["AWS_ACCOUNT_ID"] = "210987654321";
    process.env["AWS_REGION"] = "eu-central-1";
    const tenantId = createLegacySingleTenantId();
    expect(tenantId.accountId).toBe("210987654321");
    expect(tenantId.region).toBe("eu-central-1");
  });

  it("returns a fresh object each call (env vars may mutate)", () => {
    const a = createLegacySingleTenantId();
    process.env["AWS_REGION"] = "ap-southeast-2";
    const b = createLegacySingleTenantId();
    expect(a.region).toBe("us-east-1");
    expect(b.region).toBe("ap-southeast-2");
  });
});

describe("end-to-end: cache survives realistic SaaS multi-tenant pattern", () => {
  it("two tenants concurrently 'compute' values without cross-contamination", async () => {
    const cache = new TenantScopedCache<string>();

    // Simulate the loadCached() pattern: get-or-compute.
    async function getOrCompute(
      tenantId: TenantId,
      compute: () => Promise<string>,
    ): Promise<string> {
      const cached = cache.get(tenantId);
      if (cached !== undefined) return cached;
      const fresh = await compute();
      cache.set(tenantId, fresh);
      return fresh;
    }

    let aCalls = 0;
    let bCalls = 0;
    const computeA = async () => {
      aCalls += 1;
      return "data-for-A";
    };
    const computeB = async () => {
      bCalls += 1;
      return "data-for-B";
    };

    expect(await getOrCompute(TENANT_A, computeA)).toBe("data-for-A");
    expect(await getOrCompute(TENANT_B, computeB)).toBe("data-for-B");
    // Re-asking — must hit the cache, not recompute.
    expect(await getOrCompute(TENANT_A, computeA)).toBe("data-for-A");
    expect(await getOrCompute(TENANT_B, computeB)).toBe("data-for-B");

    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });
});
