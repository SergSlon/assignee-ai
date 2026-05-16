/**
 * Guard registry — add new preflight guards here (OCP: one entry + one
 * new file under ./guards/).
 *
 * Order matters: guards run top-to-bottom and the first FAIL short-
 * circuits. Cheap pure-function guards run before any that hit AWS.
 *
 * Epic 92 Wave 1 additions (e92.1.c):
 *   - `placeholderResourceIdGuard` — pure walk, catches hallucinated
 *     EC2-style IDs (`vpc-12345678`, `subnet-abc12345`, `sg-0abc…`).
 *     Runs immediately after `placeholderArnGuard` so the placeholder-
 *     class short-circuit happens before any AWS call.
 *   - `vpcExistenceGuard` — hits AWS (`ec2:DescribeVpcs`) once to
 *     confirm a concrete `VpcId` exists in the account/region.
 *     Runs BEFORE `managedPolicyGuard` so auth/throttle handling is
 *     consistent across the AWS-hitting guard block.
 */
import type { PreflightGuard } from "./types.js";
import { requiredFieldsGuard } from "./guards/required-fields.js";
import { placeholderArnGuard } from "./guards/placeholder-arn.js";
import { placeholderResourceIdGuard } from "./guards/placeholder-resource-id.js";
import { sentinelPasswordGuard } from "./guards/sentinel-password.js";
import { vpcExistenceGuard } from "./guards/vpc-existence.js";
import { managedPolicyGuard } from "./guards/managed-policy.js";
import { lambdaIamAutoRoleGuard } from "./guards/lambda-iam-autorole.js";

export const defaultPreflightGuards: readonly PreflightGuard[] = [
  requiredFieldsGuard, // cheap: schema "required" check
  placeholderArnGuard, // cheap: walk desiredState (ARN-shaped values)
  placeholderResourceIdGuard, // cheap: walk desiredState (EC2 resource IDs)
  sentinelPasswordGuard, // cheap: RDS placeholder password sentinel
  vpcExistenceGuard, // hits AWS: ec2:DescribeVpcs (skip if no VpcId)
  managedPolicyGuard, // hits AWS: iam:GetPolicy per ARN
  // DF-D5: Lambda auto-role IAM preflight — checks iam:CreateRole +
  // iam:AttachRolePolicy when the intent will auto-create an execution role.
  // Runs after managed-policy so all AWS-touching guards are grouped together.
  lambdaIamAutoRoleGuard, // hits AWS: iam:SimulatePrincipalPolicy (skip if no IAM tool / no Lambda)
];
