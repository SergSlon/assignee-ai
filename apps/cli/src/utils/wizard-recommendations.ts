/**
 * Post-wizard recommendation engine — lightweight, intent-aware suggestions
 * displayed after the option elicitor completes but before plan generation.
 *
 * Advisory only: recommendations do NOT modify elicitedOptions, do NOT block,
 * and do NOT affect graph state. The BP evaluator (Story 12.3) handles
 * formal policy enforcement separately.
 *
 * @see Story 10.7
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import { CfnKey, RESOURCE_TYPES } from "@assignee/core";
import { ResourceFieldName } from "../constants/resource-fields.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type RecommendationSeverity = "info" | "warn";

export interface RecommendationRule {
  id: string;
  resourceType: string;
  severity: RecommendationSeverity;
  message: string;
  condition: (
    options: Record<string, unknown>,
    intent: string,
    resourceType: string,
  ) => boolean;
}

export interface WizardRecommendation {
  id: string;
  severity: RecommendationSeverity;
  message: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const isProductionIntent = (intent: string): boolean =>
  /\bprod(uction)?\b/i.test(intent);

// ── Rules ────────────────────────────────────────────────────────────────────

export const RECOMMENDATION_RULES: RecommendationRule[] = [
  {
    id: "ec2-no-key-pair",
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    severity: "info",
    message:
      "No SSH key selected. Access will be via SSM Session Manager only. " +
      "Add a key pair if you need direct SSH access.",
    condition: (options) => {
      const key = options[ResourceFieldName.KEY_NAME];
      return key === undefined || key === "" || key === "none";
    },
  },
  {
    id: "ec2-undersized-prod",
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    severity: "warn",
    message:
      "t3.micro may be undersized for production. " +
      "Consider t3.small or m5.large for reliable performance.",
    condition: (options, intent) => {
      const instanceType = options[ResourceFieldName.INSTANCE_TYPE];
      return (
        (instanceType === "t3.micro" || instanceType === "t3.nano") &&
        isProductionIntent(intent)
      );
    },
  },
  {
    id: "s3-no-versioning",
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    severity: "info",
    message:
      "Versioning is disabled. Enable it if this bucket stores data " +
      "you can't afford to lose.",
    condition: (options) => {
      const versioning = options[CfnKey.VERSIONING_CONFIGURATION];
      if (versioning === undefined) return true;
      if (typeof versioning === "object" && versioning !== null) {
        return (
          (versioning as Record<string, unknown>)[CfnKey.STATUS] !== "Enabled"
        );
      }
      return versioning !== true;
    },
  },
  {
    id: "rds-no-multi-az-prod",
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    severity: "warn",
    message:
      "Single-AZ deployment selected. Consider Multi-AZ for production " +
      "database high availability.",
    condition: (options, intent) => {
      return !options[CfnKey.MULTI_AZ] && isProductionIntent(intent);
    },
  },
  {
    id: "lambda-low-memory-api",
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    severity: "info",
    message:
      "Consider 256+ MB for API handlers — CPU scales with memory, " +
      "improving response latency.",
    condition: (options, intent) => {
      const mem = options[CfnKey.MEMORY_SIZE];
      const isLowMem = mem === 128 || mem === "128" || mem === undefined;
      return isLowMem && intent.toLowerCase().includes("api");
    },
  },
  {
    id: "lambda-no-reserved-concurrency",
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    severity: "info",
    message:
      "Set reserved concurrency to prevent a single function from " +
      "consuming the account-wide Lambda concurrency pool.",
    condition: (options) => {
      const val = options[CfnKey.RESERVED_CONCURRENT_EXECUTIONS];
      return val === undefined || val === "" || val === null;
    },
  },
];

// ── Engine ───────────────────────────────────────────────────────────────────

/**
 * Evaluates all recommendation rules against the elicited options and user intent.
 * Returns only the recommendations whose conditions are met for the given resource type.
 */
export function evaluateWizardRecommendations(
  options: Record<string, unknown>,
  intent: string,
  resourceType: string,
): WizardRecommendation[] {
  return RECOMMENDATION_RULES.filter(
    (rule) =>
      rule.resourceType === resourceType &&
      rule.condition(options, intent, resourceType),
  ).map((rule) => ({
    id: rule.id,
    severity: rule.severity,
    message: rule.message,
  }));
}

// ── Display ──────────────────────────────────────────────────────────────────

/**
 * Renders wizard recommendations to the terminal using clack.note().
 * WARN severity items appear first, then INFO.
 * Skipped entirely if there are no recommendations or if not in TTY mode.
 */
export function displayRecommendations(
  recommendations: WizardRecommendation[],
): void {
  if (recommendations.length === 0) return;
  if (!process.stdout.isTTY) return;

  // Sort: WARN first, then INFO
  const sorted = [...recommendations].sort((a, b) => {
    if (a.severity === "warn" && b.severity === "info") return -1;
    if (a.severity === "info" && b.severity === "warn") return 1;
    return 0;
  });

  for (const rec of sorted) {
    const prefix =
      rec.severity === "warn"
        ? chalk.yellow("\u26A0 Warning")
        : chalk.blue("\u2139 Suggestion");
    clack.note(rec.message, prefix);
  }
}
