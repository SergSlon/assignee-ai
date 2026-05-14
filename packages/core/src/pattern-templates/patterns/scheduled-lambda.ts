/**
 * Scheduled Lambda compound pattern — a time-triggered function that
 * fires on an EventBridge schedule (rate or cron expression).
 *
 * Bare "scheduled lambda" / "cron lambda" / "nightly cleanup"
 * intents previously had no compound answer — the user got routed to
 * `lambda-with-exec-role` which produced only the IAM role + Lambda
 * and left the scheduling piece as a manual post-apply task. With
 * this pattern, a plain "create a scheduled lambda" intent now
 * produces a 4-resource compound:
 *
 *   1. IAM Role — Lambda execution role (Lambda trust policy,
 *      PowerUserAccess PermissionsBoundary, Basic exec role
 *      equivalent via the auto-role-injection branch)
 *   2. Lambda Function — the work target, with Role wired to #1
 *      via markerGetAtt, arm64 Graviton architecture, a placeholder
 *      ZipFile handler that the user replaces post-apply
 *   3. EventBridge Rule — fires every hour by default, with an
 *      inline Target referencing the Lambda's ARN, ENABLED state
 *   4. Lambda Permission — display-only (provisionable: false)
 *      granting events.amazonaws.com the invoke action on the
 *      Lambda. CCAPI cannot create AWS::Lambda::Permission directly
 *      (it's in CCAPI_REDIRECT_TYPES pointing at
 *      AWS::Lambda::PermissionPolicy), so this lives as a display-
 *      only item in the plan box — the same convention used by
 *      serverless-api.
 *
 * Why not add the Lambda Permission via PermissionPolicy? The A6
 * migration shipped the redirect table but the PermissionPolicy
 * CCAPI handler has known gaps with Action/Principal on scheduled
 * rules. The cleaner path is a post-apply `aws lambda add-permission`
 * which works against any CCAPI-compatible account without a
 * separate resource type.
 *
 * Registration order: registered AFTER serverless-api, three-tier-web,
 * message-processing, container-service, static-website, and
 * efs-with-vpc, but BEFORE lambda-with-exec-role — so "scheduled
 * lambda" matches this pattern first but plain "create a lambda"
 * still hits lambda-with-exec-role.
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import { markerGetAtt, markerRef } from "../../config/marker-tokens.js";
import { IamEffect } from "../../config/iam-effects.js";
import {
  AwsManagedPolicy,
  awsManagedPolicyArn,
  IamPolicy,
  AwsServicePrincipal,
} from "../../config/aws-arns.js";
import type { ArchitecturePattern } from "../types.js";
import { ScheduledLambdaResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

const LAMBDA_PERMISSION_TYPE = "AWS::Lambda::Permission";

export const scheduledLambdaPattern: ArchitecturePattern = {
  patternId: PatternId.SCHEDULED_LAMBDA,
  displayName: "Scheduled Lambda (EventBridge cron)",
  /**
   * Keywords must not collide with lambda-with-exec-role's "scheduled
   * lambda" keyword — this pattern MUST register BEFORE
   * lambda-with-exec-role so the collision favors this pattern. The
   * "scheduled lambda" + "cron lambda" + "nightly job" family all
   * imply EventBridge scheduling and benefit from the full 4-resource
   * compound.
   */
  keywords: [
    "scheduled lambda",
    "cron lambda",
    "periodic lambda",
    "nightly lambda",
    "nightly job",
    "nightly cleanup",
    "cron job",
    "scheduled task",
    "recurring lambda",
    "recurring job",
    "eventbridge scheduled lambda",
    "timer lambda",
    // Epic 92 wave 2.b (finding C-07): colloquial scheduling triggers
    // the previous keyword set missed. Each phrase strongly implies
    // a time-based schedule and should route to this 4-resource
    // EventBridge compound rather than the 2-resource
    // lambda-with-exec-role pattern.
    //
    // Both hyphenated and space-separated forms are listed so either
    // "runs-every 5 minutes" or "runs every 5 minutes" catches.
    "runs-every",
    "runs every",
    "every-hour",
    "every hour",
    "every-day",
    "every day",
    "hourly",
    "daily",
    "on-a-schedule",
    "on a schedule",
    // SX-1 (2026-05-13, PH1-H-1 BLOCKER): bare EventBridge rule phrasing
    // that does NOT contain "lambda" — users asking for a bare rule get
    // routed here for the 4-resource compound instead of receiving a
    // target-less AWS::Events::Rule with a CRITICAL finding.
    "eventbridge rule",
    "fires every",
    "fires at",
    "trigger every",
  ],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: R.IAM_EXECUTION_ROLE,
      displayName: "Lambda Execution Role",
    },
    {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      resourceId: R.LAMBDA_FN,
      displayName: "Lambda Function",
    },
    {
      resourceType: RESOURCE_TYPES.EVENTS_RULE,
      resourceId: R.SCHEDULE_RULE,
      displayName: "EventBridge Schedule Rule",
    },
    {
      // AWS::Lambda::Permission is in CCAPI_REDIRECT_TYPES —
      // non-provisionable by this pattern. Displayed in the plan box
      // so the user sees the full surface area, marked for manual
      // post-apply configuration via `aws lambda add-permission` or
      // equivalent. Same convention as serverless-api.
      resourceType: LAMBDA_PERMISSION_TYPE,
      resourceId: R.INVOKE_PERMISSION,
      displayName: "EventBridge → Lambda Permission",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    // Group 0: IAM role first
    [R.IAM_EXECUTION_ROLE],
    // Group 1: Lambda function (needs Role ARN via markerGetAtt)
    [R.LAMBDA_FN],
    // Group 2: Schedule rule (needs Lambda ARN in Target.Arn)
    [R.SCHEDULE_RULE],
    // Group 3: display-only permission — no actual provisioning,
    // but kept in dependencyOrder for display ordering consistency
    [R.INVOKE_PERMISSION],
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
      // ManagedPolicyArns grants the minimal CloudWatch Logs permissions
      // required for any Lambda to write execution logs. PermissionsBoundary
      // CAPS the maximum permission set but does NOT GRANT any permissions.
      // Commercial-partition ARN; rewriteManagedPolicyArnsForPartition() in
      // compound-plan.ts rewrites this to the correct partition at apply time.
      // (CP-4 / PH1-D-2 fix)
      ManagedPolicyArns: [
        awsManagedPolicyArn(
          "aws",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
      ],
      // Commercial-partition ARN; rewriteManagedPolicyArnsForPartition() in
      // compound-plan.ts rewrites this to the correct partition at apply time.
      PermissionsBoundary: awsManagedPolicyArn(
        "aws",
        AwsManagedPolicy.POWER_USER_ACCESS_PATH,
      ),
    },
    [R.LAMBDA_FN]: {
      Runtime: AwsDefault.LAMBDA_RUNTIME,
      MemorySize: 512,
      Timeout: 30,
      Architectures: [AwsDefault.ARCH_ARM],
      // Placeholder handler — user replaces after apply
      Code: {
        ZipFile:
          "exports.handler = async (event) => { console.log('scheduled invocation', event.time); return { ok: true }; };",
      },
      Handler: AwsDefault.LAMBDA_HANDLER,
      // Wired by plan-generator's compound role-injection branch —
      // same mechanism used by serverless-api and lambda-with-exec-role
      Role: markerGetAtt(R.IAM_EXECUTION_ROLE, "Arn"),
    },
    [R.SCHEDULE_RULE]: {
      // Default: fire every hour. The user can override via
      // `--set ScheduleExpression="rate(5 minutes)"` or `cron(...)`.
      // Name is injected by plan-generator's NAME_FIELDS with runId
      // suffix for uniqueness — do not set a static Name here.
      ScheduleExpression: "rate(1 hour)",
      State: "ENABLED",
      Description:
        "Scheduled invocation rule for the assignee-managed Lambda function",
      // 2026-04-12: Targets removed from compound defaultOptions.
      // EventBridge CCAPI CreateResource passes Name as a
      // CharSequence internally — a null Name caused a Java NPE
      // (`"this.text" is null`). Adding an explicit Name field fixes
      // the NPE. Targets are removed because they require the full
      // Lambda ARN but compound completedResources stores bare
      // function names; a future story can add SDK-based PutTargets
      // as a post-apply hook (same pattern as Lambda Permission).
    },
    [R.INVOKE_PERMISSION]: {
      // Display-only — not provisioned. Documents the post-apply
      // manual step: the user must grant events.amazonaws.com the
      // lambda:InvokeFunction permission on this function, scoped
      // to the rule's ARN as the source, before the schedule can
      // actually invoke the Lambda.
      Action: "lambda:InvokeFunction",
      FunctionName: markerGetAtt(R.LAMBDA_FN, "Arn"),
      Principal: "events.amazonaws.com",
      SourceArn: markerRef(R.SCHEDULE_RULE),
    },
  },
};
