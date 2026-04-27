import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::CloudFront::OriginAccessControl.
 *
 * OriginAccessControl (OAC) is CloudFront's modern replacement for
 * Origin Access Identity (OAI). It signs S3 GetObject requests with
 * SigV4 so that a private S3 bucket can be read only by a specific
 * CloudFront distribution — closing the "public bucket" hole that
 * older static-website setups lived with.
 *
 * CCAPI schema (verified 2026-04-09):
 *   - primaryIdentifier: /properties/Id (auto-generated, readOnly)
 *   - required: [OriginAccessControlConfig]
 *   - createOnly: (none — Name, Description, and the signing/origin
 *     fields are all updatable post-create)
 *   - tagging.taggable = false (added to NO_TAG_TYPES in
 *     apps/cli/src/utils/tags.ts so injectMandatoryTags skips it)
 *   - handlers: create, read, update, delete, list (all present)
 *
 * OriginAccessControlConfig shape (required sub-fields):
 *   - Name                            (display name)
 *   - SigningProtocol                 (sigv4)
 *   - SigningBehavior                 (always | no-override | never)
 *   - OriginAccessControlOriginType   (s3 | mediastore | mediapackagev2 | lambda)
 *   - Description                     (optional)
 *
 * Wizard UX (MASTER-011 part B, 2026-04-26):
 * the OAC shape is small + fully enumerable. Instead of asking the
 * user to paste raw JSON the wizard asks for an `OriginType` enum
 * up front and pre-fills the `OriginAccessControlConfig` field with
 * a working JSON template (one variant per OriginType, selected via
 * `showIf` on the OriginType answer). The user can hit Enter to
 * accept the canonical SigV4 / SigningBehavior=always / placeholder-
 * Name baseline or tweak the JSON in place. Net result: zero raw-
 * paste friction for the 95% case (private S3 origin) while the
 * raw-JSON path remains available for advanced users via the
 * `custom-json` OriginType option.
 *
 * Pricing: free. OAC itself has no meter; the signing work is done
 * on the CloudFront edge nodes whose cost is already captured by the
 * parent distribution's per-request pricing. Registered in the free
 * pricing decomposer.
 *
 * Intended consumer: the static-website compound pattern, which
 * creates OAC → CloudFront Distribution → S3 BucketPolicy in one
 * apply pass. Standalone use is possible but rare — most users reach
 * OAC through the compound.
 *
 * @see (f) 2026-04-09 Task 4b — migrated static-website off
 *      cloudfront-setup.ts SDK post-provision path
 */

const OAC_ORIGIN_TYPES = [
  "s3",
  "mediastore",
  "mediapackagev2",
  "lambda",
] as const;
const OAC_SIGNING_BEHAVIORS = ["always", "no-override", "never"] as const;
const OAC_SIGNING_PROTOCOLS = ["sigv4"] as const;

/**
 * OAC preset enum — selects which `OriginAccessControlConfig` template
 * is materialized into the wizard prefill. `custom-json` falls through
 * to the original raw-paste behaviour.
 */
const OAC_PRESETS = {
  S3: "s3",
  MEDIASTORE: "mediastore",
  MEDIAPACKAGEV2: "mediapackagev2",
  LAMBDA: "lambda",
  CUSTOM_JSON: "custom-json",
} as const;

/** Pretty-printed JSON template for one OriginType — used as wizard `initialValue`. */
function buildTemplate(originType: string): string {
  return JSON.stringify(
    {
      Name: "assignee-oac",
      Description: "assignee.ai-managed origin access control",
      SigningProtocol: "sigv4",
      SigningBehavior: "always",
      OriginAccessControlOriginType: originType,
    },
    null,
    2,
  );
}

const S3_TEMPLATE_JSON = buildTemplate("s3");
const MEDIASTORE_TEMPLATE_JSON = buildTemplate("mediastore");
const MEDIAPACKAGEV2_TEMPLATE_JSON = buildTemplate("mediapackagev2");
const LAMBDA_TEMPLATE_JSON = buildTemplate("lambda");

/**
 * Validate the OAC config shape. Accepts both pre-resolved objects
 * (compound pre-fills) and JSON-string inputs.
 */
