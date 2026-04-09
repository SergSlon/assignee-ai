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
export const cloudFrontOriginAccessControlPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
  commonFields: [
    {
      name: "OriginAccessControlConfig",
      required: true,
      question: {
        type: "string",
        label: "Origin access control config (JSON)",
        placeholder:
          '{"Name":"my-s3-oac","SigningProtocol":"sigv4","SigningBehavior":"always","OriginAccessControlOriginType":"s3"}',
        hint: "Required. JSON object with Name, SigningProtocol (sigv4), SigningBehavior (always/no-override/never), and OriginAccessControlOriginType (s3/mediastore/mediapackagev2/lambda). The static-website compound pattern produces a reference config automatically; standalone users paste from AWS docs.",
        validate: (value: unknown) => {
          if (!value) return "OriginAccessControlConfig is required";
          const s = String(value).trim();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(s) as Record<string, unknown>;
          } catch {
            return "OriginAccessControlConfig must be valid JSON";
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
          if (parsed["SigningProtocol"] !== "sigv4")
            return "SigningProtocol must be 'sigv4' (AWS's only supported value as of 2026)";
          const behaviors = ["always", "no-override", "never"];
          if (!behaviors.includes(String(parsed["SigningBehavior"])))
            return `SigningBehavior must be one of: ${behaviors.join(", ")}`;
          const originTypes = ["s3", "mediastore", "mediapackagev2", "lambda"];
          if (
            !originTypes.includes(
              String(parsed["OriginAccessControlOriginType"]),
            )
          )
            return `OriginAccessControlOriginType must be one of: ${originTypes.join(", ")}`;
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
  ],
  advancedFields: [],
  defaults: {},
  configHints: [
    "NEVER include Tags — AWS::CloudFront::OriginAccessControl is not taggable (CCAPI schema reports tagging.taggable=false). Omit Tags entirely.",
    "SigningBehavior=always is the safe default for private S3 buckets. 'no-override' preserves pre-signed URLs from the origin; 'never' disables signing (defeats the point of OAC).",
    "For S3 origins, the bucket policy MUST grant read access to the CloudFront service principal with a aws:SourceArn condition pinned to the distribution ARN. The static-website compound pattern does this automatically via a co-created AWS::S3::BucketPolicy resource.",
    "OAC replaces the legacy Origin Access Identity (OAI). New distributions should always use OAC; OAI is supported for backward compatibility but carries security caveats (shared signing key across all distributions).",
  ],
};
