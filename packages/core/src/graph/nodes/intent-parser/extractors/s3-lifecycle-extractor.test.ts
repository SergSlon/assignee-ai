/**
 * Unit tests for s3-lifecycle-extractor.ts — PD-4 / PH1-E-1 / PH5-8-A
 *
 * PD-4 variations (A-E):
 *   A — bare "lifecycle 30d"
 *   B — explicit "transition to IA after 30 days then expire after 90 days"
 *   C — no lifecycle keyword at all
 *   D — different day value ("lifecycle 90d")
 *   E — multi-rule via explicit options (extractor does not fire)
 *
 * PH5-8-A variations (NC-A through NC-E):
 *   NC-A — noncurrent only: "delete old versions after 30 days"
 *   NC-B — PD-4 regression-guard: bare "lifecycle 30d" still works
 *   NC-C — both current AND noncurrent: "lifecycle 30 days and delete old versions after 7 days"
 *   NC-D — noncurrent without versioning keyword → advisor warning + auto-enable
 *   NC-E — synonym variations: "previous versions", "non-current", "old object versions"
 */
import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import {
  extractS3Lifecycle,
  S3_LIFECYCLE_SIMPLIFIED_CODE,
  S3_LIFECYCLE_SIMPLIFIED_HINT,
  S3_NONCURRENT_REQUIRES_VERSIONING_CODE,
  S3_NONCURRENT_REQUIRES_VERSIONING_HINT,
} from "./s3-lifecycle-extractor.js";
import type { Advisory } from "../intent-types.js";

/** Helper — run the extractor and return {elicited, advisories} */
function run(
  intent: string,
  resourceType: string = RESOURCE_TYPES.S3_BUCKET,
): { elicited: Record<string, unknown>; advisories: Advisory[] } {
  const elicited: Record<string, unknown> = {};
  const advisories: Advisory[] = [];
  extractS3Lifecycle(
    intent,
    intent.toLowerCase(),
    resourceType,
    elicited,
    advisories,
  );
  return { elicited, advisories };
}

