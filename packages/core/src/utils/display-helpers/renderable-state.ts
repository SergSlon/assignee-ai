/**
 * Public types for display-layer inputs.
 *
 * Minimal shapes needed for rendering — avoid circular imports with graph.ts.
 */
import type { FreeTierNote } from "../free-tier.js";
import type { BPFinding } from "@assignee/best-practices";
import type { AppliedFix } from "../../types/fix-finding.js";
import type { PricingBreakdown } from "../../pricing/decomposer-types.js";
import type { DataSource } from "../../pricing/types.js";

/**
 * Minimal compound-pattern shape for plan-box rendering. Mirrors the
 * relevant fields of `ArchitecturePattern` and `resourceQueue` without
 * pulling those types into display.ts (which would create a circular
 * import with graph-state.ts).
 */
export interface RenderableCompoundQueue {
  patternDisplayName: string;
  resources: ReadonlyArray<{
    resourceType: string;
    displayName?: string;
  }>;
}

/** Minimal state shape needed for rendering — avoids circular imports with graph.ts */
export interface RenderableState {
  resourceType: string;
  desiredState?: Record<string, unknown>;
  estimatedMonthlyCost?: string;
  /**
   * Story 46.2: provenance tag for `estimatedMonthlyCost`. When present,
   * `formatCostLine` appends a "(live)" / "(cached)" / "(estimated)" /
   * "(from log)" suffix so the user can tell where the dollar amount came
   * from. Free-tier resources tag `"free"` and get no suffix.
   */
  estimatedMonthlyCostSource?: DataSource;
  runId: string;
  resourceArn?: string;
  executionMode?: string;
  freeTierNote?: FreeTierNote;
  bpFindings?: BPFinding[];
  memoryHints?: string[];
  appliedFixes?: AppliedFix[];
  pricingBreakdown?: PricingBreakdown;
  verbose?: boolean;
  autoFixEnabled?: boolean;
  autoApprove?: boolean;
  adviceHints?: string[];
  sourceDir?: string;
  sourceFileCount?: number;
  // Tier S #3: when populated, the plan box renders a "Compound: N
  // resources" prelude listing every resource in the queue. Without
  // this, compound plans only displayed the first resource which
  // misled users about what was about to happen.
  compoundQueue?: RenderableCompoundQueue;
  /**
   * Epic 94 N8 (C-01): `false` marks the rendered resource as a
   * compound companion — API Gateway sub-resources, Lambda
   * permissions, etc. that are display-only at plan time. The plan
   * box prefixes such resources with `[companion]` on the
   * `Resource Type:` line so users can distinguish the 3
   * provisionable WebSocket resources from the 9 display-only
   * companions. Default (undefined / true) renders a normal
   * Resource Type header.
   */
  provisionable?: boolean;
  /**
   * SSH-bundle Story ii — public network address surfaced on the
   * apply-success line for resources that have one (EC2 instances
   * with a public IP, public Lightsail instances, etc.). Populated
   * from a post-apply DescribeInstances call by `apply-single.ts`;
   * silently absent for RDS / Lambda / S3 / private EC2 / etc.
   * IPv4 only — IPv6 is intentionally out of scope per the spec.
   */
  publicIpAddress?: string;
  /**
   * SSH-bundle Story ii — public DNS hostname for the same resource.
   * AWS sometimes returns this as an empty string for instances that
   * have no public DNS configured; treat the empty string as
   * "absent" at the renderer boundary so the field is suppressed.
   */
  publicDnsName?: string;
  /**
   * SSH-bundle Story iii — the keypair name used by the freshly-
   * provisioned EC2 instance. Populated from `state.desiredState[KeyName]`
   * by `apply-single.ts` when the resource was created via the SSH
   * bundle (auto-managed keypair under `~/.assignee/keys/<name>.pem`).
   * The renderer composes a copy-pasteable `ssh -i ...pem` line ONLY
   * when ALL of `keyName` + `sshUsername` + `publicIpAddress` are set.
   */
  keyName?: string;
  /**
   * SSH-bundle Story iii — the AMI's default Linux user (e.g. `ec2-user`,
   * `ubuntu`, `admin`) resolved from `Image.Name` via
   * `getAmiDefaultUser` in `apply-single.ts`. Absent for non-EC2
   * resources, for EC2 instances created without the SSH bundle, and
   * when the post-create DescribeImages call fails (info-logged, not
   * an apply failure).
   */
  sshUsername?: string;
  /**
   * SSH-bundle Story iii — the resolved AMI ID (`ami-…`) of the
   * provisioned instance, surfaced for the AMI→user lookup and for
   * any future renderer that wants to reflect the AMI back to the
   * user. Stored as the resolved `ami-…` form (compound-plan and the
   * LLM-plan post-process both resolve OS-name placeholders before
   * apply lands here).
   */
  amiId?: string;
}
