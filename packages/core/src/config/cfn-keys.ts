// KEEP: stable import surface. 124 consumers across 4 packages as of Epic 56 it1.
// Barrel-over-barrel pattern is load-bearing; do NOT inline into parent barrel.
// WONTFIX: L7-006 closed by rationale, not refactor.
/**
 * CloudFormation property key constants — single source of truth.
 * Use these instead of raw strings in plugins, decomposers, and graph nodes.
 *
 * This file is now a pure barrel re-export. Implementation lives under
 * `./cfn-keys/` split by concern:
 *   - `paths.ts`        — on-disk ASSIGNEE_DIR + CACHE_DIR_NAME
 *   - `keys-core.ts`    — CfnKey entries for core services (shared, S3, EC2,
 *                          RDS, Lambda, DynamoDB, SQS, SNS)
 *   - `keys-services.ts`— CfnKey entries for the second-tier services
 *                          (CloudWatch, Logs, IAM, SG, ELBv2, APIGW, etc.)
 *   - `keys-wizard.ts`  — wizard-only / plan-assembly / CFN registry keys
 *   - `keys.ts`         — merged CfnKey + CfnKeyType + EIP_AUTO_ALLOCATE +
 *                          AssigneeTag
 *   - `defaults.ts`     — ResourceDefault / AwsDefault / UNKNOWN_FALLBACK /
 *                          AWS_SERVICE_EXECUTE_API
 *   - `display.ts`      — RdsEngineDisplay / CloudWatchStatistic / AmiOs /
 *                          RdsEngineId / SizeLabel / RDS_ENGINE_VERSION_HINT /
 *                          WorkloadProfileKey
 *
 * @see Story 42.9 / 42.10
 */

export * from "./cfn-keys/index.js";