describe("extractS3Lifecycle", () => {
  // ── Variation A ─────────────────────────────────────────────────────────
  describe("Variation A — bare 'lifecycle 30d'", () => {
    it("sets EnableLifecycle=true", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30d");
      expect(elicited["EnableLifecycle"]).toBe(true);
    });

    it("sets LifecycleExpireOnly=true", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30d");
      expect(elicited["LifecycleExpireOnly"]).toBe(true);
    });

    it("sets LifecycleExpirationDays=30", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30d");
      expect(elicited["LifecycleExpirationDays"]).toBe("30");
    });

    it("emits advisory with code S3_LIFECYCLE_SIMPLIFIED", () => {
      const { advisories } = run("Create an S3 bucket with lifecycle 30d");
      expect(advisories).toHaveLength(1);
      expect(advisories[0]!.code).toBe(S3_LIFECYCLE_SIMPLIFIED_CODE);
    });

    it("advisory message mentions 30d", () => {
      const { advisories } = run("Create an S3 bucket with lifecycle 30d");
      expect(advisories[0]!.message).toContain("30d");
    });

    it("advisory hint matches canonical constant", () => {
      const { advisories } = run("Create an S3 bucket with lifecycle 30d");
      expect(advisories[0]!.hint).toBe(S3_LIFECYCLE_SIMPLIFIED_HINT);
    });
  });

  // ── Variation A — alternate phrasing: "lifecycle 30 days" ──────────────
  describe("Variation A — alternate phrasing: 'lifecycle 30 days'", () => {
    it("sets LifecycleExpireOnly=true", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30 days");
      expect(elicited["LifecycleExpireOnly"]).toBe(true);
    });

    it("sets LifecycleExpirationDays=30", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30 days");
      expect(elicited["LifecycleExpirationDays"]).toBe("30");
    });
  });

  // ── Variation B — explicit transition + expire ───────────────────────────
  describe("Variation B — explicit transition to IA + expire", () => {
    it("does NOT set LifecycleExpireOnly (multi-rule preserved)", () => {
      const { elicited } = run(
        "Create an S3 bucket with transition to IA after 30 days then expire after 90 days",
      );
      expect(elicited["LifecycleExpireOnly"]).toBeUndefined();
    });

    it("does NOT set EnableLifecycle via extractor (left to intent-defaults)", () => {
      const { elicited } = run(
        "Create an S3 bucket with transition to IA after 30 days then expire after 90 days",
      );
      // Extractor should not interfere when both transition + expire keywords present
      expect(elicited["EnableLifecycle"]).toBeUndefined();
    });

    it("emits no advisories", () => {
      const { advisories } = run(
        "Create an S3 bucket with transition to IA after 30 days then expire after 90 days",
      );
      expect(advisories).toHaveLength(0);
    });
  });

  // ── Variation C — no lifecycle keyword ──────────────────────────────────
  describe("Variation C — no lifecycle keyword", () => {
    it("does not set any lifecycle fields", () => {
      const { elicited } = run("Create an S3 bucket");
      expect(elicited["EnableLifecycle"]).toBeUndefined();
      expect(elicited["LifecycleExpireOnly"]).toBeUndefined();
      expect(elicited["LifecycleExpirationDays"]).toBeUndefined();
    });

    it("emits no advisories", () => {
      const { advisories } = run("Create an S3 bucket");
      expect(advisories).toHaveLength(0);
    });
  });

  // ── Variation D — different day value (lifecycle 90d) ────────────────────
  describe("Variation D — lifecycle 90d", () => {
    it("sets LifecycleExpirationDays=90", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 90d");
      expect(elicited["LifecycleExpirationDays"]).toBe("90");
    });

    it("sets LifecycleExpireOnly=true", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 90d");
      expect(elicited["LifecycleExpireOnly"]).toBe(true);
    });

    it("advisory details.days === 90", () => {
      const { advisories } = run("Create an S3 bucket with lifecycle 90d");
      expect(advisories[0]!.details?.["days"]).toBe(90);
    });
  });

  // ── Variation E — extractor does not fire when no lifecycle phrase ────────
  describe("Variation E — extractor non-interference for non-S3 resources", () => {
    it("does not fire for non-S3 resource types", () => {
      const { elicited, advisories } = run(
        "Create a Lambda function with lifecycle 30d",
        RESOURCE_TYPES.LAMBDA_FUNCTION,
      );
      expect(elicited["LifecycleExpireOnly"]).toBeUndefined();
      expect(advisories).toHaveLength(0);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("lifecycle 180d → ExpirationDays=180", () => {
      const { elicited } = run("S3 bucket lifecycle 180d");
      expect(elicited["LifecycleExpirationDays"]).toBe("180");
    });

    it("only 'transition' keyword (no 'expire') → extractor fires with bare-expire path", () => {
      // e.g., "lifecycle 30d transition" — only transition is mentioned, not expire
      // The extractor checks for BOTH transition AND expire to bypass.
      // "transition" alone without "expire" triggers the bare expire-only path
      // (the IA transition-only case is also a contradiction — object never expires).
      // However, "lifecycle 30d" + "transition" alone → no expire keyword, so
      // extractor still fires since we require BOTH to skip.
      const { elicited } = run("Create S3 with lifecycle 30d transition rules");
      // hasTransition=true, hasExpire=false → extractor fires
      expect(elicited["LifecycleExpireOnly"]).toBe(true);
    });

    it("only 'expiration' keyword (no 'transition') → extractor fires", () => {
      const { elicited } = run(
        "Create S3 with lifecycle 60d expiration policy",
      );
      // hasTransition=false, hasExpire=true → extractor fires (no both-present bypass)
      expect(elicited["LifecycleExpireOnly"]).toBe(true);
    });

    it("'transition' AND 'expire' both present → extractor does NOT fire", () => {
      const { elicited, advisories } = run(
        "Create S3 lifecycle 30d transition to IA and expire after 60",
      );
      expect(elicited["LifecycleExpireOnly"]).toBeUndefined();
      expect(advisories).toHaveLength(0);
    });
  });

  // ── PH5-8-A: NoncurrentVersion lifecycle ────────────────────────────────
  describe("NC-A — noncurrent only: 'delete old versions after 30 days'", () => {
    const INTENT =
      "Create an S3 bucket with versioning enabled and lifecycle to delete old versions after 30 days";

    it("sets EnableLifecycle=true", () => {
      const { elicited } = run(INTENT);
      expect(elicited["EnableLifecycle"]).toBe(true);
    });

    it("sets LifecycleNoncurrentExpirationDays=30", () => {
      const { elicited } = run(INTENT);
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBe("30");
    });

    it("does NOT set LifecycleExpirationDays (no current-version expiry)", () => {
      const { elicited } = run(INTENT);
      expect(elicited["LifecycleExpirationDays"]).toBeUndefined();
    });

    it("does NOT set LifecycleExpireOnly", () => {
      const { elicited } = run(INTENT);
      expect(elicited["LifecycleExpireOnly"]).toBeUndefined();
    });

    it("emits no S3_NONCURRENT_REQUIRES_VERSIONING advisory when versioning mentioned", () => {
      const { advisories } = run(INTENT);
      const codes = advisories.map((a) => a.code);
      expect(codes).not.toContain(S3_NONCURRENT_REQUIRES_VERSIONING_CODE);
    });
  });

  describe("NC-B — PD-4 regression-guard: bare 'lifecycle 30d' unaffected", () => {
    it("still sets LifecycleExpireOnly=true", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30d");
      expect(elicited["LifecycleExpireOnly"]).toBe(true);
    });

    it("still sets LifecycleExpirationDays=30", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30d");
      expect(elicited["LifecycleExpirationDays"]).toBe("30");
    });

    it("does NOT set LifecycleNoncurrentExpirationDays", () => {
      const { elicited } = run("Create an S3 bucket with lifecycle 30d");
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBeUndefined();
    });
  });

  describe("NC-C — both current AND noncurrent: lifecycle 30 days + delete old versions after 7 days", () => {
    const INTENT =
      "Create an S3 bucket with versioning enabled, lifecycle 30 days and delete old versions after 7 days";

    it("sets LifecycleExpirationDays=30 (current-version)", () => {
      const { elicited } = run(INTENT);
      expect(elicited["LifecycleExpirationDays"]).toBe("30");
    });

    it("sets LifecycleNoncurrentExpirationDays=7 (noncurrent)", () => {
      const { elicited } = run(INTENT);
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBe("7");
    });

    it("sets EnableLifecycle=true", () => {
      const { elicited } = run(INTENT);
      expect(elicited["EnableLifecycle"]).toBe(true);
    });
  });

  describe("NC-D — noncurrent without versioning keyword → advisor warning", () => {
    const INTENT =
      "Create an S3 bucket with lifecycle to delete old versions after 30 days";

    it("sets LifecycleNoncurrentExpirationDays=30", () => {
      const { elicited } = run(INTENT);
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBe("30");
    });

    it("emits S3_NONCURRENT_REQUIRES_VERSIONING advisory", () => {
      const { advisories } = run(INTENT);
      const advisory = advisories.find(
        (a) => a.code === S3_NONCURRENT_REQUIRES_VERSIONING_CODE,
      );
      expect(advisory).toBeDefined();
    });

    it("S3_NONCURRENT_REQUIRES_VERSIONING hint matches canonical constant", () => {
      const { advisories } = run(INTENT);
      const advisory = advisories.find(
        (a) => a.code === S3_NONCURRENT_REQUIRES_VERSIONING_CODE,
      );
      expect(advisory?.hint).toBe(S3_NONCURRENT_REQUIRES_VERSIONING_HINT);
    });

    it("advisory details.days === 30", () => {
      const { advisories } = run(INTENT);
      const advisory = advisories.find(
        (a) => a.code === S3_NONCURRENT_REQUIRES_VERSIONING_CODE,
      );
      expect(advisory?.details?.["days"]).toBe(30);
    });
  });

  describe("NC-E — synonym variations for noncurrent keyword", () => {
    it("'previous versions after 14 days' → LifecycleNoncurrentExpirationDays=14", () => {
      const { elicited } = run(
        "Create an S3 bucket with versioning enabled and lifecycle to delete previous versions after 14 days",
      );
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBe("14");
    });

    it("'non-current after 60 days' → LifecycleNoncurrentExpirationDays=60", () => {
      const { elicited } = run(
        "Create an S3 bucket with versioning, lifecycle to delete non-current after 60 days",
      );
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBe("60");
    });

    it("'noncurrent versions after 90d' → LifecycleNoncurrentExpirationDays=90", () => {
      const { elicited } = run(
        "Create an S3 bucket with versioning enabled, lifecycle noncurrent versions after 90d",
      );
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBe("90");
    });

    it("'old object versions after 45 days' → LifecycleNoncurrentExpirationDays=45", () => {
      const { elicited } = run(
        "Create an S3 bucket with versioning enabled, lifecycle to delete old object versions after 45 days",
      );
      expect(elicited["LifecycleNoncurrentExpirationDays"]).toBe("45");
    });
  });
});
