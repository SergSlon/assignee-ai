/**
 * Checkpoint secret redaction — allowlist-based masking of sensitive
 * property names plus defense-in-depth AKIA-pattern scrubbing.
 *
 * Extracted from apps/cli during Wave-6c; promoted to @assignee/core by
 * Story 50-4 so apps/mcp-server and apps/cli share one copy. Preserves
 * the exact redaction semantics documented in SECURITY-AUDIT SEC-02 /
 * H17.
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
 * Lowercase-normalized copy of SENSITIVE_KEY_NAMES for case-insensitive
 * matching (M-α-007). CFN schemas are PascalCase, but operator-submitted
 * payloads may use lowercase or ALLCAPS variants. We preserve the original
 * SENSITIVE_KEY_NAMES set for exact-match fast path and fall back to
 * this lowercase set for non-standard casings.
 *
 * Invariant: SENSITIVE_KEY_NAMES is NOT modified; this is an additive set.
 */
const SENSITIVE_KEY_NAMES_LOWER: ReadonlySet<string> = new Set(
  [...SENSITIVE_KEY_NAMES].map((k) => k.toLowerCase()),
);

/**
 * Pattern for AWS access key identifiers (AKIA = long-term IAM access keys,
 * ASIA = STS short-term session credentials). Used with `.replace()` so that
 * only the matched key-ID substring is replaced, preserving surrounding
 * context (e.g. a log message "Using key AKIAIOSFODNN7EXAMPLE for S3" becomes
 * "Using key [REDACTED] for S3" rather than replacing the entire string).
 *
 * The `g` flag ensures all occurrences in a single string are replaced (M-α-005).
 *
 * We deliberately do NOT try to match the 40-char base64 secret-access-key
 * shape: it is too generic and would false-positive on bucket names, ARNs,
 * and other long opaque identifiers.
 *
 * IMPORTANT: Because this is a module-level regex with the `g` flag, never
 * use `.test()` on it without resetting `.lastIndex = 0` first — `.test()`
 * advances `lastIndex` and alternating `.test()` / `.replace()` calls produce
 * incorrect results. Instead, use `.replace()` directly and detect changes via
 * `replaced !== value`. This avoids all `lastIndex` statefulness issues.
 */
const AKIA_PATTERN_G = /A[KS]IA[0-9A-Z]{16}/g;

// ── SEC-007: Multi-provider secret patterns for checkpoint redaction ──────
//
// These mirror the patterns in `utils/redact.ts` so that CFN desiredState
// objects routed through `redactSensitiveFields` are equally protected.
// Both files must be kept in sync when new patterns are added.
//
// See `utils/redact.ts` for full provider rationale.

/** Anthropic API key: sk-ant-api03-... or sk-ant-... */
const ANTHROPIC_KEY_PATTERN_G = /sk-ant-[A-Za-z0-9_-]{20,}/g;

/** OpenAI project key (sk-proj-...) */
const OPENAI_KEY_PATTERN_G = /sk-(?:proj-)[A-Za-z0-9_-]{20,}/g;

/** GitHub classic PAT (ghp_), OAuth token (gho_), fine-grained PAT (github_pat_) */
const GITHUB_TOKEN_PATTERN_G = /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/g;

/** Slack bot token (xoxb-) and user token (xoxp-) */
const SLACK_TOKEN_PATTERN_G = /xox[bp]-[A-Za-z0-9-]{10,}/g;

/** Google AI / Cloud API key: AIza + 35 URL-safe base64 chars */
const GOOGLE_AI_KEY_PATTERN_G = /AIza[0-9A-Za-z_-]{35}/g;

/**
 * JWT prefix guard — base64url-encoded header eyJ, followed by payload + optional signature.
 * Stops at whitespace; requires at least one dot separator to distinguish from random base64.
 */
const JWT_PATTERN_G = /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}/g;

// ── SEC-044: Recursion / size guards ─────────────────────────────────────

/**
 * Maximum object nesting depth accepted by `redactSensitiveFields`.
 * Exceeding this limit throws `CheckpointRedactionError` to prevent
 * adversarial payloads from causing a stack overflow.
 */
const MAX_REDACTION_DEPTH = 32;

/**
 * Maximum total node (key) count processed by `redactSensitiveFields`
 * across the entire recursive walk. Exceeding this throws
 * `CheckpointRedactionError`. Prevents CPU / memory exhaustion on
 * payloads with thousands of keys (e.g. a malicious desiredState blob).
 */
const MAX_REDACTION_NODES = 10_000;

/**
 * Error thrown when `redactSensitiveFields` encounters a payload that
 * exceeds the depth or node-count safety limits (SEC-044).
 */
export class CheckpointRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointRedactionError";
  }
}

/** Value used to mask redacted fields. */
export const REDACTED_VALUE = "[REDACTED]";

