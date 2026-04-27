/**
 * CloudFront-Distribution preset: spa-website.
 *
 * Single-page-app (React/Vue/Angular build artifact) served from a
 * private S3 bucket. Default cache behaviour is HTML/JS friendly:
 * ViewerProtocolPolicy=redirect-to-https, GET+HEAD only, max-age=86400.
 *
 * Origin DomainName / OriginAccessIdentity are placeholders the user
 * is expected to replace before apply (or wire via a compound pattern
 * that uses markerRef substitution).
 *
 * @see MASTER-011 part A — replaces raw-JSON-paste UX.
 */

export const SPA_ORIGIN_PLACEHOLDER =
  "REPLACE_WITH_BUCKET.s3.us-east-1.amazonaws.com";
export const SPA_ORIGIN_ID = "spa-s3-origin";

export function buildSpaWebsiteDistributionConfig(): Record<string, unknown> {
  return {
    CallerReference: "assignee-spa-website",
    Comment: "SPA website (React / Vue / Angular build) served via CloudFront",
    Enabled: true,
    DefaultRootObject: "index.html",
    PriceClass: "PriceClass_100",
    HttpVersion: "http2",
    IsIPV6Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: SPA_ORIGIN_ID,
          DomainName: SPA_ORIGIN_PLACEHOLDER,
          S3OriginConfig: { OriginAccessIdentity: "" },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: SPA_ORIGIN_ID,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: 2,
        Items: ["GET", "HEAD"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: true,
      MinTTL: 0,
      DefaultTTL: 86400,
      MaxTTL: 31536000,
      ForwardedValues: {
        QueryString: false,
        Cookies: { Forward: "none" },
        Headers: { Quantity: 0 },
        QueryStringCacheKeys: { Quantity: 0 },
      },
    },
    CustomErrorResponses: {
      Quantity: 2,
      Items: [
        {
          ErrorCode: 403,
          ResponseCode: "200",
          ResponsePagePath: "/index.html",
          ErrorCachingMinTTL: 10,
        },
        {
          ErrorCode: 404,
          ResponseCode: "200",
          ResponsePagePath: "/index.html",
          ErrorCachingMinTTL: 10,
        },
      ],
    },
    Restrictions: {
      GeoRestriction: { RestrictionType: "none", Quantity: 0 },
    },
    ViewerCertificate: {
      CloudFrontDefaultCertificate: true,
      MinimumProtocolVersion: "TLSv1.2_2021",
    },
  };
}
