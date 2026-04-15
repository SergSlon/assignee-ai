/**
 * Checkpoint secret redaction — allowlist-based masking of sensitive
 * property names plus defense-in-depth AKIA-pattern scrubbing.
 *
 * Extracted from checkpoint.ts during Wave-6c decomposition. Preserves the
 * exact redaction semantics documented in SECURITY-AUDIT SEC-02 / H17.
 *
 * @see feedback_redaction_allowlist_not_denylist
 */

/**
 * Explicit allowlist of fully-qualified CloudFormation property names that
 * carry secret material. We use an exact-match allowlist (NOT a substring
 * regex) because real CFN schemas contain many legitimate property names
 * that share substrings with sensitive words but are NOT secrets:
 *
 *   - PasswordPolicy            (Cognito UserPool — password complexity rules)
 *   - UserData                  (EC2 instance bootstrap script)
 *   - TokenValidityUnits        (Cognito JWT lifetime descriptor)
 *   - PasswordResetRequired     (IAM LoginProfile flag, NOT the password)
 *   - CredentialReportExpiration (IAM credential report metadata)
 *
 * Redacting these would silently strip critical infrastructure config on
 * checkpoint resume (a Cognito UserPool re-created without password policy,
 * an EC2 instance launched without its bootstrap script, etc.).
 *
 * @see SECURITY-AUDIT.md — SEC-02 / H17 (W2-B regression REG-N1)
 */
const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  // RDS / DocDB / DAX / Workspaces master credentials
  "MasterUserPassword",
  "MasterPassword",
  "AdminPassword",
  "DefaultPassword",
  "DefaultUserPassword",
  // Generic top-level password (IAM LoginProfile, SecretsManager, etc.)
  "Password",
  // Secrets Manager secret payload
  "SecretString",
  // IAM AccessKey / STS session credentials
  "SecretAccessKey",
  "SessionToken",
  // Certificate Manager / Key Pair private key material
  "PrivateKey",
  "PrivateKeyPassphrase",
  "RSAPrivateKey",
  // EKS / cluster bootstrap tokens
  "BootstrapToken",
]);

/**
 * Pattern for AWS access key identifiers (AKIA = long-term IAM access keys,
 * ASIA = STS short-term session credentials). Any string value matching this
 * pattern is redacted regardless of its key name. This is defense-in-depth
 * over the key allowlist — it walks values, so it has no false-positive risk
 * on innocuously-named properties.
 *
 * We deliberately do NOT try to match the 40-char base64 secret-access-key
 * shape: it is too generic and would false-positive on bucket names, ARNs,
 * and other long opaque identifiers.
 */
const AKIA_PATTERN = /A[KS]IA[0-9A-Z]{16}/;

/** Value used to mask redacted fields. */
export const REDACTED_VALUE = "[REDACTED]";

/**
 * Recursively redact sensitive keys and AKIA-pattern values from a
 * desiredState record. Walks arrays and nested objects. Pure — returns a new
 * object rather than mutating the input.
 */
export function redactSensitiveFields(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (SENSITIVE_KEY_NAMES.has(key)) {
      result[key] = REDACTED_VALUE;
      continue;
    }
    result[key] = redactValue(value);
  }
  return result;
}

/**
 * Recursively redact a value. Scalars that match the AKIA pattern are masked.
 * Objects and arrays are walked element-by-element.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return AKIA_PATTERN.test(value) ? REDACTED_VALUE : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v));
  }
  if (value && typeof value === "object") {
    return redactSensitiveFields(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Remove fields with "[REDACTED]" values from a desiredState record.
 * Recurses into nested objects. Prevents sending placeholder strings to AWS
 * on checkpoint resume — AWS will use defaults (e.g., auto-generated
 * passwords) for omitted fields.
 */
export function stripRedactedFields(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === REDACTED_VALUE) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = stripRedactedFields(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
