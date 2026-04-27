/**
 * Regression tests for the static-website compound pattern.
 *
 * Primary focus: the BucketPolicy resource's `Resource` ARN, which is
 * constructed from a `markerRef(R.WEBSITE_BUCKET)` token. The compound
 * marker resolver substitutes that token with the FULL ARN of the bucket
 * (returned by `completedResources[].resourceArn` and synthesized by
 * `buildResourceArn`), so the template must NOT prepend its own
 * `arn:*:s3:::` prefix — doing so produces a double-nested ARN like
 * `arn:*:s3:::arn:aws:s3:::bucket-name/*` which S3 rejects with
 * "Policy has invalid resource (Service: S3, Status Code: 400)".
 *
 * This test pins the correct behaviour: `${markerRef(R.WEBSITE_BUCKET)}/*`
 * must resolve to `arn:aws:s3:::<bucket>/*` exactly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { staticWebsitePattern } from "./static-website.js";
import { StaticWebsiteResourceId as R } from "../pattern-resource-ids.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { PatternId } from "../pattern-ids.js";
import type { ResourceResult } from "../types.js";
import {
  resolveCompoundMarkers,
  __resetAzCacheForTests,
  type AzLookup,
  type AccountIdLookup,
} from "../../graph/nodes/plan-generator/marker-resolver.js";

const fakeAccountIdLookup: AccountIdLookup = async () => "210987654321";

// AZ lookup is irrelevant for BucketPolicy resolution (no AZ markers in the
// defaultOptions for R.BUCKET_POLICY), but the resolver contract takes an
// AzLookup port — supply a deterministic fixture so the test is hermetic
// regardless of whether the resolver lazily invokes it.
const fakeAzLookup: AzLookup = async () => [
  "us-east-1a",
  "us-east-1b",
  "us-east-1c",
];

const TEST_BUCKET_NAME = "assignee-website-bucket-test";
// At runtime the compound resolver reads `completedResources[].resourceArn`
// which status-poller.ts:254 sets from `result.identifier` returned by
// CCAPI. For AWS::S3::Bucket that's the bare bucket NAME — not a full
// ARN. The fixtures mirror that reality so the test actually matches
// production behaviour.
const TEST_BUCKET_IDENTIFIER = TEST_BUCKET_NAME;
// For CloudFront distributions CCAPI returns the bare distribution ID as
// the identifier (e.g. "ETESTFAKE"), so resourceArn is the bare ID, not a
// full ARN. fakeAccountIdLookup below returns the project-canonical
// non-denylist test account ID 210987654321 so tests that synthesize a
// full ARN (e.g. aws:SourceArn) assert against a stable, non-real account.
const TEST_DISTRIBUTION_IDENTIFIER = "ETESTFAKE";

/**
 * Build the `completedResources` fixture the resolver expects when resolving
 * the BucketPolicy's marker tokens — the bucket and the distribution must
 * both have already been "provisioned" (SUCCESS) with full ARNs so the
 * marker lookup succeeds.
 */
function buildCompletedResources(): ResourceResult[] {
  return [
    {
      resourceId: R.WEBSITE_BUCKET,
      resourceType: RESOURCE_TYPES.S3_BUCKET,
      executionStatus: "SUCCESS" as never,
      // Bare bucket name — matches `result.identifier` from CCAPI.
      resourceArn: TEST_BUCKET_IDENTIFIER,
    },
    {
      resourceId: R.CDN_OAC,
      resourceType: RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
      executionStatus: "SUCCESS" as never,
      resourceArn: "E1OACFAKEID0ABC",
    },
    {
      resourceId: R.CDN_DISTRIBUTION,
      resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      executionStatus: "SUCCESS" as never,
      // CCAPI returns the bare distribution ID. If we ever add a
      // buildResourceArn step between status-poller and the resolver,
      // this fixture must change in lockstep.
      resourceArn: TEST_DISTRIBUTION_IDENTIFIER,
    },
  ];
}

/**
 * Deep-clone the shared defaultOptions entry so the test never mutates the
 * module-level pattern object (the resolver is destructive — it rewrites
 * the state in place).
 */
function cloneBucketPolicyOptions(): Record<string, unknown> {
  const raw = staticWebsitePattern.defaultOptions[R.BUCKET_POLICY];
  if (!raw) {
    throw new Error(
      `staticWebsitePattern.defaultOptions[${R.BUCKET_POLICY}] is missing — ` +
        `pattern definition has regressed.`,
    );
  }
  // structuredClone is available in Node 17+; the project already targets
  // Node 22. A JSON round-trip would work too but would also strip Date/etc.
  return structuredClone(raw) as Record<string, unknown>;
}

type ResolvedPolicyStatement = {
  Resource: string;
  Condition: { StringEquals: { "aws:SourceArn": string } };
};

