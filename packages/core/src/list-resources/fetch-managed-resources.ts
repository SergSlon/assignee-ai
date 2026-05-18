/**
 * Shared `fetchManagedResources` — the single source of truth for
 * merging the Resource-Groups-Tagging-API output with the provision
 * log, IAM-role enumeration, billing enrichment, and free-tier
 * fallbacks.
 *
 * Consolidates the previously-forked implementations in
 * `apps/cli/src/services/list-resources.ts` (164 LOC, full-featured)
 * and `apps/mcp-server/src/services/list-resources.ts` (115 LOC,
 * silently missing IAM roles + billing per memory
 * `feedback_iam_role_rgta_gap`). Story 52-2 / Epic 52.
 *
 * Design notes:
 * - The RGTA SDK is injected via a `fetchRgtaResources` callback so
 *   `packages/core` does not need to depend on
 *   `@aws-sdk/client-resource-groups-tagging-api`. The callers each
 *   own their SDK client (and their credential resolution, which
 *   stays lazy per memory `feedback_lazy_credential_resolution_in_mcp`).
 * - IAM-role enumeration and billing enrichment are OPTIONAL
 *   injectors; MCP now opts into IAM-role enumeration to close the
 *   RGTA blind spot.
 */

import { CostEstimateLabel } from "../pricing/filter-constants.js";
import { AssigneeTag } from "../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../config/resource-types.js";
import { isGlobalService } from "../config/arn-type-map.js";
import { getFreeTierCostLabel } from "../utils/free-tier.js";
import { listNonTaggableProvisionRecords } from "../managed-resources/index.js";
import { loadProvisionData } from "./provision-log.js";
import { parseArn } from "./parse-arn.js";
import type { ManagedResource } from "./types.js";

/** Raw tag shape the RGTA injector returns (subset of AWS SDK type). */
export interface RgtaTag {
  Key?: string;
  Value?: string;
}

/** Raw mapping shape the RGTA injector returns (subset of AWS SDK type). */
export interface RgtaMapping {
  ResourceARN?: string;
  Tags?: RgtaTag[];
}

/**
 * Injector the callers use to plug in their RGTA client. Must return
 * the full paginated result set. Core drives pagination semantics by
 * calling this exactly once per run; callers handle pagination inside.
 */
export type RgtaFetcher = () => Promise<RgtaMapping[]>;

/** Minimal IAM-role shape merged into the ManagedResource list. */
export interface ManagedIamRole {
  arn: string;
  roleName: string;
  createdDate: string;
  tags: Record<string, string>;
}

/** Billing-MCP enrichment callback shape. */
export type BillingEnricher = (
  resources: ManagedResource[],
) => Promise<Map<string, { actualMonthlyCost: string }>>;

/**
 * Pricing-MCP enrichment callback — resolves live rate-card cost strings
 * for resources whose cost would otherwise remain N/A. Returns a map of
 * ARN → cost label string (e.g. "$1.00/mo", "$0.023/GB-Mo").
 *
 * Story: feature-pricing-mcp-list-enrichment
 */
export type PricingEnricher = (
  resources: ManagedResource[],
) => Promise<Map<string, string>>;

/**
 * Created-date enrichment callback — resolves live creation timestamps
 * for resources whose createdDate would otherwise remain N/A. Returns a
 * map of ARN → date string (e.g. "2026-03-15" or "2026-03-15 (modified)").
 *
 * Story: feature-list-created-date-enrichment
 */
export type CreatedDateEnricher = (
  resources: ManagedResource[],
) => Promise<Map<string, string>>;

/** Options controlling which enrichers fire and how timestamps resolve. */
export interface FetchManagedResourcesOptions {
  /** AWS region to stamp on resources when parseArn can't derive one. */
  region: string;
  /** RGTA pagination-complete fetcher (caller owns the SDK client). */
  fetchRgtaResources: RgtaFetcher;
  /** Optional IAM-role enumerator (RGTA doesn't cover IAM::Role). */
  enrichWithIamRoles?: () => Promise<ManagedIamRole[]>;
  /** Optional live-billing enrichment (Story 19.7). */
  enrichWithBilling?: BillingEnricher;
  /**
   * Optional live Pricing-MCP enrichment — resolves rate-card cost labels
   * for every row whose `estimatedMonthlyCost` is still N/A after billing
   * enrichment. Fires after billing so actuals always take precedence.
   * Story: feature-pricing-mcp-list-enrichment.
   */
  enrichWithPricing?: PricingEnricher;
  /**
   * Optional live created-date enrichment — resolves creation timestamps
   * for every row whose `createdDate` is still N/A after provision-log
   * lookup. Story: feature-list-created-date-enrichment.
   */
  enrichWithCreatedDate?: CreatedDateEnricher;
  /** Filter results to a single CloudFormation resource type. */
  resourceTypeFilter?: string;
  /**
   * How `createdDate` falls back when not in the provision log. CLI
   * uses `"na"`; MCP uses `"run-id-tag"` to fall back to the
   * `assignee-run-id` tag value.
   */
  createdDateFallback?: "na" | "run-id-tag";
  /**
   * Whether `getFreeTierCostLabel` is used as a last-resort cost
   * fallback. CLI=true, MCP=false.
   */
  useFreeTierFallback?: boolean;
  /**
   * Returns the set of ARNs that have been successfully destroyed.
   * Resources in this set are filtered from list output while AWS
   * keeps them in INACTIVE state (e.g. ECS clusters linger ~1h after
   * deletion). Injected by callers so core does not depend on the
   * MemoryService directly.
   */
  getDestroyedArns?: () => Promise<Set<string>>;
  /**
   * Called when IAM-role enumeration throws. CLI writes a stderr
   * warning; MCP logs via its structured logger. Defaults to a
   * stderr write for parity with the original CLI behavior.
   */
  onIamRoleEnumerationError?: (err: unknown) => void;
}

