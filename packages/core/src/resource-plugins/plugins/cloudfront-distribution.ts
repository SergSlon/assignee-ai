import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

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
 * The plugin instead surfaces DistributionConfig as a raw JSON
 * string field with shape validation — users paste the JSON from
 * AWS docs or a known-good template. A future slice could add
 * a "quick SPA" preset wizard that asks for { S3Origin, AliasDomain,
 * AcmCertArn } and synthesizes a minimal DistributionConfig, but
 * that's deferred pending user demand.
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
export const cloudFrontDistributionPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  commonFields: [
    {
      name: "DistributionConfig",
      required: true,
      question: {
        type: "string",
        label: "Distribution config (JSON)",
        placeholder:
          '{"CallerReference":"my-dist","Enabled":true,"Origins":{"Quantity":1,"Items":[...]},"DefaultCacheBehavior":{...}}',
        hint: "Required. Nested JSON object mirroring the CloudFormation schema. Minimum fields: CallerReference, Enabled, Origins (with at least one Item), DefaultCacheBehavior. Paste from AWS docs or a known-good template. The static-website compound pattern (`assignee patterns show static-website`) produces a reference config for the SPA/S3-origin case.",
        validate: (value: unknown) => {
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
          const required = [
            "CallerReference",
            "Enabled",
            "Origins",
            "DefaultCacheBehavior",
          ];
          const missing = required.filter((k) => !(k in parsed));
          if (missing.length > 0)
            return `DistributionConfig is missing required fields: ${missing.join(", ")}`;
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer || (typeof answer === "string" && !answer.trim()))
          return undefined;
        try {
          return JSON.parse(String(answer));
        } catch {
          return undefined;
        }
      },
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
    "Create / Update / Delete operations take 5-60 MINUTES to propagate through the global edge network. Apply runs against CloudFront will be noticeably slower than other resource types — this is a CloudFront limitation, not an assignee bug.",
    "DistributionConfig is createOnly-free per the CCAPI schema, but updating Origins or ViewerCertificate in practice triggers a full re-deployment that holds the distribution in 'InProgress' state for the full propagation window. Batch updates to minimize re-deployment cost.",
    "For SPA / static-site CloudFronts, use the static-website compound pattern instead (`assignee patterns show static-website`). It provisions S3 + OAC + Distribution + the correct ViewerProtocolPolicy=redirect-to-https default in one intent.",
    "Set DefaultCacheBehavior.ViewerProtocolPolicy to 'redirect-to-https' — never 'allow-all' or 'https-only' alone. redirect-to-https handles both HTTP clients (redirected) and HTTPS clients (served directly) with one config.",
    "For custom-domain CloudFronts (Aliases), the ACM certificate MUST be in us-east-1 — CloudFront is a global service but its ACM lookup is regional and pinned to us-east-1. A cert in any other region will be silently rejected.",
    "CloudFront invalidations are included for the first 1000 paths per account per month; additional paths bill at a per-path rate (run `assignee cost` for live Pricing-MCP rates). Aggressive automated invalidations on every deploy can turn into a real cost — prefer cache-busting filenames.",
    "Distribution destroy requires the Enabled flag to be set to false first, then a propagation wait, then delete. The CCAPI delete handler does NOT auto-disable — users must either pre-disable via a separate update, or use the bulk-destroy strategy which handles the two-step flow.",
  ],
};
