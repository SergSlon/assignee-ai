/**
 * URL validator for external endpoint env vars (W5-03, P007-tech → L4-S09).
 *
 * Policy: only HTTPS or http://localhost is accepted for external service URLs.
 * Plaintext HTTP to non-localhost IPs/hostnames is rejected to prevent
 * credentials from being transmitted in the clear. Arbitrary schemes (ftp://,
 * ws://, etc.) are also rejected.
 *
 * Callers:
 *   - ASSIGNEE_SAAS_URL  — allowLocalhostHttp: false (SaaS must be HTTPS)
 *   - OLLAMA_BASE_URL    — allowLocalhostHttp: true  (local Ollama is HTTP)
 */

export interface UrlValidationOpts {
  /** When true, http://localhost and http://127.0.0.1 URLs are permitted. */
  allowLocalhostHttp: boolean;
}

export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
}

/** Hostnames considered localhost (IPv4 loopback + ::1 IPv6 loopback). */
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isLocalhostUrl(parsed: URL): boolean {
  return LOCALHOST_HOSTNAMES.has(parsed.hostname);
}

/**
 * Validates a URL string against the Assignee URL allowlist policy.
 *
 * Returns `{ valid: true }` on success or `{ valid: false, reason: "<msg>" }`
 * on failure — never throws. Callers that need an exception can do:
 *   `const r = validateUrl(url, opts); if (!r.valid) throw new Error(r.reason);`
 */
export function validateUrl(
  url: string,
  opts: UrlValidationOpts,
): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      valid: false,
      reason: `"${url}" is not a valid URL`,
    };
  }

  const scheme = parsed.protocol; // includes trailing ":"

  if (scheme === "https:") {
    // HTTPS always accepted.
    return { valid: true };
  }

  if (scheme === "http:") {
    if (opts.allowLocalhostHttp && isLocalhostUrl(parsed)) {
      // http://localhost (or http://127.0.0.1) — allowed when caller opts in.
      return { valid: true };
    }
    const hint = opts.allowLocalhostHttp
      ? "only https:// (or http://localhost) accepted"
      : "only https:// accepted";
    return {
      valid: false,
      reason: `"${url}" rejected: ${hint}`,
    };
  }

  // Any other scheme (ftp://, ws://, file://, etc.) — rejected.
  return {
    valid: false,
    reason: `"${url}" rejected: only https:// (or http://localhost) accepted`,
  };
}

/**
 * Validates `url` and throws an actionable `Error` when invalid.
 * Convenience wrapper for call sites that prefer exceptions to Result types.
 *
 * @param url     - The URL string to validate.
 * @param envVar  - The environment variable name, used in the error message.
 * @param opts    - Validation options.
 */
export function assertValidUrl(
  url: string,
  envVar: string,
  opts: UrlValidationOpts,
): void {
  const result = validateUrl(url, opts);
  if (!result.valid) {
    throw new Error(
      `${result.reason ?? `"${url}" is not a valid URL`} for ${envVar}`,
    );
  }
}
