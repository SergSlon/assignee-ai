import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";
import {
  DISTRIBUTION_PRESETS,
  buildSpaWebsiteDistributionConfig,
  buildStaticSiteDistributionConfig,
  buildApiPassthroughDistributionConfig,
} from "./_policy-templates/index.js";

/**
 * ResourcePlugin for AWS::CloudFront::Distribution.
 *
 * A standalone CloudFront distribution. The static-website compound
 * pattern provisions its CloudFront via a post-provision SDK path
 * (provisionable: false) — this plugin gives users the alternative
 * route of provisioning a distribution directly via CCAPI for
 * non-compound use cases (CDN in front of an existing S3 bucket,
 * API Gateway REST API, or custom HTTP origin).
 *
 * CCAPI schema (verified 2026-04-09 via cloudformation:DescribeType):
 *   - primaryIdentifier: /properties/Id (auto-generated, readOnly)
 *   - readOnly: /properties/Id, /properties/DomainName
 *   - required: [DistributionConfig]
 *   - createOnly: (none — even the origin + alias set can be updated)
 *   - tagging.taggable = true
 *   - handlers: create, read, update, delete, list (all present)
 *
 * DistributionConfig is a deeply-nested object with ~300 leaf fields
 * across Origins, CacheBehaviors, DefaultCacheBehavior,
 * ViewerCertificate, Restrictions, CustomErrorResponses, Logging,
 * and Aliases. Modeling it as conditional showIf fields would
 * require ~30 nested form widgets that nobody would actually use.
 *
 * Wizard UX (MASTER-011 part A, 2026-04-26):
 * a `Preset` enum field is asked first. The non-`custom-json`
 * presets pre-fill `DistributionConfig` with a working JSON template
 * (spa-website / static-site / api-passthrough) that the user can
 * accept or tweak. The `custom-json` preset preserves the original
 * raw-paste behaviour. Each preset has its own `DistributionConfig`
 * field instance, disambiguated via the showIf mechanism in
 * `cfn-emitter.applyToCfnTransforms`.
 *
 * Propagation: CloudFront create / update / delete operations take
 * 5-60 minutes to propagate through the global edge network. The
 * CCAPI poll path handles the async wait, but users should expect
 * apply runs to take noticeably longer than other resource types.
 *
 * Pricing: CloudFront bills on (a) data transfer out to the public
 * internet (tiered per-GB rates by geography), (b) HTTPS requests
 * (per-10k-requests rate), (c) cache invalidation requests (first
 * 1000 paths per month at no extra charge, per-path rate thereafter),
 * (d) optional Field-Level Encryption and Real-Time Logs add-ons.
 * All usage-dependent — run `assignee cost` for live Pricing-MCP
 * rates. No dollar amounts are hardcoded in this plugin (see
 * `feedback_no_hardcoded_prices`).
 *
 * @see A14 (2026-04-09)
 */

const DISTRIBUTION_REQUIRED_FIELDS = [
  "CallerReference",
  "Enabled",
  "Origins",
  "DefaultCacheBehavior",
] as const;

/**
 * Shared validate function — every DistributionConfig field instance
 * (one per preset) reuses this. Extracted to keep the four field
 * declarations short and DRY.
 */
function validateDistributionConfigJson(value: unknown): string | undefined {
  if (!value) return "DistributionConfig is required";
  const s = String(value).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return "DistributionConfig must be valid JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return "DistributionConfig must be a JSON object";
  // Minimum-viable field check: at minimum the config needs
  // CallerReference + Enabled + Origins + DefaultCacheBehavior
  // or CCAPI will reject it immediately.
  const missing = DISTRIBUTION_REQUIRED_FIELDS.filter((k) => !(k in parsed));
  if (missing.length > 0)
    return `DistributionConfig is missing required fields: ${missing.join(", ")}`;
  return undefined;
}

