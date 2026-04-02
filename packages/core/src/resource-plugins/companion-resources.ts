import { RESOURCE_TYPES } from "../config/resource-types.js";
import { CfnKey } from "../config/cfn-keys.js";
import type { CfnOutput, ResourcePlugin } from "./types.js";

/**
 * Options for collecting companion resources during plan generation.
 * @see Story 25.6 — LogGroup co-provisioning
 */
export interface CollectCompanionOptions {
  /**
   * When true, skip all companion resource generation.
   * Maps to CLI `--no-log-group` flag or config `autoLogGroup: false`.
   */
  disabled?: boolean;
}

/**
 * A planned resource in the pipeline — pairs a plugin with user-provided desired state.
 */
export interface PlannedResource {
  plugin: ResourcePlugin;
  desiredState: Record<string, unknown>;
}

/**
 * Collects companion resources from all planned resources, applying deduplication
 * against both explicitly-planned resources and other companions.
 *
 * Deduplication uses the companion's `type` + a distinguishing property:
 * - For `AWS::Logs::LogGroup`, the key is `LogGroupName`.
 * - For other types, the key is `logicalId`.
 *
 * @param planned  The list of resources the user explicitly planned.
 * @param options  Optional flags (e.g., opt-out).
 * @returns        Deduplicated array of companion CfnOutputs to add to the plan.
 */
export function collectCompanionResources(
  planned: PlannedResource[],
  options: CollectCompanionOptions = {},
): CfnOutput[] {
  if (options.disabled) return [];

  // Build a set of already-planned LogGroupNames for deduplication.
  const existingLogGroupNames = new Set<string>();
  for (const { plugin, desiredState } of planned) {
    if (plugin.resourceType === RESOURCE_TYPES.LOGS_LOG_GROUP) {
      const name = desiredState[CfnKey.LOG_GROUP_NAME];
      if (typeof name === "string") {
        existingLogGroupNames.add(name);
      }
    }
  }

  const companions: CfnOutput[] = [];
  const seenLogGroupNames = new Set<string>(existingLogGroupNames);

  for (const { plugin, desiredState } of planned) {
    if (!plugin.companionResources) continue;

    const generated = plugin.companionResources(desiredState);
    for (const companion of generated) {
      // Deduplicate LogGroups by LogGroupName.
      if (companion.type === RESOURCE_TYPES.LOGS_LOG_GROUP) {
        const lgName = companion.properties[CfnKey.LOG_GROUP_NAME];
        if (typeof lgName === "string" && seenLogGroupNames.has(lgName)) {
          continue; // Already exists in plan or from another companion.
        }
        if (typeof lgName === "string") {
          seenLogGroupNames.add(lgName);
        }
      }

      companions.push(companion);
    }
  }

  return companions;
}
