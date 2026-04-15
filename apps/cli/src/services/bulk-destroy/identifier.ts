/**
 * Human-readable identifier extraction from ARN strings.
 *
 * Shared by planBulkDestroy and the bulk-flow display layer. Pure
 * string manipulation — no AWS SDK dependency.
 */

/**
 * Extracts a human-readable identifier from an ARN.
 *
 * Examples:
 *   "arn:aws:s3:::my-bucket"                          -> "my-bucket"
 *   "arn:aws:lambda:us-east-1:123:function:my-func"   -> "my-func"
 *   "arn:aws:ec2:us-east-1:123:instance/i-abc123"     -> "i-abc123"
 */
export function extractIdentifier(arn: string): string {
  const parts = arn.split(":");
  if (parts.length < 6) return arn;

  const resourceSection = parts.slice(5).join(":");

  // Colon-separated: "type:identifier"
  const colonParts = resourceSection.split(":");
  if (colonParts.length >= 2) {
    const resourceType = colonParts[0]!;
    const afterType = colonParts.slice(1).join(":");
    if (afterType && !resourceType.includes("/")) {
      return afterType;
    }
  }

  // SSM parameter: "parameter/<name>" — preserve canonical leading slash
  // since SSM parameter names (and the CloudControl identifier) always begin
  // with "/". e.g. "parameter/e2e-test/param1" -> "/e2e-test/param1"
  if (resourceSection.startsWith("parameter/")) {
    return "/" + resourceSection.slice("parameter/".length);
  }

  // Slash-separated: "type/identifier"
  const slashIdx = resourceSection.indexOf("/");
  if (slashIdx !== -1) {
    if (resourceSection.startsWith("/")) {
      const segments = resourceSection.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? arn;
    }
    return resourceSection.slice(slashIdx + 1) || arn;
  }

  return resourceSection || arn;
}
