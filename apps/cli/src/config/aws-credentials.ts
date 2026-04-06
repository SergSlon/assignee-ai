/**
 * Centralized AWS credential resolution for all SDK clients.
 *
 * Re-exports the canonical helper from `@assignee/core` so both apps
 * (cli and mcp-server) share a single source of truth without either
 * one reaching into the other. The helper enforces the IAM 3-user model
 * (operator/reader/auditor) and NEVER falls through to the default AWS
 * credential chain (~/.aws/credentials, SSO, IMDS).
 *
 * @see packages/core/src/config/aws-credentials.ts
 * @see Story 18.8 — IAM Security Overhaul
 */

export {
  requireAssigneeCredentials,
  tryAssigneeCredentials,
  hasAssigneeCredentials,
  MissingAssigneeCredentialsError,
  type AssigneeRole,
  type ExplicitAwsCredentials,
} from "@assignee/core";
