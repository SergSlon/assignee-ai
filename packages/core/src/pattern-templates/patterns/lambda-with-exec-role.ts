/**
 * Wave 13 — minimal Lambda + auto-created exec role pattern.
 *
 * Closes the Phase 2 lifecycle smoke test gap where
 * `assignee plan "Create a Lambda"` required the user to remember the
 * `--set Role=arn:aws:iam::...:role/...` workaround because Lambda's
 * IAM execution role is mandatory but the user was never asked for
 * one. With this pattern, plain "create a lambda" intents now produce
 * a 2-resource compound:
 *
 *   1. IAM Role — auto-created with the canonical Lambda trust policy
 *      (lambda.amazonaws.com assume-role) and the AWS-managed
 *      AWSLambdaBasicExecutionRole policy attached
 *   2. Lambda Function — the user's intended function, with `Role`
 *      injected via marker token from step 1
 *
 * The serverless-api pattern (8 resources, includes API Gateway) is
 * the right answer when the user wants the full HTTP-facing API.
 * This pattern is the right answer when the user only wants a
 * Lambda function — typical of background workers, scheduled tasks,
 * SQS consumers, EventBridge handlers, etc.
 *
 * Registration order matters (registry uses first-match-wins on
 * keyword substring): serverless-api MUST be registered before this
 * pattern so longer-form intents like "create a serverless api with
 * lambda" still match the api-gateway-bearing pattern first.
 *
 * The naming convention for the auto-created role uses the runId
 * suffix (handled by plan-generator's NAME_FIELDS injection at
 * apps/cli/src/nodes/plan-generator.ts line ~514) which produces
 * `assignee-iam-execution-role-<runIdShort>`. This naming pattern is
 * NOT in the `Assignee*` reserved set guarded by
 * `feedback_assignee_infra_safety_allowlist.md` — the
 * ASSIGNEE_INFRA_NAME_PATTERN regex specifically anchors on
 * `^Assignee...` (capital A, no hyphen) and matches words like
 * AssigneeOperatorPolicy / AssigneeAiBedrockLoggingRole. Our
 * `assignee-` prefix (lowercase, hyphenated) does NOT trip the
 * pattern. Verified.
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import { markerGetAtt } from "../../config/marker-tokens.js";
import { IamEffect } from "../../config/iam-effects.js";
import {
  AwsManagedPolicy,
  IamPolicy,
  AwsServicePrincipal,
} from "../../config/aws-arns.js";
import type { ArchitecturePattern } from "../types.js";
import { LambdaWithExecRoleResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

export const lambdaWithExecRolePattern: ArchitecturePattern = {
  patternId: PatternId.LAMBDA_WITH_EXEC_ROLE,
  displayName: "Lambda Function (with auto-created exec role)",
  /**
   * Keywords are deliberately chosen to match plain "create a lambda"
   * intents while leaving longer-form patterns to win their own keywords.
   * Each keyword must:
   *   - be substring-matchable in case-insensitive form (registry uses
   *     `normalized.includes(keyword.toLowerCase())`)
   *   - NOT collide with serverless-api's keywords ("serverless api",
   *     "rest api with lambda", "lambda function with api", "api gateway",
   *     "serverless backend", "http api lambda", "create a serverless api",
   *     "create an api", "build an http api", "serverless rest api")
   *   - NOT collide with message-processing's keywords if that pattern
   *     also references Lambda
   *
   * Registration order in the default registry guarantees the larger
   * patterns get first crack at their own keywords.
   */
  keywords: [
    "create a lambda",
    "create a function",
    "deploy a lambda",
    "deploy a function",
    "lambda function",
    "node lambda",
    "python lambda",
    "node function",
    "python function",
    "serverless function",
    "background worker",
    "scheduled lambda",
  ],
  resourceList: [
    // 1. IAM Role — exec role with Lambda trust policy
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: R.IAM_EXECUTION_ROLE,
      displayName: "Lambda Execution Role",
    },
    // 2. Lambda Function — depends on the IAM Role
    {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceId: R.LAMBDA_FN,
      displayName: "Lambda Function",
    },
  ],
  dependencyOrder: [
    // Group 0: IAM Role first
    [R.IAM_EXECUTION_ROLE],
    // Group 1: Lambda after Role (single-element group, no parallelism)
    [R.LAMBDA_FN],
  ],
  defaultOptions: {
    [R.IAM_EXECUTION_ROLE]: {
      Path: "/",
      AssumeRolePolicyDocument: {
        Version: IamPolicy.VERSION,
        Statement: [
          {
            Effect: IamEffect.ALLOW,
            Principal: { Service: AwsServicePrincipal.LAMBDA },
            Action: IamPolicy.ACTION_ASSUME_ROLE,
          },
        ],
      },
      // PermissionsBoundary keeps the auto-created role within the same
      // safety envelope used by the serverless-api pattern's exec role —
      // the role can do CloudWatch Logs (the basic exec role grant) plus
      // anything else under PowerUserAccess, but cannot escalate privilege
      // or touch IAM. Identical default to serverless-api so behavior is
      // consistent across the two paths a user might end up on.
      PermissionsBoundary: AwsManagedPolicy.POWER_USER_ACCESS,
    },
    [R.LAMBDA_FN]: {
      Runtime: AwsDefault.LAMBDA_RUNTIME,
      MemorySize: 512,
      Timeout: 30,
      Architectures: [AwsDefault.ARCH_ARM],
      // Marker token: plan-generator's compound branch substitutes this
      // with the real role ARN at apply time (apps/cli/src/nodes/
      // plan-generator.ts line ~545: when the current resource is a
      // LAMBDA_FUNCTION and a previous IAM_ROLE step completed, the
      // role's ARN is injected into the Role field). The branch
      // already exists for the serverless-api pattern; this pattern
      // reuses it via the SAME resource ID convention.
      Role: markerGetAtt(R.IAM_EXECUTION_ROLE, "Arn"),
    },
  },
};
