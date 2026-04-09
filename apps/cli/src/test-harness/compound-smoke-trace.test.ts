/**
 * Compound happy-path smoke traces — Item 3c (2026-04-10).
 *
 * Uses the Item 1 failure-injection harness in pure no-failure mode
 * (i.e. happy-path simulation) to prove that the compounds touched
 * by Task 4b's static-website CCAPI migration still land cleanly:
 *
 *   - VPC networking (17 resources, unchanged by Task 4b — regression
 *     guard)
 *   - Static Website (4 resources — the compound that used to rely
 *     on a ~430 LOC direct-SDK post-provision hook; now fully CCAPI
 *     after Task 4b promoted OAC + BucketPolicy to first-class)
 *   - S3 + BucketPolicy fragment — covered as part of the
 *     Static Website trace because the bucket policy is the last
 *     tier in the compound and exercises the marker-ref resolver
 *     path most likely to regress.
 *
 * ── What "smoke trace" means here ─────────────────────────────────
 *
 * These are UNIT-SPEED tests (no AWS, no network, no live LangGraph
 * loop). They prove three invariants that are mechanical enough to
 * assert without live apply:
 *
 *   1. Every compound's `resourceList` + `dependencyOrder` parse
 *      into a valid DAG — no dangling ids, no orphan positions,
 *      every id in `dependencyOrder` matches an entry in
 *      `resourceList`.
 *
 *   2. Every `markerRef` / `markerGetAtt` token embedded anywhere
 *      inside `defaultOptions` (walked recursively through nested
 *      objects, arrays, and inside string templates like
 *      `arn:aws:s3:::${markerRef(...)}/*`) points to a resourceId
 *      that actually exists in the same pattern. This is the
 *      invariant Winston called out in the session N-1 debate as
 *      the "money coherence check" for Task 4b's migration.
 *
 *   3. A synthetic sequential apply through the Item 1 harness
 *      creates every resource in `resourceList` order, zero
 *      failures, zero leaked calls. The final `tracker.created`
 *      array length equals the resourceList length, and the types
 *      match forward dependency order.
 *
 * ── What this test does NOT do ────────────────────────────────────
 *
 *   - Run the real plan-generator's `resolveCompoundMarkers` against
 *     a live state (that's covered by the existing compound-
 *     provisioning-audit tests).
 *   - Drive the LangGraph compound apply loop end-to-end. The
 *     port-level contract is proven here; graph routing has its
 *     own test suite.
 *   - Talk to AWS. Pure unit speed.
 *
 * ── Relation to the Item 1 matrix ────────────────────────────────
 *
 * The compound-cleanup-matrix.test.ts proves "resource K fails →
 * reverse cleanup unwinds [0..K-1]". This file proves the
 * complementary invariant: "all N resources land in the happy
 * path, all cross-references are internally consistent". Together
 * they cover both the rollback and apply sides of compound
 * correctness without needing live AWS.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  vpcNetworkingPattern,
  staticWebsitePattern,
  lambdaWithExecRolePattern,
  efsWithVpcPattern,
  scheduledLambdaPattern,
  serverlessApiPattern,
  parseMarker,
  type ArchitecturePattern,
} from "@assignee/core";
import {
  buildInMemoryProvisioningPort,
  type InMemoryProvisioningTracker,
} from "./compound-failure-injector.js";
import type { ProvisioningPort } from "../services/provisioning-port.js";

// ── Generic invariant checkers (no pattern-specific knowledge) ─────────

/**
 * Walk an arbitrarily nested value looking for marker tokens.
 * Every marker found is handed to the callback with its parsed
 * form + the JSON path where it was discovered (for actionable
 * assertion failures).
 */
