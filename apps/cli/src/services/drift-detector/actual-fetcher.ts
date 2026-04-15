/**
 * Single-resource drift check — fetches actual state via CloudControl
 * GetResource and produces a DriftResult.
 *
 * Extracted from drift-detector.ts during Wave-6c decomposition.
 *
 * @see Story 28.1
 */

import {
  DriftStatus,
  type DriftResult,
  type DriftStatusType,
} from "@assignee/core";
import { UNKNOWN_FALLBACK } from "../../config/constants.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../provisioning-port.js";
import { deepDiff } from "./field-diff.js";

/**
 * Check a single resource for drift.
 *
 * @param port - ProvisioningPort used to fetch actual resource state.
 * @param typeName - CloudFormation resource type.
 * @param identifier - Resource identifier (logical or physical).
 * @param desiredState - Expected state (from provision log or checkpoint).
 * @returns DriftResult with status and drifted fields.
 */
export async function checkResource(
  port: ProvisioningPort,
  typeName: string,
  identifier: string,
  desiredState?: Record<string, unknown>,
): Promise<DriftResult> {
  const checkedAt = new Date().toISOString();

  // No desired state — baseline missing
  if (!desiredState) {
    return {
      resourceType: typeName,
      resourceId: identifier,
      status: DriftStatus.BASELINE_MISSING,
      driftedFields: [],
      checkedAt,
    };
  }

  // Fetch actual state
  const [error, result] = await port.getResource(typeName, identifier);

  if (error) {
    if (error.kind === ProvisioningErrorKind.NOT_FOUND) {
      return {
        resourceType: typeName,
        resourceId: identifier,
        status: DriftStatus.DELETED,
        driftedFields: [],
        desiredState,
        checkedAt,
      };
    }

    return {
      resourceType: typeName,
      resourceId: identifier,
      status: DriftStatus.ERROR,
      driftedFields: [],
      desiredState,
      checkedAt,
      errorMessage: error.message,
    };
  }

  // Parse actual state from CloudControl response
  let actualState: Record<string, unknown>;
  try {
    const resourceDesc = result as {
      ResourceDescription?: { Properties?: string };
    };
    const propsJson = resourceDesc?.ResourceDescription?.Properties;
    if (!propsJson) {
      return {
        resourceType: typeName,
        resourceId: identifier,
        status: DriftStatus.ERROR,
        driftedFields: [],
        desiredState,
        checkedAt,
        errorMessage: "GetResource returned no Properties",
      };
    }
    actualState = JSON.parse(propsJson) as Record<string, unknown>;
  } catch (parseErr) {
    return {
      resourceType: typeName,
      resourceId: identifier,
      status: DriftStatus.ERROR,
      driftedFields: [],
      desiredState,
      checkedAt,
      errorMessage: `Failed to parse resource properties: ${parseErr instanceof Error ? parseErr.message : UNKNOWN_FALLBACK}`,
    };
  }

  // Deep diff
  const driftedFields = deepDiff(desiredState, actualState, typeName);

  const status: DriftStatusType =
    driftedFields.length > 0 ? DriftStatus.DRIFTED : DriftStatus.IN_SYNC;

  return {
    resourceType: typeName,
    resourceId: identifier,
    status,
    driftedFields,
    actualState,
    desiredState,
    checkedAt,
  };
}
