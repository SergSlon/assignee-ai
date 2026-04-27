/**
 * AWS credential provider chain for Assignee.ai operator role.
 *
 * Implements the W2-02 requirement (Epic 100): allow operators to authenticate
 * via AWS_PROFILE / ~/.aws/config SSO entries instead of requiring raw long-term
 * access keys (AKIA*).
 *
 * Priority order (first provider that yields credentials wins):
 *   1. ASSIGNEE_OPERATOR_* env vars (explicit operator credentials — highest precedence)
 *   2. AWS standard env vars (AWS_ACCESS_KEY_ID etc.) — auto-promoted
 *   3. AWS_PROFILE / --profile via fromIni() → covers SSO, assumed-role, etc.
 *   4. Default provider chain (instance metadata, ECS task role, etc.)
 *
 * IMPORTANT: This module uses dynamic imports for @aws-sdk/credential-providers
 * so it does not add a hard peer-dependency to @assignee/core. The package is
 * available transitively via the CLI app's declared dependency.
 *
 * @see W2-02 — AWS_PROFILE via provider chain (Epic 100)
 * @see apps/cli/src/commands/setup/credentials.ts — admin credential variant
 * @see feedback_lazy_credential_resolution_in_mcp.md
 */

import { ProcessEnvConfigAdapter, type ConfigPort } from "./config-port.js";

/** Minimal AWS credential identity shape (mirrors @aws-sdk/types AwsCredentialIdentity). */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export type CredentialProvider = () => Promise<AwsCredentialIdentity>;

/**
 * Result of resolving a credential provider for the operator role.
 *
 * Callers should pass `provider` to SDK client constructors as the
 * `credentials` option — the SDK will call it lazily per-request, which
 * means mid-command session refresh is handled automatically.
 */
export interface OperatorCredentialResult {
  /** AWS SDK v3 credential provider (lazy resolver). */
  provider: CredentialProvider;
  /** Display-friendly source description, e.g. "profile enterprise-sso". */
  source: string;
  /** Profile name, if resolution came from an ini profile. */
  profile?: string;
}

/**
 * Resolve operator credentials using the full provider chain.
 *
 * Priority:
 *   1. ASSIGNEE_OPERATOR_* env vars — returned as a static credential object
 *      (existing behaviour, zero change for current users).
 *   2. AWS standard env vars (AWS_ACCESS_KEY_ID etc.) — same treatment.
 *   3. `profile` argument or AWS_PROFILE env var → fromIni() which covers
 *      static credentials, assumed-role, and SSO profiles.
 *   4. fromNodeProviderChain() — instance metadata, ECS task role, etc.
 *
 * @param profile - Optional profile name (from --profile CLI flag).
 *   When omitted, AWS_PROFILE env var is consulted.
 *
 * @throws Error if no provider could be constructed (should be rare —
 *   fromNodeProviderChain() is always the terminal fallback).
 *
 * This function does NOT eagerly resolve credentials; it returns a provider
 * so SDK clients call it lazily. Per feedback_lazy_credential_resolution_in_mcp:
 * MCP-server credential builders must wrap in try/catch per-server so
 * missing creds on one server don't crash the whole stack.
 */
export async function resolveOperatorCredentialProvider(
  profile?: string,
  config?: ConfigPort,
): Promise<OperatorCredentialResult> {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  // Dynamic import — @aws-sdk/credential-providers is declared in the CLI
  // app's package.json and resolvable via the monorepo's shared node_modules.
  // The "as string" cast bypasses TypeScript's literal-string import-resolution
  // check; runtime resolution succeeds in both the monorepo dev environment
  // and the CLI app bundle.
  const credProviders: Record<string, unknown> = await import(
    "@aws-sdk/credential-providers" as string
  );
  const fromIni = credProviders["fromIni"] as (opts: {
    profile: string;
  }) => CredentialProvider;
  const fromNodeProviderChain = credProviders["fromNodeProviderChain"] as (
    opts?: Record<string, unknown>,
  ) => CredentialProvider;

  // ── Priority 1 & 2: ASSIGNEE_OPERATOR_* or AWS standard env vars ──────────
  // command-runner/credentials.ts auto-promotes AWS_* to ASSIGNEE_OPERATOR_*
  // before any command runs. By the time we get here, if either set is present
  // it's in ASSIGNEE_OPERATOR_*. We therefore check only those vars.
  const assigneeKey = effectiveConfig
    .get("ASSIGNEE_OPERATOR_ACCESS_KEY_ID")
    ?.trim();
  const assigneeSecret = effectiveConfig
    .get("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY")
    ?.trim();
  if (assigneeKey && assigneeSecret) {
    const sessionToken =
      effectiveConfig.get("ASSIGNEE_OPERATOR_SESSION_TOKEN")?.trim() ||
      undefined;
    const staticCreds: AwsCredentialIdentity = {
      accessKeyId: assigneeKey,
      secretAccessKey: assigneeSecret,
      ...(sessionToken ? { sessionToken } : {}),
    };
    const provider: CredentialProvider = async () => staticCreds;
    return {
      provider,
      source: "ASSIGNEE_OPERATOR_* env vars",
    };
  }

  // ── Priority 3: Named profile (--profile flag or AWS_PROFILE) ─────────────
  const resolvedProfile = profile ?? effectiveConfig.get("AWS_PROFILE");
  if (resolvedProfile) {
    const provider = fromIni({ profile: resolvedProfile });
    return {
      provider,
      source: `profile ${resolvedProfile}`,
      profile: resolvedProfile,
    };
  }

  // ── Priority 4: Default provider chain ────────────────────────────────────
  // fromNodeProviderChain includes: env, ini/config, SSO, IMDS, ECS, etc.
  const provider = fromNodeProviderChain({
    clientConfig: {
      region: effectiveConfig.get("AWS_REGION") || "us-east-1",
    },
  });

  return {
    provider,
    source: "default provider chain",
  };
}