function distributionConfigToCfn(answer: unknown): unknown {
  if (!answer || (typeof answer === "string" && !answer.trim()))
    return undefined;
  if (typeof answer === "object") return answer;
  try {
    return JSON.parse(String(answer));
  } catch {
    return undefined;
  }
}

/** Pretty-printed JSON used as the editable wizard prefill for each preset. */
const SPA_TEMPLATE_JSON = JSON.stringify(
  buildSpaWebsiteDistributionConfig(),
  null,
  2,
);
const STATIC_TEMPLATE_JSON = JSON.stringify(
  buildStaticSiteDistributionConfig(),
  null,
  2,
);
const API_TEMPLATE_JSON = JSON.stringify(
  buildApiPassthroughDistributionConfig(),
  null,
  2,
);

export const cloudFrontDistributionPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  commonFields: [
    {
      name: "Preset",
      required: true,
      question: {
        type: "enum",
        label: "Distribution preset",
        options: [
          {
            value: DISTRIBUTION_PRESETS.SPA_WEBSITE,
            label:
              "spa-website — single-page app (React/Vue/Angular) on S3 with /index.html fallback",
          },
          {
            value: DISTRIBUTION_PRESETS.STATIC_SITE,
            label:
              "static-site — multi-page static HTML (Hugo/Jekyll/Eleventy) on S3",
          },
          {
            value: DISTRIBUTION_PRESETS.API_PASSTHROUGH,
            label:
              "api-passthrough — proxy in front of an HTTP API (ALB / API Gateway), cache disabled",
          },
          {
            value: DISTRIBUTION_PRESETS.CUSTOM_JSON,
            label:
              "custom-json — paste a raw DistributionConfig (advanced / migrate from existing template)",
          },
        ],
        initialValue: DISTRIBUTION_PRESETS.SPA_WEBSITE,
        hint: "Pick a starting template. Non-custom presets pre-fill DistributionConfig with a working baseline you can tweak; custom-json drops you into raw-JSON paste mode for full control. Run `assignee plan --help` for the full apply flow.",
      },
      // Preset is a wizard-only field — strip it from the CFN output.
      toCfn: () => undefined,
    },
    {
      name: "DistributionConfig",
      required: true,
      question: {
        type: "string",
        label: "Distribution config (SPA preset, editable)",
        placeholder: SPA_TEMPLATE_JSON,
        initialValue: SPA_TEMPLATE_JSON,
        hint: "Pre-filled SPA-website template. Replace REPLACE_WITH_BUCKET in the Origin DomainName with your S3 bucket DNS name (e.g. my-spa.s3.us-east-1.amazonaws.com), tweak cache TTLs / aliases as needed, then accept. The CallerReference is a free-form idempotency token — change it if you re-create.",
        showIf: { field: "Preset", value: DISTRIBUTION_PRESETS.SPA_WEBSITE },
        validate: validateDistributionConfigJson,
      },
      toCfn: distributionConfigToCfn,
    },
    {
      name: "DistributionConfig",
      required: true,
      question: {
        type: "string",
        label: "Distribution config (static-site preset, editable)",
        placeholder: STATIC_TEMPLATE_JSON,
        initialValue: STATIC_TEMPLATE_JSON,
        hint: "Pre-filled static-site template (multi-page, no SPA fallback). Replace REPLACE_WITH_BUCKET with your S3 bucket DNS name and tweak DefaultTTL / aliases as needed.",
        showIf: { field: "Preset", value: DISTRIBUTION_PRESETS.STATIC_SITE },
        validate: validateDistributionConfigJson,
      },
      toCfn: distributionConfigToCfn,
    },
    {
      name: "DistributionConfig",
      required: true,
      question: {
        type: "string",
        label: "Distribution config (api-passthrough preset, editable)",
        placeholder: API_TEMPLATE_JSON,
        initialValue: API_TEMPLATE_JSON,
        hint: "Pre-filled API-passthrough template. Replace REPLACE_WITH_API in the Origin DomainName with your ALB / API Gateway custom domain. Cache is disabled (DefaultTTL=0) — CloudFront still gives you TLS + global edge + DDoS protection.",
        showIf: {
          field: "Preset",
          value: DISTRIBUTION_PRESETS.API_PASSTHROUGH,
        },
        validate: validateDistributionConfigJson,
      },
      toCfn: distributionConfigToCfn,
    },
    {
      name: "DistributionConfig",
      required: true,
      question: {
        type: "string",
        label: "Distribution config (JSON)",
        placeholder:
          '{"CallerReference":"my-dist","Enabled":true,"Origins":{"Quantity":1,"Items":[...]},"DefaultCacheBehavior":{...}}',
        hint: "Required. Nested JSON object mirroring the CloudFormation schema. Minimum fields: CallerReference, Enabled, Origins (with at least one Item), DefaultCacheBehavior. Paste from AWS docs or a known-good template.",
        showIf: { field: "Preset", value: DISTRIBUTION_PRESETS.CUSTOM_JSON },
        validate: validateDistributionConfigJson,
      },
      toCfn: distributionConfigToCfn,
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:platform",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const items = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        // CloudFormation CloudFront::Distribution wraps Tags in
        // { Items: [...] }, not a flat array like most services.
        return items.length > 0 ? { Items: items } : undefined;
      },
    },
  ],
  advancedFields: [],
  defaults: {},
  configHints: [
    "DistributionConfig.Origins, DistributionConfig.CacheBehaviors, and DistributionConfig.CustomErrorResponses MUST use the wrapped {Items: [...], Quantity: N} shape — never a bare array. Quantity MUST equal Items.length.",
    "Each Origin MUST include EXACTLY ONE of S3OriginConfig or CustomOriginConfig — never both. Use S3OriginConfig when DomainName ends with '.s3.<region>.amazonaws.com' (or '.s3.amazonaws.com'); use CustomOriginConfig for every other origin (ALB, API Gateway, custom HTTP endpoint, etc).",
    "S3OriginConfig.OriginAccessIdentity MUST be either a real origin-access-identity ID (format 'origin-access-identity/cloudfront/<ID>') or omitted entirely. Never emit an empty string ''.",
    "Create / Update / Delete operations take 5-60 MINUTES to propagate through the global edge network. Apply runs against CloudFront will be noticeably slower than other resource types — this is a CloudFront limitation, not an assignee bug.",
    "DistributionConfig is createOnly-free per the CCAPI schema, but updating Origins or ViewerCertificate in practice triggers a full re-deployment that holds the distribution in 'InProgress' state for the full propagation window. Batch updates to minimize re-deployment cost.",
    "For SPA / static-site CloudFronts, prefer the static-website compound pattern OR the wizard's spa-website / static-site presets. Both produce S3 + OAC + Distribution + the correct ViewerProtocolPolicy=redirect-to-https default; the compound pattern wires the resources together automatically while the preset gives you an editable JSON starting point. Run `assignee plan --help` for the apply flow.",
    "Set DefaultCacheBehavior.ViewerProtocolPolicy to 'redirect-to-https' — never 'allow-all' or 'https-only' alone. redirect-to-https handles both HTTP clients (redirected) and HTTPS clients (served directly) with one config.",
    "For custom-domain CloudFronts (Aliases), the ACM certificate MUST be in us-east-1 — CloudFront is a global service but its ACM lookup is regional and pinned to us-east-1. A cert in any other region will be silently rejected.",
    "CloudFront invalidations are included for the first 1000 paths per account per month; additional paths bill at a per-path rate (run `assignee cost` for live Pricing-MCP rates). Aggressive automated invalidations on every deploy can turn into a real cost — prefer cache-busting filenames.",
    "Distribution destroy requires the Enabled flag to be set to false first, then a propagation wait, then delete. The CCAPI delete handler does NOT auto-disable — users must either pre-disable via a separate update, or use the bulk-destroy strategy which handles the two-step flow.",
  ],
};
