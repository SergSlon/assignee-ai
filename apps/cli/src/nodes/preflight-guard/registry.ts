/**
 * Guard registry — add new preflight guards here (OCP: one entry + one
 * new file under ./guards/).
 *
 * Order matters: guards run top-to-bottom and the first FAIL short-
 * circuits. Cheap pure-function guards run before any that hit AWS.
 */
import type { PreflightGuard } from "./types.js";
import { requiredFieldsGuard } from "./guards/required-fields.js";
import { placeholderArnGuard } from "./guards/placeholder-arn.js";
import { sentinelPasswordGuard } from "./guards/sentinel-password.js";
import { managedPolicyGuard } from "./guards/managed-policy.js";

export const defaultPreflightGuards: readonly PreflightGuard[] = [
  requiredFieldsGuard, // cheap: schema "required" check
  placeholderArnGuard, // cheap: walk desiredState
  sentinelPasswordGuard, // cheap: RDS placeholder password sentinel
  managedPolicyGuard, // hits AWS: iam:GetPolicy per ARN
];
