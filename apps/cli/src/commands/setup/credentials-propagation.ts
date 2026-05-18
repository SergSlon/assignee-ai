/**
 * IAM credential propagation-wait helper for `assignee dev setup`.
 *
 * After `iam:CreateAccessKey` returns, the new keys may take 5-30 seconds
 * to propagate to AWS's IAM data plane. This helper polls `sts:GetCallerIdentity`
 * with the fresh credentials using Fibonacci-ish back-off until the keys are
 * usable or the retry budget is exhausted.
 *
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_general.html#troubleshoot_general_eventual-consistency
 */

import * as clack from "@clack/prompts";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

export interface PropagationOpts {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string; // for STS short-term creds (rare in setup)
  region: string;
  userLabel: string; // e.g. "assignee-operator" — for log/spinner messages
  maxAttempts?: number; // default 6
  initialDelayMs?: number; // default 2000
}

export interface PropagationResult {
  succeeded: boolean;
  attemptsUsed: number;
  totalWaitMs: number;
  lastError?: string;
}

/**
 * Delays are: 2s, 3s, 5s, 8s, 13s, 13s (Fibonacci-ish, capped at 13s).
 * Total worst-case wait: 2+3+5+8+13+13 = 44s for 6 attempts (we sleep BEFORE
 * each attempt to avoid a "no wait" first call that would always fail against
 * very fresh keys).
 *
 * Per the spec the initial wait is 2000ms. The sequence is pre-computed so
 * tests can verify the exact backoff pattern.
 */
const FIBONACCI_DELAYS_MS = [2000, 3000, 5000, 8000, 13000, 13000] as const;

/**
 * Error names / message fragments that indicate AWS-side eventual-consistency
 * (i.e., the key was created but hasn't propagated to the data plane yet).
 * All other errors are treated as real failures and cause a fast-exit.
 */
const EVENTUAL_CONSISTENCY_MARKERS = [
  "InvalidClientTokenId",
  "security token",
  "not authorized to perform: sts:GetCallerIdentity",
  "InvalidAccessKeyId",
] as const;

function isEventualConsistencyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name ?? "";
  const msg = err.message ?? "";
  return EVENTUAL_CONSISTENCY_MARKERS.some(
    (marker) =>
      name.includes(marker) || msg.toLowerCase().includes(marker.toLowerCase()),
  );
}

/** Promisified sleep — tests replace with vi.useFakeTimers(). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `sts:GetCallerIdentity` with the provided credentials until the call
 * succeeds or the retry budget is exhausted.
 *
 * - On success → `{ succeeded: true, attemptsUsed, totalWaitMs }`.
 * - On timeout (all attempts threw eventual-consistency errors) →
 *   `{ succeeded: false, attemptsUsed: maxAttempts, lastError }`.
 * - On a non–eventual-consistency error → fail fast on the first occurrence:
 *   `{ succeeded: false, attemptsUsed: 1, lastError }`.
 */
export async function waitForCredentialPropagation(
  opts: PropagationOpts,
): Promise<PropagationResult> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const delays = FIBONACCI_DELAYS_MS.slice(0, maxAttempts);

  // Construct a fresh STS client scoped to the NEW credentials.
  // NEVER use the default provider chain here — we must test these specific keys.
  const stsClient = new STSClient({
    region: opts.region,
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
    },
  });

  const sp = clack.spinner();
  sp.start(
    `Verifying ${opts.userLabel} credentials are usable... (attempt 1/${maxAttempts})`,
  );

  let totalWaitMs = 0;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Sleep before each attempt — keys are never immediately available.
    const delayMs = delays[attempt - 1] ?? 13000;
    await sleep(delayMs);
    totalWaitMs += delayMs;

    try {
      await stsClient.send(new GetCallerIdentityCommand({}));
      sp.stop(
        `✓ ${opts.userLabel} credentials verified (attempt ${attempt}/${maxAttempts})`,
      );
      return { succeeded: true, attemptsUsed: attempt, totalWaitMs };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);

      if (!isEventualConsistencyError(err)) {
        // Non–eventual-consistency error: real problem — fail fast.
        sp.stop(
          `✗ ${opts.userLabel} credential verification failed (non-transient error)`,
        );
        return {
          succeeded: false,
          attemptsUsed: attempt,
          totalWaitMs,
          lastError,
        };
      }

      // Eventual-consistency: update spinner and retry.
      if (attempt < maxAttempts) {
        sp.message(
          `Verifying ${opts.userLabel} credentials are usable... (attempt ${attempt + 1}/${maxAttempts})`,
        );
      }
    }
  }

  // All attempts exhausted with eventual-consistency errors.
  sp.stop(
    `⚠ ${opts.userLabel} credential propagation timed out after ${maxAttempts} attempts`,
  );
  return {
    succeeded: false,
    attemptsUsed: maxAttempts,
    totalWaitMs,
    lastError,
  };
}
