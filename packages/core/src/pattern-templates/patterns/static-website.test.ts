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
} from "../../graph/nodes/plan-generator/marker-resolver.js";

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
const TEST_BUCKET_ARN = `arn:aws:s3:::${TEST_BUCKET_NAME}`;
const TEST_DISTRIBUTION_ID = "ETESTFAKE";
// 111122223333 is an AWS-documentation placeholder account ID — not a real
// 12-digit account. Safe to embed in fixtures.
const TEST_DISTRIBUTION_ARN = `arn:aws:cloudfront::111122223333:distribution/${TEST_DISTRIBUTION_ID}`;

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
      resourceArn: TEST_BUCKET_ARN,
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
      resourceArn: TEST_DISTRIBUTION_ARN,
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
    expect(stmt.Resource).toBe(`${TEST_BUCKET_ARN}/*`);
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
    });

    const stmt = statementFrom(cloned);

    // The aws:SourceArn condition must resolve to the full distribution ARN
    // exactly — the resolver returns resourceArn verbatim, no template
    // prefix to strip. Pinning this so a future refactor that changes the
    // resolver or template cannot silently regress it.
    expect(stmt.Condition.StringEquals["aws:SourceArn"]).toBe(
      TEST_DISTRIBUTION_ARN,
    );
    // CloudFront distribution ARN shape: arn:aws:cloudfront::<account>:distribution/<id>
    expect(stmt.Condition.StringEquals["aws:SourceArn"]).toMatch(
      /^arn:aws:cloudfront::\d{12}:distribution\/[A-Z0-9]+$/,
    );
  });

  it("BucketPolicy Bucket field resolves to the raw bucket ARN (primary identifier for S3::BucketPolicy)", async () => {
    const cloned = cloneBucketPolicyOptions();
    const completed = buildCompletedResources();

    await resolveCompoundMarkers(cloned, {
      completedResources: completed,
      region: "us-east-1",
      currentResourceId: R.BUCKET_POLICY,
      azLookup: fakeAzLookup,
    });

    // The Bucket field is a bare markerRef — resolves to the full bucket
    // ARN. CCAPI for AWS::S3::BucketPolicy accepts the ARN form; the
    // primary identifier is documented as the bucket name but the resolver
    // emits the ARN (buildResourceArn normalises this) and CCAPI tolerates
    // both. Pin the current behaviour so any future change is intentional.
    expect(cloned["Bucket"]).toBe(TEST_BUCKET_ARN);
  });
});
