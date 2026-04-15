/**
 * Reserved environment variable prefixes that the Lambda runtime sets
 * automatically. Setting these in Environment.Variables produces silently
 * wrong behavior — CFN accepts them but the runtime will either overwrite
 * them at invocation time or refuse to start the function.
 *
 * Sources:
 *   - https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html#configuration-envvars-runtime
 *   - Item 3b (2026-04-09): these were previously accepted silently by
 *     the wizard and would surface as mystery bugs at runtime.
 */
export const LAMBDA_RESERVED_PREFIXES = [
  "AWS_",
  "LAMBDA_",
  "_X_AMZN_",
] as const;

/**
 * Reserved environment variable exact names (not prefix-matched).
 *
 * `NODE_OPTIONS` is not strictly reserved by the Lambda runtime, but it is
 * a near-universal footgun — users pass common things like
 * `--max-old-space-size` and it conflicts with the runtime's internal V8
 * flags. Blocking it with a guide message is safer than silently accepting
 * and debugging later.
 */
export const LAMBDA_RESERVED_EXACT = ["_HANDLER", "NODE_OPTIONS"] as const;

/**
 * Validates a single Environment.Variables key against Lambda's reserved
 * prefixes/names. Returns a user-facing error string when the key is
 * reserved, or `undefined` when acceptable. Exported so both the wizard
 * `validate` hook and the `toCfn` emitter can share detection logic.
 */
export function checkLambdaEnvVarKey(key: string): string | undefined {
  for (const prefix of LAMBDA_RESERVED_PREFIXES) {
    if (key.startsWith(prefix)) {
      if (prefix === "AWS_") {
        return `"${key}" uses the AWS_ prefix, which the Lambda runtime reserves for itself (e.g. AWS_REGION, AWS_LAMBDA_FUNCTION_NAME). Lambda sets these automatically — remove it or rename your variable.`;
      }
      if (prefix === "LAMBDA_") {
        return `"${key}" uses the LAMBDA_ prefix, which the Lambda runtime reserves (e.g. LAMBDA_TASK_ROOT, LAMBDA_RUNTIME_DIR). Rename your variable.`;
      }
      return `"${key}" uses the _X_AMZN_ prefix, which AWS X-Ray and the Lambda runtime use for trace propagation (e.g. _X_AMZN_TRACE_ID). Rename your variable.`;
    }
  }
  for (const exact of LAMBDA_RESERVED_EXACT) {
    if (key === exact) {
      if (exact === "_HANDLER") {
        return `"_HANDLER" is set by the Lambda runtime to your function's handler path — overwriting it will break function startup. Remove it.`;
      }
      return `"NODE_OPTIONS" is a Node.js runtime footgun — Lambda's Node runtimes already set internal V8 flags, and user-provided NODE_OPTIONS frequently collide with them. If you need a flag like --max-old-space-size, configure MemorySize instead.`;
    }
  }
  return undefined;
}

/**
 * Validator for the Environment.Variables wizard field. Parses the
 * "KEY=VALUE,KEY=VALUE" string and verifies every key is well-formed,
 * unique, and not reserved.
 */
export function validateEnvironmentField(value: unknown): string | undefined {
  if (!value) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  const pairs = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const seenKeys = new Set<string>();
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) return `Invalid pair "${pair}" — must be KEY=VALUE format`;
    const key = pair.slice(0, eqIdx).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
      return `Invalid key "${key}" — must start with a letter or underscore and contain only alphanumerics/underscores`;
    if (seenKeys.has(key))
      return `Duplicate key "${key}" — each environment variable name must be unique (case-sensitive).`;
    seenKeys.add(key);
    const reservedError = checkLambdaEnvVarKey(key);
    if (reservedError) return reservedError;
  }
  return undefined;
}

/** toCfn emitter for the Environment field — builds a Variables object. */
export function environmentToCfn(value: unknown): unknown {
  if (!value || typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const vars: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      vars[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  return Object.keys(vars).length > 0 ? { Variables: vars } : undefined;
}
