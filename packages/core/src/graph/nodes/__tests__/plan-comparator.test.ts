/**
 * Epic 94 Wave 2 fixer e94.N5 — plan-stage advisory comparator unit tests.
 *
 * Covers the `computePlanAdvisories` helper exported by
 * `packages/core/src/graph/nodes/plan-generator.ts`, which emits
 * structured advisories for silent mutations the user should know
 * about:
 *
 *   - `BP_ADJUSTED_VALUE` (D-05): CloudWatch Logs `RetentionInDays`
 *     below the BP minimum (30) is raised in-place and an advisory
 *     with `details: {field, from, to}` is returned.
 *   - `NAME_REWRITTEN` (A-11, A-15): when the final desiredState's
 *     name key differs from the user-asserted value in
 *     `elicitedOptions`, an advisory with `details: {field, from, to}`
 *     is returned.
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import {
  BP_MIN_RETENTION_DAYS,
  computePlanAdvisories,
} from "../plan-generator.js";

describe("computePlanAdvisories (e94.N5)", () => {
  // -------------------------------------------------------------------
  // D-05 — BP_ADJUSTED_VALUE for RetentionInDays
  // -------------------------------------------------------------------
  describe("D-05: BP_ADJUSTED_VALUE for RetentionInDays", () => {
    it("raises RetentionInDays=14 to 30 and emits BP_ADJUSTED_VALUE", () => {
      const desired: Record<string, unknown> = {
        LogGroupName: "/aws/lambda/foo",
        RetentionInDays: 14,
      };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.LOGS_LOG_GROUP,
        { RetentionInDays: 14 },
      );
      expect(desired["RetentionInDays"]).toBe(BP_MIN_RETENTION_DAYS);
      const bp = advisories.find((a) => a.code === "BP_ADJUSTED_VALUE");
      expect(bp).toBeDefined();
      expect(bp!.details).toEqual({
        field: "RetentionInDays",
        from: 14,
        to: BP_MIN_RETENTION_DAYS,
      });
      // Message must carry the before/after values so the CLI render
      // is self-explanatory even without inspecting .details.
      expect(bp!.message).toContain("14");
      expect(bp!.message).toContain(String(BP_MIN_RETENTION_DAYS));
    });

    it("raises string-typed retention `'7'` to 30", () => {
      const desired: Record<string, unknown> = {
        LogGroupName: "/aws/lambda/foo",
        RetentionInDays: "7",
      };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.LOGS_LOG_GROUP,
        undefined,
      );
      expect(desired["RetentionInDays"]).toBe(BP_MIN_RETENTION_DAYS);
      expect(advisories.some((a) => a.code === "BP_ADJUSTED_VALUE")).toBe(true);
    });

    it("does NOT raise when RetentionInDays is already >= 30", () => {
      const desired: Record<string, unknown> = {
        LogGroupName: "/aws/lambda/foo",
        RetentionInDays: 30,
      };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.LOGS_LOG_GROUP,
        undefined,
      );
      expect(desired["RetentionInDays"]).toBe(30);
      expect(advisories.some((a) => a.code === "BP_ADJUSTED_VALUE")).toBe(
        false,
      );
    });

    it("does NOT raise retention for non-LogGroup resource types", () => {
      const desired: Record<string, unknown> = {
        BucketName: "foo",
        RetentionInDays: 14,
      };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.S3_BUCKET,
        undefined,
      );
      // Untouched — RetentionInDays is not a BP concern for S3.
      expect(desired["RetentionInDays"]).toBe(14);
      expect(advisories).toHaveLength(0);
    });

    it("ignores `never expire` (retention not a positive integer)", () => {
      const desired: Record<string, unknown> = {
        LogGroupName: "/aws/lambda/foo",
        // Not a positive integer — the RetentionInDays field is absent
        // (CloudWatch default is indefinite).
      };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.LOGS_LOG_GROUP,
        undefined,
      );
      expect(advisories.some((a) => a.code === "BP_ADJUSTED_VALUE")).toBe(
        false,
      );
    });
  });

  // -------------------------------------------------------------------
  // A-11 + A-15 — NAME_REWRITTEN comparator
  // -------------------------------------------------------------------
  describe("A-11 + A-15: NAME_REWRITTEN comparator", () => {
    it("emits NAME_REWRITTEN when final BucketName differs from elicited value", () => {
      const desired: Record<string, unknown> = {
        BucketName: "ip-192-168-1-1",
      };
      const elicited = { BucketName: "192.168.1.1" };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.S3_BUCKET,
        elicited,
      );
      const nameAdvisory = advisories.find((a) => a.code === "NAME_REWRITTEN");
      expect(nameAdvisory).toBeDefined();
      expect(nameAdvisory!.details).toEqual({
        field: "BucketName",
        from: "192.168.1.1",
        to: "ip-192-168-1-1",
      });
      // Message carries both values verbatim.
      expect(nameAdvisory!.message).toContain("192.168.1.1");
      expect(nameAdvisory!.message).toContain("ip-192-168-1-1");
    });

    it("does NOT emit when asserted and final values match", () => {
      const desired: Record<string, unknown> = { BucketName: "my-bucket" };
      const elicited = { BucketName: "my-bucket" };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.S3_BUCKET,
        elicited,
      );
      expect(advisories.some((a) => a.code === "NAME_REWRITTEN")).toBe(false);
    });

    it("does NOT emit when elicitedOptions is undefined (no user assertion)", () => {
      const desired: Record<string, unknown> = { BucketName: "auto-generated" };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.S3_BUCKET,
        undefined,
      );
      expect(advisories.some((a) => a.code === "NAME_REWRITTEN")).toBe(false);
    });

    it("emits for Lambda FunctionName rewrites", () => {
      const desired: Record<string, unknown> = { FunctionName: "sanitised-fn" };
      const elicited = { FunctionName: "original-fn" };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.LAMBDA_FUNCTION,
        elicited,
      );
      const rewrite = advisories.find((a) => a.code === "NAME_REWRITTEN");
      expect(rewrite).toBeDefined();
      expect(rewrite!.details).toEqual({
        field: "FunctionName",
        from: "original-fn",
        to: "sanitised-fn",
      });
    });

    it("is a no-op for types without a user-settable name field", () => {
      // EC2::Instance uses tags for naming, so resolveNameField returns
      // null. Comparator quietly skips.
      const desired: Record<string, unknown> = { ImageId: "ami-12345678" };
      const elicited = { ImageId: "ami-87654321" };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.EC2_INSTANCE,
        elicited,
      );
      expect(advisories).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Combined — both advisories can fire in the same call
  // -------------------------------------------------------------------
  describe("combined: both advisories can fire on the same desiredState", () => {
    it("emits BP_ADJUSTED_VALUE and NAME_REWRITTEN together when appropriate", () => {
      const desired: Record<string, unknown> = {
        LogGroupName: "sanitised-lg",
        RetentionInDays: 14,
      };
      const elicited = {
        LogGroupName: "original-lg",
        RetentionInDays: 14,
      };
      const advisories = computePlanAdvisories(
        desired,
        RESOURCE_TYPES.LOGS_LOG_GROUP,
        elicited,
      );
      const codes = advisories.map((a) => a.code).sort();
      expect(codes).toEqual(["BP_ADJUSTED_VALUE", "NAME_REWRITTEN"].sort());
    });
  });
});
