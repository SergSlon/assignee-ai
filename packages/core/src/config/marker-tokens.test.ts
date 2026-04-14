import { describe, it, expect } from "vitest";
import {
  MARKER_PREFIX,
  MARKER_SUFFIX,
  MARKER_PATTERN,
  markerRef,
  markerGetAtt,
  markerAz,
  markerRegion,
  parseMarker,
  isMarker,
} from "./marker-tokens.js";

/**
 * Marker tokens are load-bearing: plan-generator's compound branch walks
 * desiredState looking for these strings and substitutes physical IDs /
 * AZ names / the active region in their place. A regex regression here
 * would silently break every compound pattern (three-tier-web, container-
 * service, efs-with-vpc) by leaving `__ASSIGNEE_REF_<id>__` literals in
 * the request that CCAPI then rejects.
 *
 * Coverage targets the constructors (markerRef / markerGetAtt / markerAz /
 * markerRegion), the structural parser (parseMarker), the boolean helper
 * (isMarker), and the embedded-detection regex (MARKER_PATTERN).
 */
describe("marker-tokens", () => {
  describe("markerRef", () => {
    it("emits the canonical __ASSIGNEE_REF_<id>__ shape", () => {
      expect(markerRef("vpc")).toBe("__ASSIGNEE_REF_vpc__");
    });

    it("preserves identifiers that contain hyphens / digits", () => {
      // pattern-resource-ids.ts uses kebab-style ids like
      // "public-subnet-1" which must survive marker emission verbatim.
      expect(markerRef("public-subnet-1")).toBe(
        "__ASSIGNEE_REF_public-subnet-1__",
      );
    });

    it("throws on empty resourceId so callers fail loud at config time", () => {
      expect(() => markerRef("")).toThrow(/non-empty/);
    });
  });

  describe("markerGetAtt", () => {
    it("emits __ASSIGNEE_GETATT_<id>_<attr>__", () => {
      expect(markerGetAtt("igw", "InternetGatewayId")).toBe(
        "__ASSIGNEE_GETATT_igw_InternetGatewayId__",
      );
    });

    it("throws when resourceId is empty", () => {
      expect(() => markerGetAtt("", "Attr")).toThrow(/non-empty/);
    });

    it("throws when attribute is empty", () => {
      expect(() => markerGetAtt("igw", "")).toThrow(/non-empty/);
    });

    it("throws when attribute contains '_' (parser uses lastIndexOf split)", () => {
      // The parser uses lastIndexOf("_") to split resourceId from
      // attribute, so an attribute containing '_' would silently
      // truncate on round-trip. Fail loudly at construction time.
      expect(() => markerGetAtt("my-res", "Access_Key")).toThrow(
        /must not contain '_'/,
      );
    });
  });

  describe("markerAz", () => {
    it("emits __ASSIGNEE_AZ_<n>__ for valid indices", () => {
      expect(markerAz(0)).toBe("__ASSIGNEE_AZ_0__");
      expect(markerAz(2)).toBe("__ASSIGNEE_AZ_2__");
    });

    it("throws on negative index", () => {
      expect(() => markerAz(-1)).toThrow(/non-negative integer/);
    });

    it("throws on non-integer index", () => {
      expect(() => markerAz(1.5)).toThrow(/non-negative integer/);
    });
  });

  describe("markerRegion", () => {
    it("emits the bare __ASSIGNEE_REGION__ token", () => {
      // The token has no suffix payload — the resolver injects the
      // active AWS_REGION at apply time. Used by CloudFront S3 origin
      // DomainName so the regional endpoint resolves immediately for
      // newly-created buckets, dodging the global s3.amazonaws.com lag.
      expect(markerRegion()).toBe("__ASSIGNEE_REGION__");
    });

    it("starts with MARKER_PREFIX and ends with MARKER_SUFFIX", () => {
      const r = markerRegion();
      expect(r.startsWith(MARKER_PREFIX)).toBe(true);
      expect(r.endsWith(MARKER_SUFFIX)).toBe(true);
    });

    it("is detected by isMarker", () => {
      expect(isMarker(markerRegion())).toBe(true);
    });

    it("round-trips through parseMarker as { kind: 'region' }", () => {
      expect(parseMarker(markerRegion())).toEqual({ kind: "region" });
    });
  });

  describe("parseMarker", () => {
    it("returns undefined for non-string values", () => {
      expect(parseMarker(undefined)).toBeUndefined();
      expect(parseMarker(null)).toBeUndefined();
      expect(parseMarker(42)).toBeUndefined();
      expect(parseMarker({})).toBeUndefined();
    });

    it("returns undefined for plain strings without the marker prefix", () => {
      expect(parseMarker("vpc-0abc")).toBeUndefined();
      expect(parseMarker("__ASSIGNEE_REF_vpc")).toBeUndefined(); // missing suffix
      expect(parseMarker("REF_vpc__")).toBeUndefined(); // missing prefix
    });

    it("parses a REF marker into { kind: 'ref', resourceId }", () => {
      expect(parseMarker(markerRef("vpc"))).toEqual({
        kind: "ref",
        resourceId: "vpc",
      });
    });

    it("parses a REF marker whose resourceId contains hyphens", () => {
      expect(parseMarker(markerRef("public-subnet-1"))).toEqual({
        kind: "ref",
        resourceId: "public-subnet-1",
      });
    });

    it("returns undefined for REF_ with empty resourceId", () => {
      expect(parseMarker("__ASSIGNEE_REF___")).toBeUndefined();
    });

    it("parses a GETATT marker into { kind, resourceId, attribute }", () => {
      expect(parseMarker(markerGetAtt("igw", "InternetGatewayId"))).toEqual({
        kind: "getatt",
        resourceId: "igw",
        attribute: "InternetGatewayId",
      });
    });

    it("handles GETATT resourceIds that themselves contain underscores", () => {
      // The parser uses lastIndexOf("_") to split id/attr, which means
      // the resourceId may contain underscores while the attribute may
      // not. Pin this behaviour so a future split-on-first-underscore
      // refactor can't break compound-pattern resolution.
      expect(parseMarker("__ASSIGNEE_GETATT_my_resource_Arn__")).toEqual({
        kind: "getatt",
        resourceId: "my_resource",
        attribute: "Arn",
      });
    });

    it("returns undefined for GETATT without an attribute segment", () => {
      expect(parseMarker("__ASSIGNEE_GETATT_igw__")).toBeUndefined();
    });

    it("returns undefined for GETATT with empty resourceId (rest starts with '_')", () => {
      // Edge-hunter follow-up: pin the parser's handling of the pathological
      // "__ASSIGNEE_GETATT__attr__" shape. rest="_attr", lastIndexOf("_")=0,
      // guard `lastUnderscore <= 0` → undefined. Without this test, a parser
      // change that relaxed the guard could silently accept empty-id markers.
      expect(parseMarker("__ASSIGNEE_GETATT__attr__")).toBeUndefined();
    });

    it("parses an AZ marker into { kind: 'az', index }", () => {
      expect(parseMarker(markerAz(0))).toEqual({ kind: "az", index: 0 });
      expect(parseMarker(markerAz(5))).toEqual({ kind: "az", index: 5 });
    });

    it("returns undefined for AZ with a non-numeric index", () => {
      expect(parseMarker("__ASSIGNEE_AZ_foo__")).toBeUndefined();
    });

    it("parses the bare REGION token", () => {
      expect(parseMarker("__ASSIGNEE_REGION__")).toEqual({ kind: "region" });
    });

    it("returns undefined for unknown marker kinds", () => {
      expect(parseMarker("__ASSIGNEE_UNKNOWN_x__")).toBeUndefined();
    });
  });

  describe("isMarker", () => {
    it("is true for every well-formed marker constructor output", () => {
      expect(isMarker(markerRef("vpc"))).toBe(true);
      expect(isMarker(markerGetAtt("igw", "Id"))).toBe(true);
      expect(isMarker(markerAz(0))).toBe(true);
      expect(isMarker(markerRegion())).toBe(true);
    });

    it("is false for plain strings and non-string values", () => {
      expect(isMarker("vpc-0abc")).toBe(false);
      expect(isMarker("")).toBe(false);
      expect(isMarker(undefined)).toBe(false);
    });
  });

  describe("MARKER_PATTERN (embedded detection)", () => {
    // plan-generator uses MARKER_PATTERN to detect markers EMBEDDED in
    // longer strings (e.g. an S3 bucket DomainName like
    // "<bucket>.s3.__ASSIGNEE_REGION__.amazonaws.com"). Pin the matcher
    // shape so a future regex tightening can't silently break compound
    // pattern resolution. Architect WARNING #6/#7 also flagged this
    // regex for catastrophic backtracking risk — these tests pin
    // current correctness; tightening lands in P2.
    it("matches a bare REF marker", () => {
      expect(MARKER_PATTERN.test(markerRef("vpc"))).toBe(true);
    });

    it("matches a bare REGION marker", () => {
      expect(MARKER_PATTERN.test(markerRegion())).toBe(true);
    });

    it("matches a marker embedded inside a longer string", () => {
      // The exact use case from plan-generator's resolveString path.
      const embedded = "my-bucket.s3.__ASSIGNEE_REGION__.amazonaws.com";
      expect(MARKER_PATTERN.test(embedded)).toBe(true);
    });

    it("matches a REF marker embedded inside a longer string", () => {
      const embedded = "vpc=__ASSIGNEE_REF_vpc__,owner=acme";
      expect(MARKER_PATTERN.test(embedded)).toBe(true);
    });

    it("matches AZ and GETATT marker variants", () => {
      expect(MARKER_PATTERN.test(markerAz(0))).toBe(true);
      expect(MARKER_PATTERN.test(markerGetAtt("igw", "Id"))).toBe(true);
    });

    it("does not match unrelated strings", () => {
      expect(MARKER_PATTERN.test("just a regular string")).toBe(false);
      expect(MARKER_PATTERN.test("__ASSIGNEE_UNKNOWN__")).toBe(false);
      expect(MARKER_PATTERN.test("")).toBe(false);
    });
  });
});