function walkForMarkers(
  value: unknown,
  callback: (
    parsed: NonNullable<ReturnType<typeof parseMarker>>,
    path: string,
  ) => void,
  pathSoFar = "$",
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    // The value might be a bare marker OR a string that embeds one
    // or more markers inside a template (e.g.
    // `arn:aws:s3:::${markerRef("website-bucket")}/*`). The embedded
    // case produces strings like
    // `arn:aws:s3:::__ASSIGNEE_REF_website-bucket__/*`. Scan with
    // a global regex so both cases are covered.
    const global = /__ASSIGNEE_(?:REF|GETATT|AZ)_[^\s]+?__/g;
    let match: RegExpExecArray | null;
    while ((match = global.exec(value)) !== null) {
      const parsed = parseMarker(match[0]);
      if (parsed) callback(parsed, pathSoFar);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkForMarkers(value[i], callback, `${pathSoFar}[${i}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      walkForMarkers(child, callback, `${pathSoFar}.${key}`);
    }
  }
}

/**
 * Build the set of valid resourceIds for a pattern. Used by the
 * marker-ref validator to fail tests that reference a misspelled
 * or deleted resource.
 */
function validResourceIds(pattern: ArchitecturePattern): Set<string> {
  return new Set(pattern.resourceList.map((r) => r.resourceId));
}

/**
 * Walk the dependencyOrder and assert that every id shows up in
 * resourceList. Catches typos + stale ids after a rename refactor.
 */
function assertDependencyOrderWellFormed(pattern: ArchitecturePattern): void {
  const valid = validResourceIds(pattern);
  for (let g = 0; g < pattern.dependencyOrder.length; g++) {
    const group = pattern.dependencyOrder[g]!;
    for (const id of group) {
      expect(
        valid.has(id),
        `${pattern.patternId}: dependencyOrder group [${g}] references unknown resourceId "${id}"`,
      ).toBe(true);
    }
  }
  // Every resource in resourceList should appear in exactly one
  // dependencyOrder group — a resource that's in the list but not
  // scheduled would be silently skipped at apply time.
  const scheduled = new Set(pattern.dependencyOrder.flat());
  for (const r of pattern.resourceList) {
    expect(
      scheduled.has(r.resourceId),
      `${pattern.patternId}: resourceList contains "${r.resourceId}" but dependencyOrder never schedules it`,
    ).toBe(true);
  }
}

/**
 * Walk all marker tokens in the pattern's defaultOptions and
 * assert each one points to a valid resourceId. This is the
 * "every marker-ref resolves" invariant Winston asked for in
 * Item 3c — it would catch a typo'd marker during a future
 * compound refactor before a real apply hits CCAPI and fails
 * with a cryptic "unresolved token" error.
 */
function assertAllMarkersResolveInternally(pattern: ArchitecturePattern): void {
  const valid = validResourceIds(pattern);
  walkForMarkers(pattern.defaultOptions, (parsed, path) => {
    if (parsed.kind === "ref" || parsed.kind === "getatt") {
      expect(
        valid.has(parsed.resourceId),
        `${pattern.patternId}: marker at ${path} references unknown resourceId "${parsed.resourceId}" (valid ids: ${[...valid].join(", ")})`,
      ).toBe(true);
    }
    // az markers don't carry a resourceId — no cross-reference
    // check needed.
  });
}

/**
 * Drive a synthetic sequential apply of the whole pattern through
 * the in-memory port. Asserts that createResource is called exactly
 * once per resourceList entry, in forward order, with no failures.
 */
async function simulateHappyPathApply(
  port: ProvisioningPort,
  pattern: ArchitecturePattern,
): Promise<void> {
  for (const spec of pattern.resourceList) {
    const [err, result] = await port.createResource(
      spec.resourceType,
      JSON.stringify({ resourceId: spec.resourceId }),
      `client-token-${spec.resourceId}`,
    );
    expect(
      err,
      `${pattern.patternId}: createResource for ${spec.resourceId} returned error`,
    ).toBeNull();
    expect(result).not.toBeNull();
    const [statusErr, status] = await port.getRequestStatus(
      result!.requestToken,
    );
    expect(statusErr).toBeNull();
    expect(status?.operationStatus).toBe("SUCCESS");
  }
}

// ── Test fixtures ────────────────────────────────────────────────────────

describe("compound happy-path smoke traces (Item 3c)", () => {
  let port: ProvisioningPort;
  let tracker: InMemoryProvisioningTracker;

  beforeEach(() => {
    const built = buildInMemoryProvisioningPort();
    port = built.port;
    tracker = built.tracker;
  });

  // ── Static Website compound (Task 4b target) ───────────────────────────
  describe("static-website compound (Task 4b post-migration)", () => {
    it("resourceList + dependencyOrder are well-formed", () => {
      assertDependencyOrderWellFormed(staticWebsitePattern);
    });

    it("contains exactly the 4 expected first-class CCAPI types", () => {
      const types = staticWebsitePattern.resourceList.map(
        (r) => r.resourceType,
      );
      expect(types).toEqual([
        "AWS::S3::Bucket",
        "AWS::CloudFront::OriginAccessControl",
        "AWS::CloudFront::Distribution",
        "AWS::S3::BucketPolicy",
      ]);
    });

    it("every marker-ref in defaultOptions points to a valid resourceId", () => {
      assertAllMarkersResolveInternally(staticWebsitePattern);
    });

    it("bucket-policy's marker-refs include both website-bucket and cdn-distribution", () => {
      // Explicit assertion for the cross-tier reference that was
      // the whole reason BucketPolicy needed to be promoted to
      // first-class CCAPI in Task 4b — policy needs the full
      // distribution ARN via aws:SourceArn, which only lands once
      // the distribution itself is provisioned.
      const foundRefs = new Set<string>();
      walkForMarkers(
        staticWebsitePattern.defaultOptions["bucket-policy"],
        (parsed) => {
          if (parsed.kind === "ref") foundRefs.add(parsed.resourceId);
        },
      );
      expect(foundRefs.has("website-bucket")).toBe(true);
      expect(foundRefs.has("cdn-distribution")).toBe(true);
    });

    it("cdn-distribution references the OAC + bucket via markers", () => {
      const foundRefs = new Set<string>();
      walkForMarkers(
        staticWebsitePattern.defaultOptions["cdn-distribution"],
        (parsed) => {
          if (parsed.kind === "ref") foundRefs.add(parsed.resourceId);
        },
      );
      expect(foundRefs.has("cdn-oac")).toBe(true);
      expect(foundRefs.has("website-bucket")).toBe(true);
    });

    it("happy-path apply creates all 4 resources in forward order", async () => {
      await simulateHappyPathApply(port, staticWebsitePattern);
      expect(tracker.created).toHaveLength(4);
      expect(tracker.created.map((r) => r.typeName)).toEqual([
        "AWS::S3::Bucket",
        "AWS::CloudFront::OriginAccessControl",
        "AWS::CloudFront::Distribution",
        "AWS::S3::BucketPolicy",
      ]);
    });
  });

  // ── VPC networking compound (regression guard) ─────────────────────────
  describe("vpc-networking compound (regression guard)", () => {
    it("resourceList + dependencyOrder are well-formed", () => {
      assertDependencyOrderWellFormed(vpcNetworkingPattern);
    });

    it("every marker-ref in defaultOptions points to a valid resourceId", () => {
      assertAllMarkersResolveInternally(vpcNetworkingPattern);
    });

    it("happy-path apply creates all 17 resources in forward order", async () => {
      await simulateHappyPathApply(port, vpcNetworkingPattern);
      expect(tracker.created).toHaveLength(
        vpcNetworkingPattern.resourceList.length,
      );
      // Forward-order invariant: first resource is the VPC itself;
      // everything else depends on it (directly or transitively).
      expect(tracker.created[0]!.typeName).toBe("AWS::EC2::VPC");
      // Last resources should be the SubnetRouteTableAssociations,
      // which only make sense after subnets + route tables + routes
      // are all in place.
      const lastType = tracker.created.at(-1)!.typeName;
      expect(lastType).toBe("AWS::EC2::SubnetRouteTableAssociation");
    });
  });

  // ── Other compounds (smoke-only, no deep assertions) ───────────────────
  // Each compound gets the 3 invariants (well-formed DAG, internally
  // consistent markers, happy-path apply) but no pattern-specific
  // structural assertions. If any of these break, the compound has
  // a real data-shape bug that's worth investigating before a user
  // hits it.
  describe.each([
    ["lambda-with-exec-role", lambdaWithExecRolePattern],
    ["efs-with-vpc", efsWithVpcPattern],
    ["scheduled-lambda", scheduledLambdaPattern],
    ["serverless-api", serverlessApiPattern],
  ] as const)("%s compound", (_name, pattern) => {
    it("resourceList + dependencyOrder are well-formed", () => {
      assertDependencyOrderWellFormed(pattern);
    });

    it("every marker-ref in defaultOptions points to a valid resourceId", () => {
      assertAllMarkersResolveInternally(pattern);
    });

    it("happy-path apply creates every resource in forward order", async () => {
      await simulateHappyPathApply(port, pattern);
      expect(tracker.created).toHaveLength(pattern.resourceList.length);
      // Type sequence should exactly mirror resourceList order (the
      // in-memory port's createResource is synchronous and
      // simulateHappyPathApply awaits in order, so the tracker
      // observes the same forward order).
      expect(tracker.created.map((r) => r.typeName)).toEqual(
        pattern.resourceList.map((r) => r.resourceType),
      );
    });
  });
});
