import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";
import {
  BUCKET_POLICY_PRESETS,
  buildCloudFrontOacReadPolicy,
  buildTlsOnlyPolicy,
  buildCrossAccountDecryptPolicy,
  buildPublicReadPolicy,
} from "./_policy-templates/index.js";

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
 *   4. Public-read with IP allowlist (rare; CloudFront is usually
 *      better).
 *
 * Wizard UX (MASTER-011 part C, 2026-04-26):
 * a `PolicyTemplate` enum field is asked first. The non-`custom-json`
 * presets pre-fill `PolicyDocument` with a working JSON template
 * (cloudfront-oac-read / tls-only / cross-account-decrypt /
 * public-read) that the user can accept or tweak. The `custom-json`
 * preset preserves the original raw-paste behaviour for advanced
 * cases. Each preset has its own `PolicyDocument` field instance,
 * disambiguated via the `showIf` mechanism in
 * `cfn-emitter.applyToCfnTransforms`.
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

/**
 * Shared validate function — every PolicyDocument field instance
 * (one per preset) reuses this. Extracted to keep the field
 * declarations short and DRY.
 */
function validatePolicyDocument(value: unknown): string | undefined {
  if (!value) return "PolicyDocument is required";
  let parsed: unknown;
  if (typeof value === "object" && !Array.isArray(value)) {
    parsed = value;
  } else {
    const s = String(value).trim();
    try {
      parsed = JSON.parse(s);
    } catch {
      return "PolicyDocument must be valid JSON";
    }
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
}

function policyDocumentToCfn(answer: unknown): unknown {
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
}

/** Pretty-printed JSON used as the editable wizard prefill for each preset. */
const OAC_READ_TEMPLATE_JSON = JSON.stringify(
  buildCloudFrontOacReadPolicy(),
  null,
  2,
);
const TLS_ONLY_TEMPLATE_JSON = JSON.stringify(buildTlsOnlyPolicy(), null, 2);
const CROSS_ACCOUNT_TEMPLATE_JSON = JSON.stringify(
  buildCrossAccountDecryptPolicy(),
  null,
  2,
);
const PUBLIC_READ_TEMPLATE_JSON = JSON.stringify(
  buildPublicReadPolicy(),
  null,
  2,
);

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
      name: "PolicyTemplate",
      required: true,
      question: {
        type: "enum",
        label: "Policy template",
        options: [
          {
            value: BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
            label:
              "cloudfront-oac-read — grant a specific CloudFront distribution read access (most common)",
          },
          {
            value: BUCKET_POLICY_PRESETS.TLS_ONLY,
            label:
              "tls-only — deny all non-TLS access (security best-practice baseline)",
          },
          {
            value: BUCKET_POLICY_PRESETS.CROSS_ACCOUNT_DECRYPT,
            label:
              "cross-account-decrypt — grant a cross-account principal GetObject + ListBucket",
          },
          {
            value: BUCKET_POLICY_PRESETS.PUBLIC_READ,
            label:
              "public-read — anonymous GetObject scoped by IP allowlist (use sparingly)",
          },
          {
            value: BUCKET_POLICY_PRESETS.CUSTOM_JSON,
            label: "custom-json — paste a raw PolicyDocument (advanced)",
          },
        ],
        initialValue: BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
        hint: "Pick a starting template. Non-custom presets pre-fill PolicyDocument with a working baseline you can tweak (replacing REPLACE_WITH_BUCKET_NAME / REPLACE_WITH_DISTRIBUTION_ID / etc.); custom-json drops you into raw-JSON paste mode.",
      },
      // Wizard-only field — strip it from the CFN output (the policy
      // document below is what CloudFormation actually consumes).
      toCfn: () => undefined,
    },
    {
      name: "PolicyDocument",
      required: true,
      question: {
        type: "string",
        label: "Policy document (cloudfront-oac-read preset, editable)",
        placeholder: OAC_READ_TEMPLATE_JSON,
        initialValue: OAC_READ_TEMPLATE_JSON,
        hint: "Pre-filled CloudFront-OAC read policy. Replace REPLACE_WITH_BUCKET_NAME with your bucket name and REPLACE_WITH_DISTRIBUTION_ID / REPLACE_WITH_ACCOUNT_ID inside the AWS:SourceArn condition with your CloudFront distribution's ARN. The condition pin is mandatory — without it any CloudFront distribution in any account could read the bucket.",
        showIf: {
          field: "PolicyTemplate",
          value: BUCKET_POLICY_PRESETS.CLOUDFRONT_OAC_READ,
        },
        validate: validatePolicyDocument,
      },
      toCfn: policyDocumentToCfn,
    },
    {
      name: "PolicyDocument",
      required: true,
      question: {
        type: "string",
        label: "Policy document (tls-only preset, editable)",
        placeholder: TLS_ONLY_TEMPLATE_JSON,
        initialValue: TLS_ONLY_TEMPLATE_JSON,
        hint: "Pre-filled TLS-only deny policy (best-practice baseline). Replace REPLACE_WITH_BUCKET_NAME with your bucket name. Combine with another statement (additive Allow) if you also need to grant access — this template only denies non-TLS traffic.",
        showIf: {
          field: "PolicyTemplate",
          value: BUCKET_POLICY_PRESETS.TLS_ONLY,
        },
        validate: validatePolicyDocument,
      },
      toCfn: policyDocumentToCfn,
    },
    {
      name: "PolicyDocument",
      required: true,
      question: {
        type: "string",
        label: "Policy document (cross-account-decrypt preset, editable)",
        placeholder: CROSS_ACCOUNT_TEMPLATE_JSON,
        initialValue: CROSS_ACCOUNT_TEMPLATE_JSON,
        hint: "Pre-filled cross-account read policy. Replace REPLACE_WITH_BUCKET_NAME with your bucket name and REPLACE_WITH_OTHER_ACCOUNT_ID / REPLACE_WITH_ROLE_NAME inside the Principal.AWS ARN. If the bucket is encrypted with a customer-managed KMS key, the consumer ALSO needs kms:Decrypt on the key — granted on the KMS key resource policy, not here.",
        showIf: {
          field: "PolicyTemplate",
          value: BUCKET_POLICY_PRESETS.CROSS_ACCOUNT_DECRYPT,
        },
        validate: validatePolicyDocument,
      },
      toCfn: policyDocumentToCfn,
    },
    {
      name: "PolicyDocument",
      required: true,
      question: {
        type: "string",
        label: "Policy document (public-read preset, editable)",
        placeholder: PUBLIC_READ_TEMPLATE_JSON,
        initialValue: PUBLIC_READ_TEMPLATE_JSON,
        hint: "Pre-filled public-read policy with an IP allowlist Condition (defaulted to 0.0.0.0/0 — TIGHTEN THIS). Replace REPLACE_WITH_BUCKET_NAME and the aws:SourceIp CIDR. WARNING: most 'public website' cases should use cloudfront-oac-read with a private bucket fronted by CloudFront instead — public buckets are a common breach vector.",
        showIf: {
          field: "PolicyTemplate",
          value: BUCKET_POLICY_PRESETS.PUBLIC_READ,
        },
        validate: validatePolicyDocument,
      },
      toCfn: policyDocumentToCfn,
    },
    {
      name: "PolicyDocument",
      required: true,
      question: {
        type: "string",
        label: "Policy document (JSON)",
        placeholder:
          '{"Version":"2012-10-17","Statement":[{"Sid":"AllowCloudFrontRead","Effect":"Allow",...}]}',
        hint: "Required. IAM policy document as a JSON object. Must have Version=2012-10-17 and a Statement array. Hand-craft it or paste from AWS docs.",
        showIf: {
          field: "PolicyTemplate",
          value: BUCKET_POLICY_PRESETS.CUSTOM_JSON,
        },
        validate: validatePolicyDocument,
      },
      toCfn: policyDocumentToCfn,
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