function statementFrom(
  resolved: Record<string, unknown>,
): ResolvedPolicyStatement {
  const policyDocument = resolved["PolicyDocument"] as {
    Statement: ResolvedPolicyStatement[];
  };
  expect(policyDocument).toBeDefined();
  expect(Array.isArray(policyDocument.Statement)).toBe(true);
  expect(policyDocument.Statement).toHaveLength(1);
  return policyDocument.Statement[0]!;
}

describe("staticWebsitePattern — BucketPolicy Resource ARN regression", () => {
  beforeEach(() => __resetAzCacheForTests());

  it("has patternId 'static-website' (sanity pin)", () => {
    expect(staticWebsitePattern.patternId).toBe(PatternId.STATIC_WEBSITE);
  });

  it("BucketPolicy Resource resolves to a well-formed S3 object ARN with /* suffix", async () => {
    const cloned = cloneBucketPolicyOptions();
    const completed = buildCompletedResources();

    await resolveCompoundMarkers(cloned, {
      completedResources: completed,
      region: "us-east-1",
      currentResourceId: R.BUCKET_POLICY,
      azLookup: fakeAzLookup,
      accountIdLookup: fakeAccountIdLookup,
    });

    const stmt = statementFrom(cloned);

    // Well-formed S3 object ARN with wildcard.
    expect(stmt.Resource).toMatch(/^arn:aws:s3:::[\w-]+\/\*$/);

    // Explicit guard against the previous bug: double-nested ARN where the
    // template prefixed `arn:*:s3:::` and the resolver substituted the full
    // bucket ARN in the identifier slot, producing
    // `arn:*:s3:::arn:aws:s3:::<bucket>/*`.
    expect(stmt.Resource).not.toMatch(/arn:.*:s3:::arn:/);

    // Exact match — the value S3 actually needs.
    expect(stmt.Resource).toBe(`arn:aws:s3:::${TEST_BUCKET_NAME}/*`);
  });

  it("BucketPolicy aws:SourceArn resolves to the distribution's full ARN (pin — never worked wrong)", async () => {
    const cloned = cloneBucketPolicyOptions();
    const completed = buildCompletedResources();

    await resolveCompoundMarkers(cloned, {
      completedResources: completed,
      region: "us-east-1",
      currentResourceId: R.BUCKET_POLICY,
      azLookup: fakeAzLookup,
      accountIdLookup: fakeAccountIdLookup,
    });

    const stmt = statementFrom(cloned);

    // Epic 88-it3 regression guard: the template manually builds the
    // full CloudFront distribution ARN because markerRef resolves to
    // the bare distribution ID (CCAPI's `result.identifier`), and the
    // IAM AWS:SourceArn condition requires the full ARN for scoping.
    // The fake accountIdLookup in this test returns 210987654321.
    expect(stmt.Condition.StringEquals["aws:SourceArn"]).toBe(
      `arn:aws:cloudfront::210987654321:distribution/${TEST_DISTRIBUTION_IDENTIFIER}`,
    );
    // Shape guard: must be a full CloudFront distribution ARN, never a
    // bare ID (the earlier failure mode that CCAPI accepted but the
    // IAM evaluator quietly didn't honour, causing S3 to return 403
    // when CloudFront fetched through OAC).
    expect(stmt.Condition.StringEquals["aws:SourceArn"]).toMatch(
      /^arn:aws:cloudfront::\d{12}:distribution\/[A-Z0-9]+$/,
    );
  });

  it("BucketPolicy Bucket field resolves to the BARE bucket NAME (not the ARN — CCAPI rejects ARN)", async () => {
    const cloned = cloneBucketPolicyOptions();
    const completed = buildCompletedResources();

    await resolveCompoundMarkers(cloned, {
      completedResources: completed,
      region: "us-east-1",
      currentResourceId: R.BUCKET_POLICY,
      azLookup: fakeAzLookup,
      accountIdLookup: fakeAccountIdLookup,
    });

    // Epic 88-it2 regression guard: AWS::S3::BucketPolicy.Bucket requires
    // the bare bucket NAME, NOT the ARN. CCAPI rejects the ARN form with
    // "The specified bucket is not valid (Service: S3, Status Code: 400)"
    // — reproduced twice in dogfood runs on 2026-04-20 against real AWS.
    // The pattern uses `markerIdentifier(R.WEBSITE_BUCKET)` (not markerRef)
    // so the resolver runs extractIdentifierFromArn to strip the
    // `arn:aws:s3:::` prefix and emit just the bare bucket name.
    expect(cloned["Bucket"]).toBe(TEST_BUCKET_NAME);
    // Explicit guards: the old failure mode was "ARN where name expected"
    // — lock it out forever.
    expect(cloned["Bucket"]).not.toMatch(/^arn:/);
    expect(cloned["Bucket"]).not.toContain(":::");
  });
});
