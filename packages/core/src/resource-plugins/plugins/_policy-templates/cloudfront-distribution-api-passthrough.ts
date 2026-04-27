/**
 * CloudFront-Distribution preset: api-passthrough.
 *
 * CDN proxy in front of an HTTP API origin (ALB or API Gateway custom
 * domain). Cache is effectively disabled (DefaultTTL=0) because API
 * responses change per-request; CloudFront still delivers TLS
 * termination + DDoS protection + global edge presence without
 * caching API payloads.
 *
 * @see MASTER-011 part A.
 */

export const API_ORIGIN_PLACEHOLDER = "REPLACE_WITH_API.example.com";
export const API_ORIGIN_ID = "api-origin";

export function buildApiPassthroughDistributionConfig(): Record<
  string,
  unknown
> {
  return {
    CallerReference: "assignee-api-passthrough",
    Comment: "CloudFront proxy in front of an HTTP API (ALB / API Gateway)",
    Enabled: true,
    PriceClass: "PriceClass_All",
    HttpVersion: "http2",
    IsIPV6Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [
        {
          Id: API_ORIGIN_ID,
          DomainName: API_ORIGIN_PLACEHOLDER,
          CustomOriginConfig: {
            HTTPPort: 80,
            HTTPSPort: 443,
            OriginProtocolPolicy: "https-only",
            OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
            OriginReadTimeout: 30,
            OriginKeepaliveTimeout: 5,
          },
        },
      ],
    },
    DefaultCacheBehavior: {
      TargetOriginId: API_ORIGIN_ID,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: 7,
        Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: true,
      MinTTL: 0,
      DefaultTTL: 0,
      MaxTTL: 0,
      ForwardedValues: {
        QueryString: true,
        Cookies: { Forward: "all" },
        Headers: {
          Quantity: 4,
          Items: ["Authorization", "Content-Type", "Origin", "Host"],
        },
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
