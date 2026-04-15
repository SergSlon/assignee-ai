/**
 * Fields whose values must NEVER be displayed in plaintext.
 * These are masked with asterisks in all user-facing output.
 * @see SECURITY-AUDIT.md — SEC-02 Sensitive field exposure
 */
import { CfnKey } from "@assignee/core";

export const SENSITIVE_FIELDS: Set<string> = new Set([
  CfnKey.MASTER_USER_PASSWORD,
  CfnKey.SECRET_STRING,
  CfnKey.PASSWORD,
  CfnKey.ACCESS_KEY,
  CfnKey.SECRET_ACCESS_KEY,
  CfnKey.SESSION_TOKEN,
]);
