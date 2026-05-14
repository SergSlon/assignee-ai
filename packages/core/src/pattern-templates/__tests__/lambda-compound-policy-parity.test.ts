/**
 * Guard 1 (CP-4 / PH1-D-2) — Lambda compound role-policy parity test.
 *
 * Every pattern whose `resourceList` contains an IAM_ROLE + LAMBDA_FUNCTION
 * sibling pair MUST attach `AWSLambdaBasicExecutionRole` (or equivalent
 * minimal CloudWatch Logs grant) via `ManagedPolicyArns`. Without it,
 * the resulting Lambda has ZERO IAM grants and cannot write to CloudWatch Logs
 * even though `PermissionsBoundary` allows it in principle —
 * PermissionsBoundary CAPS the maximum permission set but does NOT GRANT.
 *
 * Enforcement: iterate ALL patterns in the default registry; for each that
 * has an IAM_ROLE + LAMBDA_FUNCTION sibling pair, assert the IAM role's
 * `defaultOptions.ManagedPolicyArns` is non-empty AND contains the
 * `LAMBDA_BASIC_EXECUTION_PATH` suffix (substring match). Fails with the
 * offending pattern name + suggested fix string.
 *
 * This is a STRUCTURAL guard — it catches a whole class of future regressions,
 * not just the four patterns fixed in CP-4.
 */

import { describe, it, expect } from "vitest";
import { defaultPatternRegistry } from "../index.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { AwsManagedPolicy } from "../../config/aws-arns.js";

const LAMBDA_BASIC_PATH = AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH;

describe("Guard 1 — Lambda compound patterns must attach AWSLambdaBasicExecutionRole", () => {
  it("every pattern with IAM_ROLE + LAMBDA_FUNCTION sibling pair has ManagedPolicyArns containing LAMBDA_BASIC_EXECUTION_PATH", () => {
    const allPatterns = defaultPatternRegistry.list();
    const failures: string[] = [];

    for (const pattern of allPatterns) {
      const resourceTypes = pattern.resourceList.map((r) => r.resourceType);
      const hasIamRole = resourceTypes.includes(RESOURCE_TYPES.IAM_ROLE);
      const hasLambda = resourceTypes.includes(RESOURCE_TYPES.LAMBDA_FUNCTION);

      if (!hasIamRole || !hasLambda) continue;

      // Find the IAM role resource IDs in this pattern
      const iamRoleIds = pattern.resourceList
        .filter((r) => r.resourceType === RESOURCE_TYPES.IAM_ROLE)
        .map((r) => r.resourceId);

      for (const roleId of iamRoleIds) {
        const roleOpts = pattern.defaultOptions[roleId] as
          | Record<string, unknown>
          | undefined;

        if (!roleOpts) {
          failures.push(
            `Pattern "${pattern.patternId}" IAM role "${roleId}": no defaultOptions entry. ` +
              `Fix: add ManagedPolicyArns: [awsManagedPolicyArn("aws", AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH)]`,
          );
          continue;
        }

        const managed = roleOpts["ManagedPolicyArns"];

        if (!Array.isArray(managed) || managed.length === 0) {
          failures.push(
            `Pattern "${pattern.patternId}" IAM role "${roleId}": ` +
              `ManagedPolicyArns is missing or empty. ` +
              `Fix: add ManagedPolicyArns: [awsManagedPolicyArn("aws", AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH)]`,
          );
          continue;
        }

        const hasBasicExec = (managed as string[]).some(
          (arn) => typeof arn === "string" && arn.includes(LAMBDA_BASIC_PATH),
        );

        if (!hasBasicExec) {
          failures.push(
            `Pattern "${pattern.patternId}" IAM role "${roleId}": ` +
              `ManagedPolicyArns does not include "${LAMBDA_BASIC_PATH}". ` +
              `Fix: add awsManagedPolicyArn("aws", AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH) to the array.`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("message-processing pattern is the canonical reference — already has LAMBDA_BASIC_EXECUTION_PATH", async () => {
    const { messageProcessingPattern } =
      await import("../patterns/message-processing.js");
    const lambdaRoleOpts = messageProcessingPattern.defaultOptions[
      "lambda-role"
    ] as Record<string, unknown>;
    const managed = lambdaRoleOpts?.["ManagedPolicyArns"] as string[];
    expect(Array.isArray(managed)).toBe(true);
    expect(managed.some((arn) => arn.includes(LAMBDA_BASIC_PATH))).toBe(true);
  });
});