function validateOacConfig(value: unknown): string | undefined {
  if (!value) return "OriginAccessControlConfig is required";
  let parsed: Record<string, unknown>;
  if (typeof value === "object" && !Array.isArray(value)) {
    parsed = value as Record<string, unknown>;
  } else {
    const s = String(value).trim();
    try {
      parsed = JSON.parse(s) as Record<string, unknown>;
    } catch {
      return "OriginAccessControlConfig must be valid JSON";
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return "OriginAccessControlConfig must be a JSON object";
  const required = [
    "Name",
    "SigningProtocol",
    "SigningBehavior",
    "OriginAccessControlOriginType",
  ];
  const missing = required.filter((k) => !(k in parsed));
  if (missing.length > 0)
    return `OriginAccessControlConfig missing required fields: ${missing.join(", ")}`;
  if (
    !OAC_SIGNING_PROTOCOLS.includes(
      String(
        parsed["SigningProtocol"],
      ) as (typeof OAC_SIGNING_PROTOCOLS)[number],
    )
  )
    return "SigningProtocol must be 'sigv4' (AWS's only supported value as of 2026)";
  if (
    !OAC_SIGNING_BEHAVIORS.includes(
      String(
        parsed["SigningBehavior"],
      ) as (typeof OAC_SIGNING_BEHAVIORS)[number],
    )
  )
    return `SigningBehavior must be one of: ${OAC_SIGNING_BEHAVIORS.join(", ")}`;
  if (
    !OAC_ORIGIN_TYPES.includes(
      String(
        parsed["OriginAccessControlOriginType"],
      ) as (typeof OAC_ORIGIN_TYPES)[number],
    )
  )
    return `OriginAccessControlOriginType must be one of: ${OAC_ORIGIN_TYPES.join(", ")}`;
  return undefined;
}

function oacConfigToCfn(answer: unknown): unknown {
  if (!answer) return undefined;
  if (typeof answer === "object" && !Array.isArray(answer)) return answer;
  const s = String(answer).trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export const cloudFrontOriginAccessControlPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
  commonFields: [
    {
      name: "OriginType",
      required: true,
      question: {
        type: "enum",
        label: "Origin type (template selector)",
        options: [
          {
            value: OAC_PRESETS.S3,
            label: "s3 — private S3 bucket origin (most common)",
          },
          {
            value: OAC_PRESETS.MEDIASTORE,
            label: "mediastore — Elemental MediaStore container",
          },
          {
            value: OAC_PRESETS.MEDIAPACKAGEV2,
            label: "mediapackagev2 — Elemental MediaPackage v2 channel",
          },
          {
            value: OAC_PRESETS.LAMBDA,
            label: "lambda — Lambda function URL origin",
          },
          {
            value: OAC_PRESETS.CUSTOM_JSON,
            label: "custom-json — paste raw OriginAccessControlConfig",
          },
        ],
        initialValue: OAC_PRESETS.S3,
        hint: "Pick the AWS service that backs this CloudFront origin. Selecting an origin type pre-fills the OriginAccessControlConfig JSON with a SigV4 / SigningBehavior=always baseline you can hit Enter to accept; custom-json drops you into raw-paste mode for advanced shapes.",
      },
      // Wizard-only field — strip from CFN output (the OAC config below
      // is what CloudFormation actually consumes).
      toCfn: () => undefined,
    },
    {
      name: "OriginAccessControlConfig",
      required: true,
      question: {
        type: "string",
        label: "Origin access control config (s3, editable)",
        placeholder: S3_TEMPLATE_JSON,
        initialValue: S3_TEMPLATE_JSON,
        hint: "Pre-filled S3 OAC template. Edit Name (must be unique within your account) or Description if desired; SigningProtocol/SigningBehavior/OriginAccessControlOriginType already match BP-OAC-001 (signed always with SigV4 against an S3 origin).",
        showIf: { field: "OriginType", value: OAC_PRESETS.S3 },
        validate: validateOacConfig,
      },
      toCfn: oacConfigToCfn,
    },
    {
      name: "OriginAccessControlConfig",
      required: true,
      question: {
        type: "string",
        label: "Origin access control config (mediastore, editable)",
        placeholder: MEDIASTORE_TEMPLATE_JSON,
        initialValue: MEDIASTORE_TEMPLATE_JSON,
        hint: "Pre-filled MediaStore OAC template. Edit Name / Description as needed.",
        showIf: { field: "OriginType", value: OAC_PRESETS.MEDIASTORE },
        validate: validateOacConfig,
      },
      toCfn: oacConfigToCfn,
    },
    {
      name: "OriginAccessControlConfig",
      required: true,
      question: {
        type: "string",
        label: "Origin access control config (mediapackagev2, editable)",
        placeholder: MEDIAPACKAGEV2_TEMPLATE_JSON,
        initialValue: MEDIAPACKAGEV2_TEMPLATE_JSON,
        hint: "Pre-filled MediaPackage v2 OAC template. Edit Name / Description as needed.",
        showIf: { field: "OriginType", value: OAC_PRESETS.MEDIAPACKAGEV2 },
        validate: validateOacConfig,
      },
      toCfn: oacConfigToCfn,
    },
    {
      name: "OriginAccessControlConfig",
      required: true,
      question: {
        type: "string",
        label: "Origin access control config (lambda, editable)",
        placeholder: LAMBDA_TEMPLATE_JSON,
        initialValue: LAMBDA_TEMPLATE_JSON,
        hint: "Pre-filled Lambda function-URL OAC template. Edit Name / Description as needed.",
        showIf: { field: "OriginType", value: OAC_PRESETS.LAMBDA },
        validate: validateOacConfig,
      },
      toCfn: oacConfigToCfn,
    },
    {
      name: "OriginAccessControlConfig",
      required: true,
      question: {
        type: "string",
        label: "Origin access control config (JSON)",
        placeholder:
          '{"Name":"my-s3-oac","SigningProtocol":"sigv4","SigningBehavior":"always","OriginAccessControlOriginType":"s3"}',
        hint: "Required. JSON object with Name, SigningProtocol (sigv4), SigningBehavior (always/no-override/never), and OriginAccessControlOriginType (s3/mediastore/mediapackagev2/lambda). Paste from AWS docs or use one of the preset templates above.",
        showIf: { field: "OriginType", value: OAC_PRESETS.CUSTOM_JSON },
        validate: validateOacConfig,
      },
      toCfn: oacConfigToCfn,
    },
  ],
  advancedFields: [],
  defaults: {
    // (f) 2026-04-09 Task 9: ship a fully-safe default
    // OriginAccessControlConfig so a user who accepts every wizard
    // prompt with Enter still produces a secure OAC that passes
    // BP-OAC-001 (SigningBehavior=always). The static-website
    // compound overrides this with its own branded values; standalone
    // wizard users get a generic safe fallback.
    OriginAccessControlConfig: {
      Name: "assignee-oac",
      Description: "assignee.ai-managed origin access control",
      SigningProtocol: "sigv4",
      SigningBehavior: "always",
      OriginAccessControlOriginType: "s3",
    },
  },
  configHints: [
    "NEVER include Tags — AWS::CloudFront::OriginAccessControl is not taggable (CCAPI schema reports tagging.taggable=false). Omit Tags entirely.",
    "SigningBehavior=always is the safe default for private S3 buckets. 'no-override' preserves pre-signed URLs from the origin; 'never' disables signing (defeats the point of OAC).",
    "For S3 origins, the bucket policy MUST grant read access to the CloudFront service principal with a aws:SourceArn condition pinned to the distribution ARN. The static-website compound pattern does this automatically via a co-created AWS::S3::BucketPolicy resource.",
    "OAC replaces the legacy Origin Access Identity (OAI). New distributions should always use OAC; OAI is supported for backward compatibility but carries security caveats (shared signing key across all distributions).",
    "OriginAccessControlOriginType MUST match the actual origin type — 's3' for S3 buckets, 'mediastore'/'mediapackagev2' for media services, 'lambda' for function-URL origins. CloudFront rejects mismatches at create time.",
  ],
};
