/**
 * Drift report serializer — builds a structured JSON report from drift results.
 *
 * @see Story 28.5 — Drift Report Export
 */

import { randomUUID } from "node:crypto";
import type { DriftResult, DriftStatusType } from "@assignee/core";
import { DriftStatus } from "@assignee/core";
import { AWS_REGION } from "../config/constants.js";

export interface DriftReportSummary {
  total: number;
  inSync: number;
  drifted: number;
  deleted: number;
  errors: number;
}

export interface DriftReportMetadata {
  assigneeVersion: string;
  awsAccountId: string;
  checkDurationMs: number;
}

export interface DriftReport {
  reportId: string;
  generatedAt: string;
  region: string;
  summary: DriftReportSummary;
  metadata: DriftReportMetadata;
  resources: DriftResult[];
}

export interface ReportOptions {
  region?: string;
  assigneeVersion?: string;
  awsAccountId?: string;
  checkDurationMs?: number;
}

/**
 * Build a structured drift report from an array of drift results.
 */
export function buildDriftReport(
  results: DriftResult[],
  opts: ReportOptions = {},
): DriftReport {
  const summary: DriftReportSummary = {
    total: results.length,
    inSync: results.filter((r) => r.status === DriftStatus.IN_SYNC).length,
    drifted: results.filter((r) => r.status === DriftStatus.DRIFTED).length,
    deleted: results.filter((r) => r.status === DriftStatus.DELETED).length,
    errors: results.filter(
      (r) =>
        r.status === DriftStatus.ERROR ||
        r.status === DriftStatus.BASELINE_MISSING,
    ).length,
  };

  return {
    reportId: randomUUID(),
    generatedAt: new Date().toISOString(),
    region: opts.region ?? AWS_REGION,
    summary,
    metadata: {
      assigneeVersion: opts.assigneeVersion ?? "0.0.0",
      awsAccountId: opts.awsAccountId ?? "unknown",
      checkDurationMs: opts.checkDurationMs ?? 0,
    },
    resources: results,
  };
}
