/**
 * CloudControl API base actions — granted to every supported
 * resource type regardless of service.
 *
 * Split out of `iam-actions.ts` for SRP / file-size compliance.
 */

export const CCAPI_BASE_ACTIONS: readonly string[] = [
  "cloudcontrol:CreateResource",
  "cloudcontrol:GetResource",
  "cloudcontrol:GetResourceRequestStatus",
  "cloudcontrol:UpdateResource",
  "cloudcontrol:DeleteResource",
  // CloudControl API maps internally to CloudFormation — some accounts
  // require these actions under the cloudformation namespace
  "cloudformation:GetResource",
  "cloudformation:GetResourceRequestStatus",
  "cloudformation:CreateResource",
  "cloudformation:DeleteResource",
  "cloudformation:UpdateResource",
] as const;
