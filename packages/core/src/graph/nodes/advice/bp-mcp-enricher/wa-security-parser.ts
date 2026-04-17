/**
 * Shared parser for Well-Architected Security MCP findings.
 *
 * CheckStorageEncryption and CheckNetworkSecurity emit the same
 * envelope shape — either a `findings` array or a `resource_details`
 * array. This module converts either shape into `BPFinding[]` for the
 * enricher's dedup/merge pipeline.
 */
import type { BPFinding, BPCategory } from "@assignee/best-practices";
import { mapMcpSeverity } from "./types.js";

export function parseWaSecurityFindings(
  result: unknown,
  practicePrefix: string,
): BPFinding[] {
  try {
    const text = typeof result === "string" ? result : JSON.stringify(result);
    const outer = JSON.parse(text) as Record<string, unknown>;
    const parsed = (outer?.["result"] ?? outer) as Record<string, unknown>;

    // Handle both formats: findings[] or resource_details[]
    const items =
      (parsed["findings"] as unknown[]) ??
      (parsed["resource_details"] as unknown[]) ??
      [];
    if (!Array.isArray(items)) return [];

    return items
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object",
      )
      .flatMap((item) => convertItem(item, practicePrefix));
  } catch {
    return [];
  }
}

function convertItem(
  item: Record<string, unknown>,
  practicePrefix: string,
): BPFinding[] {
  // resource_details format: {resource_arn, compliant, issues[], recommendations[]}
  if (item["compliant"] === true) return []; // Skip compliant resources
  const issues = item["issues"] as string[] | undefined;
  const recommendations = item["recommendations"] as string[] | undefined;
  // Include resource ARN suffix in practiceId to avoid collisions when
  // multiple resources have the same issue text.
  const arnSuffix =
    String(item["resource_arn"] ?? "")
      .split(/[:/]/)
      .pop() ?? "";
  if (issues && Array.isArray(issues)) {
    return issues.map(
      (issue, i): BPFinding => ({
        practiceId: `${practicePrefix}-${arnSuffix ? arnSuffix + "-" : ""}${issue.replace(/\s+/g, "-").slice(0, 25)}`,
        title: issue,
        severity: mapMcpSeverity(item["severity"] as string | undefined),
        category: "security" as BPCategory,
        message: recommendations?.[i] ?? issue,
        remediation: recommendations?.[i] ?? "",
        blocking: false,
      }),
    );
  }

  // findings format: {severity, title, recommendation, property}
  const title = item["title"] as string | undefined;
  if (title) {
    return [
      {
        practiceId: `${practicePrefix}-${title.replace(/\s+/g, "-").slice(0, 25)}`,
        title,
        severity: mapMcpSeverity(item["severity"] as string | undefined),
        category: "security" as BPCategory,
        message: (item["recommendation"] as string) ?? "",
        remediation: (item["recommendation"] as string) ?? "",
        blocking: false,
        propertyPath: item["property"] as string | undefined,
      },
    ];
  }

  return [];
}
