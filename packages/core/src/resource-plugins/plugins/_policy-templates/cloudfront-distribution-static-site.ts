/**
 * CloudFront-Distribution preset: static-site.
 *
 * Multi-page static-HTML site (Hugo/Jekyll/Eleventy/MkDocs) served
 * from a private S3 bucket. Same Origins block as the SPA preset
 * but WITHOUT the SPA fallback (no rewrite of 403/404 to /index.html
 * — multi-page sites have multiple real entry points and need real
 * 404s).
 *
 * @see MASTER-011 part A.
 */

export const STATIC_ORIGIN_PLACEHOLDER =
  "REPLACE_WITH_BUCKET.s3.us-east-1.amazonaws.com";
export const STATIC_ORIGIN_ID = "static-s3-origin";

export function buildStaticSiteDistributionConfig(): Record<string, unknown> {
  return {
    CallerReference: "assignee-static-site",
    Comment: "Static multi-page website served via CloudFront",
    Enabled: true,
    DefaultRootObject: "index.html",
    PriceClass: "PriceClass_100",
    HttpVersion: "http2",
    IsIPV6Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: STATIC_ORIGIN_ID,
          DomainName: STATIC_ORIGIN_PLACEHOLDER,
          S3OriginConfig: { OriginAccessIdentity: "" },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: STATIC_ORIGIN_ID,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: 2,
        Items: ["GET", "HEAD"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: true,
      MinTTL: 0,
      DefaultTTL: 3600,
      MaxTTL: 86400,
      ForwardedValues: {
        QueryString: false,
        Cookies: { Forward: "none" },
        Headers: { Quantity: 0 },
        QueryStringCacheKeys: { Quantity: 0 },
      },
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