/** Pure helper exposed for tests. */
export function hasManagedByTag(tags: RgtaTag[] | undefined): boolean {
  return (tags ?? []).some(
    (t) => t.Key === AssigneeTag.KEY && t.Value === AssigneeTag.VALUE,
  );
}

/**
 * Enumerate all `managed-by=assignee-ai` resources — merges RGTA output
 * with the provision log, optionally with IAM roles (RGTA blind spot)
 * and live billing costs.
 */
export async function fetchManagedResources(
  opts: FetchManagedResourcesOptions,
): Promise<ManagedResource[]> {
  const {
    region,
    fetchRgtaResources,
    enrichWithIamRoles,
    enrichWithBilling,
    enrichWithPricing,
    enrichWithCreatedDate,
    resourceTypeFilter,
    createdDateFallback = "na",
    useFreeTierFallback = false,
    onIamRoleEnumerationError,
    getDestroyedArns,
  } = opts;

  const { costMap, timestampMap, compensatingPolicyMap } = loadProvisionData();
  const resources: ManagedResource[] = [];

  const mappings = await fetchRgtaResources();
  for (const mapping of mappings) {
    const arn = mapping.ResourceARN ?? "";
    const parsed = parseArn(arn);
    const arnName = arn.split("/").pop() ?? arn.split(":").pop() ?? "";

    const runIdTag = mapping.Tags?.find(
      (t) => t.Key === "assignee-run-id",
    )?.Value;
    const createdDate =
      timestampMap.get(arn) ??
      timestampMap.get(arnName) ??
      (createdDateFallback === "run-id-tag" && runIdTag
        ? runIdTag
        : CostEstimateLabel.NA);

    const freeTierLabel = useFreeTierFallback
      ? getFreeTierCostLabel(parsed.resourceType)
      : undefined;

    // Story e94.P2 (D-06): global-service ARNs (IAM, CloudFront,
    // Route53, WAF, Organizations) have no region slot — display
    // them as `"global"` instead of leaking the operator's configured
    // region. Mirrors the IAM-Role enrichment branch below which
    // already hardcodes `"global"`.
    const displayRegion = isGlobalService(parsed.service)
      ? "global"
      : parsed.region || region;

    // bug-s3-bucket-policy-attach-failure-observability — surface the
    // S3 compensating-policy outcome on the row so `assignee admin list` can
    // flag buckets where the per-bucket tag boundary is not in effect.
    // Only set the field when the provision record carries it; non-S3
    // resources, S3 buckets where the policy attached cleanly, and pre-
    // bug records all leave it undefined.
    const policyOutcome =
      compensatingPolicyMap.get(arn) ?? compensatingPolicyMap.get(arnName);
    resources.push({
      resourceType: parsed.resourceType,
      arn,
      keyKind: "arn",
      region: displayRegion,
      createdDate,
      estimatedMonthlyCost:
        costMap.get(arn) ??
        costMap.get(arnName) ??
        freeTierLabel ??
        CostEstimateLabel.NA,
      ...(policyOutcome && !policyOutcome.attached
        ? {
            compensatingPolicyAttached: false,
            ...(policyOutcome.reason
              ? { compensatingPolicyError: policyOutcome.reason }
              : {}),
          }
        : {}),
    });
  }

  // ── IAM::Role merge (closes feedback_iam_role_rgta_gap for MCP) ────
  if (enrichWithIamRoles) {
    try {
      const iamRoles = await enrichWithIamRoles();
      const seenArns = new Set(resources.map((r) => r.arn));
      for (const role of iamRoles) {
        if (seenArns.has(role.arn)) continue;
        const freeTierLabel = useFreeTierFallback
          ? getFreeTierCostLabel(RESOURCE_TYPES.IAM_ROLE)
          : undefined;
        resources.push({
          resourceType: RESOURCE_TYPES.IAM_ROLE,
          arn: role.arn,
          keyKind: "arn",
          region: "global",
          createdDate:
            timestampMap.get(role.arn) ??
            timestampMap.get(role.roleName) ??
            role.createdDate,
          estimatedMonthlyCost:
            costMap.get(role.arn) ??
            costMap.get(role.roleName) ??
            freeTierLabel ??
            CostEstimateLabel.NA,
        });
      }
    } catch (err) {
      if (onIamRoleEnumerationError) {
        onIamRoleEnumerationError(err);
      } else {
        process.stderr.write(
          `⚠ Warning: Could not enumerate IAM roles (${
            err instanceof Error ? err.message : String(err)
          }). Run 'assignee dev setup' to refresh operator permissions if this persists.\n`,
        );
      }
    }
  }

  // ── Non-taggable constructs from provision log (e98.W1.B1) ────────
  // AWS::EC2::Route / SubnetRouteTableAssociation / VPCGatewayAttachment
  // don't support tagging, so RGTA never returns them. Read them from
  // the provision log — writeProvisionRecord already captured the
  // primaryIdentifier in its `resourceArn` slot when apply succeeded.
  // Closes B-02 BLOCKER: user creates these and list silently drops them.
  try {
    const nonTaggable = await listNonTaggableProvisionRecords();
    const seenKeys = new Set<string>(
      resources.map((r) => r.primaryIdentifier ?? r.arn),
    );
    for (const entry of nonTaggable) {
      if (seenKeys.has(entry.key)) continue;
      resources.push({
        resourceType: entry.resourceType,
        arn: "",
        primaryIdentifier: entry.key,
        keyKind: "primaryIdentifier",
        region: entry.region || region,
        createdDate: entry.createdDate,
        estimatedMonthlyCost:
          entry.estimatedMonthlyCost || CostEstimateLabel.NA,
      });
    }
  } catch {
    // Provision log missing / unreadable is normal for new users;
    // `listProvisionRecords` already handles the ENOENT path silently.
    // Any other read failure must not cascade into list — keep list
    // best-effort and fall through to the rest of the pipeline.
  }

  // ── Billing enrichment (Story 19.7) ───────────────────────────────
  if (enrichWithBilling && resources.length > 0) {
    try {
      const billingMap = await enrichWithBilling(resources);
      for (const resource of resources) {
        const billingData = billingMap.get(resource.arn);
        if (billingData) {
          resource.estimatedMonthlyCost = billingData.actualMonthlyCost;
        }
      }
    } catch {
      // Billing MCP unavailable — keep provision log costs.
    }
  }

  // ── Pricing-MCP enrichment (feature-pricing-mcp-list-enrichment) ──
  // Fires AFTER billing so actuals always take precedence. Only targets
  // rows whose estimatedMonthlyCost is still CostEstimateLabel.NA — rows
  // already resolved via provision-log, billing, or free-tier fallback
  // are left untouched.
  if (enrichWithPricing && resources.length > 0) {
    try {
      const naRows = resources.filter(
        (r) => r.estimatedMonthlyCost === CostEstimateLabel.NA,
      );
      if (naRows.length > 0) {
        const pricingMap = await enrichWithPricing(naRows);
        for (const resource of resources) {
          const cost = pricingMap.get(resource.arn);
          if (cost !== undefined) {
            resource.estimatedMonthlyCost = cost;
          }
        }
      }
    } catch {
      // Pricing MCP unavailable — keep current cost labels (N/A or
      // provision-log values). Degrade gracefully, never crash.
    }
  }

  // ── Created-date enrichment (feature-list-created-date-enrichment) ─
  // Fires after all other date resolution paths. Only targets rows
  // whose createdDate is still CostEstimateLabel.NA.
  if (enrichWithCreatedDate && resources.length > 0) {
    try {
      const naDateRows = resources.filter(
        (r) => r.createdDate === CostEstimateLabel.NA,
      );
      if (naDateRows.length > 0) {
        const dateMap = await enrichWithCreatedDate(naDateRows);
        for (const resource of resources) {
          const date = dateMap.get(resource.arn);
          if (date !== undefined) {
            resource.createdDate = date;
          }
        }
      }
    } catch {
      // SDK describe calls failed — keep current date labels (N/A).
      // Degrade gracefully, never crash.
    }
  }

  // ── Destroyed-ARN filter (BUG-9: ECS INACTIVE ~1h post-delete) ────
  // AWS keeps the managed-by tag on deleted resources for up to ~1h,
  // so RGTA still returns them. Filter any ARN that the destroy path
  // recorded as successfully deleted.
  let destroyedArns: Set<string> = new Set();
  if (getDestroyedArns) {
    try {
      destroyedArns = await getDestroyedArns();
    } catch {
      // Degraded: destroyed-arns.json unreadable — show everything.
    }
  }

  const visible = destroyedArns.size
    ? resources.filter((r) => !r.arn || !destroyedArns.has(r.arn))
    : resources;

  return resourceTypeFilter
    ? visible.filter((r) => r.resourceType === resourceTypeFilter)
    : visible;
}
