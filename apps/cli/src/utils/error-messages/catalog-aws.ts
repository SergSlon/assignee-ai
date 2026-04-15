/** AWS provisioning error message catalog. */

import { AwsErrorName } from "../../constants/aws-errors.js";
import { EXAMPLE_S3_INTENT } from "../../config/constants.js";
import { PROVISIONING_ERROR_CODES } from "@assignee/core";
import type { ErrorMessageEntry } from "./types.js";

export const AWS_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [PROVISIONING_ERROR_CODES.ALREADY_EXISTS]: {
    code: PROVISIONING_ERROR_CODES.ALREADY_EXISTS,
    what: "A resource with this name already exists in your AWS account.",
    why: "AWS rejected the create request because an identical resource identifier is already in use.",
    howToFix: `Choose a different resource name in your intent, or run \`assignee plan\` with a unique name (e.g., "${EXAMPLE_S3_INTENT}-v2").`,
  },
  [PROVISIONING_ERROR_CODES.NOT_FOUND]: {
    code: PROVISIONING_ERROR_CODES.NOT_FOUND,
    what: "The target resource was not found in AWS.",
    why: "The resource was deleted or never created. This can happen if the plan is stale or the resource was removed outside of assignee.ai.",
    howToFix:
      "Re-run `assignee plan` to generate a fresh plan against the current state of your AWS account{?account: (account {account})}{?region: in region {region}}.",
  },
  [PROVISIONING_ERROR_CODES.THROTTLED]: {
    code: PROVISIONING_ERROR_CODES.THROTTLED,
    what: "AWS is rate-limiting your requests.",
    why: "Too many API calls were made in a short period. AWS CloudControl API has per-account request limits.",
    howToFix:
      "Wait 30-60 seconds and retry. If this persists, check your AWS account service quotas at https://console.aws.amazon.com/servicequotas/.",
  },
  [PROVISIONING_ERROR_CODES.STATE_MISMATCH]: {
    code: PROVISIONING_ERROR_CODES.STATE_MISMATCH,
    what: "Resource already exists.",
    why: "A resource with the same identifier already exists in your AWS account.",
    howToFix: "Choose a different name and re-run 'assignee plan'.",
  },
  [PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE]: {
    code: PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE,
    what: "This resource type is not supported by AWS CloudControl API.",
    why: "Some AWS resource types require native SDK calls or have known CCAPI gaps.",
    howToFix:
      "Check the error message for an alternative resource type suggestion. If none is provided, this resource type may not yet be supported by assignee.ai.",
  },
  [AwsErrorName.BUCKET_ALREADY_EXISTS]: {
    code: AwsErrorName.BUCKET_ALREADY_EXISTS,
    what: "An S3 bucket with this name already exists globally.",
    why: "S3 bucket names are globally unique across all AWS accounts. Another account may own this name.",
    howToFix:
      'Choose a more specific bucket name (e.g., "my-company-logs-2026") or add a random suffix.',
  },
  [AwsErrorName.BUCKET_NAME_NOT_AVAILABLE]: {
    code: AwsErrorName.BUCKET_NAME_NOT_AVAILABLE,
    what: "The requested S3 bucket name is not available.",
    why: "The S3 bucket name is already taken by another AWS account. S3 bucket names are globally unique across all AWS accounts.",
    howToFix:
      "Choose a different bucket name and re-run the command. Tip: use a prefix like your org name (e.g., myorg-my-bucket).",
  },
  [AwsErrorName.ACCESS_DENIED_SHORT]: {
    code: AwsErrorName.ACCESS_DENIED_SHORT,
    what: "AWS denied access to perform this operation.",
    why: "The IAM credentials used by assignee.ai lack the required permissions for this resource type or action.",
    howToFix:
      "Verify that the ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY credentials{?profile: for profile {profile}} have the necessary IAM permissions for this action{?account: in account {account}}. Run `assignee setup` to create properly scoped IAM users.",
  },
  [AwsErrorName.INVALID_PARAMETER_VALUE]: {
    code: AwsErrorName.INVALID_PARAMETER_VALUE,
    what: "One or more resource parameters have invalid values.",
    why: "The configuration values in your plan do not meet AWS validation requirements for this resource type.",
    howToFix:
      'Rephrase your intent with valid parameter values. For example, ensure ARNs are correctly formatted and instance types exist in your region (e.g., "t3.micro" instead of "t3.invalid").',
  },
  [AwsErrorName.THROTTLING]: {
    code: AwsErrorName.THROTTLING,
    what: "AWS is throttling your API requests.",
    why: "You have exceeded the AWS API rate limit for this service.",
    howToFix:
      "Wait 30-60 seconds and retry. Consider reducing concurrent operations.",
  },
  [AwsErrorName.RESOURCE_NOT_FOUND]: {
    code: AwsErrorName.RESOURCE_NOT_FOUND,
    what: "The referenced AWS resource does not exist.",
    why: "A resource ARN or identifier in your plan refers to a resource that has been deleted or was never created.",
    howToFix:
      "Verify that all referenced resources (IAM roles, VPCs, subnets, etc.) exist in your AWS account{?account: ({account})} and region{?region: ({region})}. Re-run `assignee plan` to refresh.",
  },
  [AwsErrorName.VALIDATION_EXCEPTION]: {
    code: AwsErrorName.VALIDATION_EXCEPTION,
    what: "AWS request validation failed.",
    why: "The request payload does not conform to the AWS service's validation rules.",
    howToFix:
      "Check your intent for typos or unsupported configuration values. Try simplifying your request and adding parameters incrementally.",
  },
};
