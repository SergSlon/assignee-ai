import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::S3::BucketPolicy.
 *
 * A BucketPolicy is an IAM-style resource policy attached to a
 * specific S3 bucket. There is exactly one BucketPolicy per bucket
 * — the policy IS the bucket's `PolicyDocument` attribute, modeled
 * by CloudFormation as a separate resource so it can be referenced
 * and updated independently of the AWS::S3::Bucket resource.
 *
 * CCAPI schema (verified 2026-04-09):
 *   - primaryIdentifier: /properties/Bucket
 *   - required: [Bucket, PolicyDocument]
 *   - createOnly: [Bucket] — changing the bucket replaces the
 *     policy (CFN conceptually drops-and-recreates since there
 *     is only ever one policy per bucket)
 *   - tagging.taggable = false (omit Tags — added to NO_TAG_TYPES
 *     in apps/cli/src/utils/tags.ts)
 *   - handlers: create, read, update, delete, list (all present)
 *
 * Use cases:
 *   1. Grant a CloudFront distribution (via OAC) read access scoped
 *      to aws:SourceArn. The static-website compound wires this
 *      automatically.
 *   2. Grant cross-account access to a specific IAM principal.
 *   3. Enforce TLS-only / encrypted-only access via Condition blocks.
 *
 * Pricing: free (no direct charge — the bucket itself is billed).
 * Registered in the free pricing decomposer.
 *
 * Policy document sizing: AWS caps bucket policies at 20 KB. The
 * plugin validates shape (JSON object with Version + Statement array)
 * but does not pre-check the byte count — CCAPI will reject oversized
 * policies with a clear error at apply time.
 *
 * @see (f) 2026-04-09 Task 4b — promoted to unblock static-website
 *      compound migration off the SDK PutBucketPolicy post-provision
 *      path in result-formatter.ts
 */
export const s3BucketPolicyPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.S3_BUCKET_POLICY,
  commonFields: [
    {
      name: "Bucket",
      required: true,
      question: {
        type: "string",
        label: "Bucket name",
        placeholder: "my-static-site-bucket",
        hint: "Required + createOnly. Name of the S3 bucket this policy attaches to. In compound patterns use a markerRef() to the bucket's logical id so the compound resolver substitutes the real name at apply time. Changing this value replaces the policy.",
        validate: (value: unknown) => {
          if (!value) return "Bucket is required";
          const s = String(value).trim();
          if (s.length === 0) return "Bucket cannot be empty";
          // Compound-pattern marker tokens pass through as-is; the
          // resolver substitutes them before the CCAPI call. Only
          // validate the final flat-string shape for non-marker
          // values to avoid double-rejecting unresolved patterns.
          if (s.startsWith("__ASSIGNEE_")) return undefined;
          // S3 bucket naming rules — lowercase, 3-63 chars, no
          // underscore, no double dots, no IP shape. We do the cheap
          // checks here; CCAPI does the full validation.
          if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s))
            return "Bucket name must be 3-63 chars, lowercase, alphanumeric + dot + hyphen";
          return undefined;
        },
      },
    },
    {
      name: "PolicyDocument",
      required: true,
      question: {
        type: "string",
        label: "Policy document (JSON)",
        placeholder:
          '{"Version":"2012-10-17","Statement":[{"Sid":"AllowCloudFrontRead","Effect":"Allow",...}]}',
        hint: "Required. IAM policy document as a JSON object. Must have Version=2012-10-17 and a Statement array. The static-website compound produces a reference CloudFront-OAC policy automatically; standalone users hand-craft it or paste from AWS docs.",
        validate: (value: unknown) => {
          if (!value) return "PolicyDocument is required";
          const s = String(value).trim();
          let parsed: unknown;
          try {
            parsed = JSON.parse(s);
          } catch {
            return "PolicyDocument must be valid JSON";
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return "PolicyDocument must be a JSON object";
          const obj = parsed as Record<string, unknown>;
          if (obj["Version"] !== "2012-10-17")
            return 'PolicyDocument.Version must be "2012-10-17"';
          if (!Array.isArray(obj["Statement"]))
            return "PolicyDocument.Statement must be an array";
          if ((obj["Statement"] as unknown[]).length === 0)
            return "PolicyDocument.Statement must contain at least one statement";
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer) return undefined;
        if (typeof answer === "object") return answer;
        if (typeof answer === "string" && answer.trim()) {
          try {
            return JSON.parse(answer);
          } catch {
            return undefined;
          }
        }
        return undefined;
      },
    },
  ],
  advancedFields: [],
  defaults: {},
  configHints: [
    "NEVER include Tags — AWS::S3::BucketPolicy is not taggable (CCAPI schema reports tagging.taggable=false). Omit Tags entirely.",
    "There is exactly one BucketPolicy per bucket — the policy IS the bucket's PolicyDocument attribute. Declaring two BucketPolicy resources for the same Bucket is a provisioning error.",
    'For CloudFront OAC read grants, the policy\'s Principal must be {"Service": "cloudfront.amazonaws.com"} with a Condition block pinning aws:SourceArn to the specific distribution ARN — otherwise any CloudFront distribution in any account can read the bucket.',
    "Bucket policies cap at 20 KB. For larger permission surfaces, split into multiple IAM identity-based policies on the consumer principals instead.",
    "Bucket is createOnly — CloudFormation replaces the policy if you change the Bucket field. To move a policy between buckets, delete the old resource first.",
  ],
};
