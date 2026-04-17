/**
 * Interactive fix prompt (Type B) — presents remediation options to the
 * user and writes the chosen value into patchedState.
 *
 * Only fires in TTY mode; skipped (and logged) in MCP/CI non-TTY contexts.
 *
 * Wave-6c F3: extracted from fix-applicator.ts (SRP).
 */

import * as clack from "@clack/prompts";
import { FixAction, FixType, type BPFinding } from "@assignee/best-practices";
import type { AppliedFix } from "../../graph-state.js";
import type { AgentState } from "../../graph-state.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";

export interface InteractiveResult {
  patchedState: Record<string, unknown>;
  appliedFixes: AppliedFix[];
  fixedPracticeIds: Set<string>;
  skippedPracticeIds: Set<string>;
}

export async function runInteractiveFixes(params: {
  findings: BPFinding[];
  patchedState: Record<string, unknown>;
  appliedFixes: AppliedFix[];
  fixedPracticeIds: Set<string>;
  state: AgentState;
}): Promise<InteractiveResult> {
  const { findings, state } = params;
  const { patchedState } = params;
  const appliedFixes = [...params.appliedFixes];
  const fixedPracticeIds = new Set(params.fixedPracticeIds);
  const skippedPracticeIds = new Set<string>();

  const interactiveFindings = findings.filter(
    (f) =>
      f.fixType === FixType.INTERACTIVE &&
      f.interactiveOptions &&
      f.interactiveOptions.length > 0 &&
      !fixedPracticeIds.has(f.practiceId),
  );

  if (interactiveFindings.length > 0 && !process.stdin.isTTY) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.FIX_APPLIED,
      extras: {
        skippedInteractive: interactiveFindings.length,
        reason: "non-TTY environment — interactive prompts unavailable",
        practiceIds: interactiveFindings.map((f) => f.practiceId),
      },
    });
    return { patchedState, appliedFixes, fixedPracticeIds, skippedPracticeIds };
  }

  if (interactiveFindings.length === 0 || !process.stdin.isTTY) {
    return { patchedState, appliedFixes, fixedPracticeIds, skippedPracticeIds };
  }

  for (const finding of interactiveFindings) {
    const options = finding.interactiveOptions!;
    const severityLabel = finding.severity;

    const selected = await clack.select({
      message: `${severityLabel}: ${finding.title}`,
      options: options.map((opt, i) => ({
        value: i,
        label: `[${i + 1}] ${opt.label}`,
      })),
    });

    if (clack.isCancel(selected)) continue;

    const option = options[selected as number];
    if (!option) continue;

    if (option.action === "prompt_value" && option.targetField) {
      const value = await clack.text({
        message: `Enter value for ${option.targetField}:`,
        validate: (v) =>
          !v || v.trim().length === 0 ? "Value cannot be empty" : undefined,
      });

      if (!clack.isCancel(value) && value) {
        patchedState[option.targetField] = value as string;
        appliedFixes.push({
          practiceId: finding.practiceId,
          title: finding.title,
          fieldPath: option.targetField,
          oldValue: undefined,
          newValue: value as string,
        });
        fixedPracticeIds.add(finding.practiceId);
      } else if (!clack.isCancel(value)) {
        skippedPracticeIds.add(finding.practiceId);
      }
    } else if (option.action === "prompt_value" && !option.targetField) {
      skippedPracticeIds.add(finding.practiceId);
    } else if (option.action === "set_value" && option.targetField) {
      const oldVal = patchedState[option.targetField];
      patchedState[option.targetField] = option.targetValue;
      appliedFixes.push({
        practiceId: finding.practiceId,
        title: finding.title,
        fieldPath: option.targetField,
        oldValue: oldVal,
        newValue: option.targetValue,
      });
      fixedPracticeIds.add(finding.practiceId);
    } else if (option.action === "remove_property" && option.targetField) {
      const oldVal = patchedState[option.targetField];
      delete patchedState[option.targetField];
      appliedFixes.push({
        practiceId: finding.practiceId,
        title: finding.title,
        fieldPath: option.targetField,
        oldValue: oldVal,
        newValue: undefined,
      });
      fixedPracticeIds.add(finding.practiceId);
    } else if (option.action === FixAction.SKIP) {
      skippedPracticeIds.add(finding.practiceId);
    }
  }

  return { patchedState, appliedFixes, fixedPracticeIds, skippedPracticeIds };
}
