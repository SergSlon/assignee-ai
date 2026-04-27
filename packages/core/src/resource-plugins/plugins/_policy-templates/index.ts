/**
 * Policy-template registry for wizard preset materialization.
 *
 * Each preset is a small TS module that exports a builder function
 * returning the canonical CloudFormation/IAM JSON shape with sensible
 * defaults. Plugins import from here to (a) populate `initialValue`
 * on a preset-specific field variant via `showIf`, and (b) feed
 * preset-aware wizard tests.
 *
 * Adding a new preset = drop a new module here + register it in this
 * barrel + thread it into the owning plugin's `Preset` enum.
 *
 * @see MASTER-011 (B-03) — preset wizards replacing raw-JSON paste UX.
 */

export {
  buildSpaWebsiteDistributionConfig,
  SPA_ORIGIN_PLACEHOLDER,
  SPA_ORIGIN_ID,
} from "./cloudfront-distribution-spa-website.js";
export {
  buildStaticSiteDistributionConfig,
  STATIC_ORIGIN_PLACEHOLDER,
  STATIC_ORIGIN_ID,
} from "./cloudfront-distribution-static-site.js";
export {
  buildApiPassthroughDistributionConfig,
  API_ORIGIN_PLACEHOLDER,
  API_ORIGIN_ID,
} from "./cloudfront-distribution-api-passthrough.js";

export {
  buildCloudFrontOacReadPolicy,
  BUCKET_NAME_PLACEHOLDER as OAC_READ_BUCKET_PLACEHOLDER,
  DISTRIBUTION_ARN_PLACEHOLDER,
} from "./s3-bucket-policy-cloudfront-oac-read.js";
export {
  buildTlsOnlyPolicy,
  BUCKET_NAME_PLACEHOLDER as TLS_ONLY_BUCKET_PLACEHOLDER,
} from "./s3-bucket-policy-tls-only.js";
export {
  buildCrossAccountDecryptPolicy,
  BUCKET_NAME_PLACEHOLDER as CROSS_ACCOUNT_BUCKET_PLACEHOLDER,
  CROSS_ACCOUNT_ARN_PLACEHOLDER,
} from "./s3-bucket-policy-cross-account-decrypt.js";
export {
  buildPublicReadPolicy,
  BUCKET_NAME_PLACEHOLDER as PUBLIC_READ_BUCKET_PLACEHOLDER,
  ALLOWED_CIDR_PLACEHOLDER,
} from "./s3-bucket-policy-public-read.js";

/** CloudFront-Distribution preset enum. `custom-json` falls through to free-text JSON paste. */
export const DISTRIBUTION_PRESETS = {
  SPA_WEBSITE: "spa-website",
  STATIC_SITE: "static-site",
  API_PASSTHROUGH: "api-passthrough",
  CUSTOM_JSON: "custom-json",
} as const;

export type DistributionPreset =
  (typeof DISTRIBUTION_PRESETS)[keyof typeof DISTRIBUTION_PRESETS];

/** S3-BucketPolicy preset enum. `custom-json` falls through to free-text JSON paste. */
export const BUCKET_POLICY_PRESETS = {
  CLOUDFRONT_OAC_READ: "cloudfront-oac-read",
  TLS_ONLY: "tls-only",
  CROSS_ACCOUNT_DECRYPT: "cross-account-decrypt",
  PUBLIC_READ: "public-read",
  CUSTOM_JSON: "custom-json",
} as const;

export type BucketPolicyPreset =
  (typeof BUCKET_POLICY_PRESETS)[keyof typeof BUCKET_POLICY_PRESETS];