/**
 * Recursively redact sensitive keys and secret-pattern values from a
 * desiredState record. Walks arrays and nested objects. Pure — returns a new
 * object rather than mutating the input.
 *
 * SEC-044: enforces `MAX_REDACTION_DEPTH` and `MAX_REDACTION_NODES` to
 * prevent stack overflow and CPU exhaustion on adversarial payloads. Both
 * limits throw `CheckpointRedactionError` with a descriptive message.
 *
 * @param state  - The CFN desiredState record to redact.
 * @param _depth - Internal recursion depth counter (do not pass from callers).
 * @param _nodes - Shared mutable node-count box (do not pass from callers).
 */
export function redactSensitiveFields(
  state: Record<string, unknown>,
  _depth = 0,
  _nodes: { count: number } = { count: 0 },
): Record<string, unknown> {
  if (_depth > MAX_REDACTION_DEPTH) {
    throw new CheckpointRedactionError(
      `redactSensitiveFields: exceeded maximum nesting depth (${MAX_REDACTION_DEPTH}). ` +
        "This is a safety guard against adversarial deep-nested payloads (SEC-044).",
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    _nodes.count++;
    if (_nodes.count > MAX_REDACTION_NODES) {
      throw new CheckpointRedactionError(
        `redactSensitiveFields: exceeded maximum node count (${MAX_REDACTION_NODES}). ` +
          "This is a safety guard against adversarial wide payloads (SEC-044).",
      );
    }
    if (
      SENSITIVE_KEY_NAMES.has(key) ||
      SENSITIVE_KEY_NAMES_LOWER.has(key.toLowerCase())
    ) {
      result[key] = REDACTED_VALUE;
      continue;
    }
    result[key] = redactValue(value, _depth + 1, _nodes);
  }
  return result;
}

/**
 * Recursively redact a value. Scalars that match any known secret pattern
 * are masked. Objects and arrays are walked element-by-element.
 *
 * SEC-007: in addition to AKIA/ASIA, also scrubs Anthropic, OpenAI, GitHub,
 * Slack, Google AI, and JWT patterns from free-form string values.
 *
 * @param value  - The value to inspect.
 * @param _depth - Current nesting depth (forwarded from redactSensitiveFields).
 * @param _nodes - Shared mutable node-count box.
 */
function redactValue(
  value: unknown,
  _depth: number,
  _nodes: { count: number },
): unknown {
  if (typeof value === "string") {
    // Use .replace() directly (not .test()) to avoid lastIndex statefulness
    // with global regexes. Substring replacement preserves surrounding
    // context — only the matched secret token is masked (M-α-005).
    let v = value;
    v = v.replace(AKIA_PATTERN_G, REDACTED_VALUE);
    v = v.replace(ANTHROPIC_KEY_PATTERN_G, REDACTED_VALUE);
    v = v.replace(OPENAI_KEY_PATTERN_G, REDACTED_VALUE);
    v = v.replace(GITHUB_TOKEN_PATTERN_G, REDACTED_VALUE);
    v = v.replace(SLACK_TOKEN_PATTERN_G, REDACTED_VALUE);
    v = v.replace(GOOGLE_AI_KEY_PATTERN_G, REDACTED_VALUE);
    v = v.replace(JWT_PATTERN_G, REDACTED_VALUE);
    return v;
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactValue(element, _depth, _nodes));
  }
  if (value && typeof value === "object") {
    return redactSensitiveFields(
      value as Record<string, unknown>,
      _depth,
      _nodes,
    );
  }
  return value;
}

/**
 * Remove fields with "[REDACTED]" values from a desiredState record.
 * Recurses into nested objects and arrays. Prevents sending placeholder
 * strings to AWS on checkpoint resume — AWS will use defaults (e.g.,
 * auto-generated passwords) for omitted fields.
 *
 * Array handling:
 *   - Elements equal to REDACTED_VALUE are removed from the output array.
 *   - Object elements are recursed into (their REDACTED fields stripped).
 *   - Nested arrays are recursed into as well.
 *   - Other scalar elements (numbers, booleans, etc.) are kept as-is.
 */
export function stripRedactedFields(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === REDACTED_VALUE) continue;
    if (Array.isArray(value)) {
      result[key] = stripRedactedArray(value);
    } else if (value && typeof value === "object") {
      result[key] = stripRedactedFields(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Recursively strip REDACTED_VALUE elements from an array.
 * Elements equal to REDACTED_VALUE are removed entirely.
 * Object elements are recursed into via stripRedactedFields.
 * Nested array elements are recursed into recursively.
 * Other scalars are kept as-is.
 */
function stripRedactedArray(arr: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const element of arr) {
    if (element === REDACTED_VALUE) continue;
    if (Array.isArray(element)) {
      result.push(stripRedactedArray(element));
    } else if (element && typeof element === "object") {
      result.push(stripRedactedFields(element as Record<string, unknown>));
    } else {
      result.push(element);
    }
  }
  return result;
}
