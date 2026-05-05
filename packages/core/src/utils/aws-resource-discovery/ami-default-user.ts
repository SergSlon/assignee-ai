/**
 * AMI → default-SSH-user mapping.
 *
 * Sibling of `ec2-amis.ts` (intentionally NOT extended — keeps the
 * existing AMI-discovery file focused on its current responsibility per
 * the SSH-bundle Story iii spec / Winston audit, ref
 * `_bmad-output/implementation-artifacts/ssh-bundle-iii-print-ssh-command.md`).
 *
 * Two public surfaces:
 *
 *   - `getAmiDefaultUser(amiId)` — used by `apply-single.ts` after a
 *     freshly-created EC2 lands so the apply-success line can render a
 *     copy-pasteable `ssh -i ... <user>@<ip>` command. Resolves via a
 *     single DescribeImages call against operator credentials,
 *     in-process cached so a per-CLI invocation re-render never
 *     re-fetches. Throws `AmiIsWindowsError` (defense-in-depth — the
 *     intent resolver in `compound-helpers.ts` should fail-fast on
 *     Windows long before this is called).
 *
 *   - `getAmiPlatformDetails(amiId)` — used by `compound-helpers.ts`
 *     to fail-fast at compound-plan time when a Windows AMI lands in
 *     an SSH-bundle intent. Returns the raw `Image.PlatformDetails`
 *     string (or `null` when discovery fails / no images returned —
 *     callers fall through to "assume non-Windows" rather than block
 *     the apply on a transient AWS API blip).
 *
 * Both helpers share an in-process Map cache keyed on `ami-<id>` so
 * the DescribeImages call happens at most once per CLI invocation —
 * mirrors the `cachedDiscover` contract in `cache.ts`, but uses a
 * separate Map because `cachedDiscover` is shaped for
 * `DiscoveryOption[]` returns whereas this module returns scalars.
 *
 * Mapping table (regex order is load-bearing — first match wins,
 * AL2023 must beat the broader AL2 pattern):
 *
 *   PlatformDetails === "Windows"   → throws `AmiIsWindowsError`
 *   /amzn2023|al2023|amazon-linux-2023/i → "ec2-user"
 *   /amzn2|al2-/i                   → "ec2-user"
 *   /ubuntu/i                       → "ubuntu"
 *   /debian/i                       → "admin"
 *   /rhel|red.?hat/i                → "ec2-user"
 *   /sles|suse/i                    → "ec2-user"
 *   /centos/i                       → "ec2-user"
 *     (Modern CentOS Stream 9 — the live AMI on AWS Marketplace —
 *      uses ec2-user / cloud-user. Only legacy CentOS 6/7 used the
 *      "centos" account, and those releases are EOL; the simpler
 *      unified mapping is fine.)
 *   default                         → "ec2-user" + warn-level hint
 */

import { DescribeImagesCommand } from "@aws-sdk/client-ec2";
import { AWS_REGION } from "../../config/constants/aws.js";
import { tryAssigneeCredentials } from "../../config/aws-credentials.js";
import { createEC2Client } from "../../aws/ec2-client-factory.js";
import { withTimeout } from "../timeout.js";
import { log, LOG_ACTIONS, LogLevel } from "../logger/index.js";
import { DISCOVERY_TIMEOUT_MS } from "./types.js";

/**
 * Defense-in-depth: thrown when caller asks for the SSH user of a
 * Windows AMI. The `compound-helpers.ts` SSH-bundle gate should have
 * fail-fasted long before this; this exists so a stray code path
 * cannot silently render a wrong `ssh -i …` line for Windows.
 */
export class AmiIsWindowsError extends Error {
  public readonly code = "AMI_IS_WINDOWS";
  constructor(public readonly amiId: string) {
    super(
      `AMI ${amiId} is a Windows image — SSH connect rendering must be skipped.`,
    );
    this.name = "AmiIsWindowsError";
  }
}

/** Default SSH user when no mapping rule matched (fall-through). */
export const DEFAULT_SSH_USER_FALLBACK = "ec2-user";

/** Sentinel: PlatformDetails value AWS returns for Windows images. */
export const PLATFORM_DETAILS_WINDOWS = "Windows";

interface AmiMetadata {
  imageId: string;
  name?: string;
  platformDetails?: string;
}

/** In-process cache: key = `ami-<id>`, value = the resolved metadata. */
const metadataCache = new Map<string, AmiMetadata>();

/** Reset cache — used by tests. */
export function clearAmiDefaultUserCache(): void {
  metadataCache.clear();
}

/**
 * Resolve AMI metadata via a single DescribeImages call against
 * operator credentials. Cached per process. Returns `null` on any
 * failure (throttle / AccessDenied / network / no images returned) —
 * callers must handle null explicitly.
 *
 * Operator credentials are used because the apply-success path runs
 * with operator privilege (matches the DescribeInstances call in
 * `apply-single.ts` Story ii). Reader-only flows (wizard / planning)
 * use `tryAssigneeCredentials("operator")` and short-circuit on
 * absence rather than `requireAssigneeCredentials` so a missing
 * operator credential degrades to "no SSH connect line" rather than
 * crashing the apply-success path.
 */
async function describeAmiMetadata(amiId: string): Promise<AmiMetadata | null> {
  const cached = metadataCache.get(amiId);
  if (cached) return cached;

  const creds = tryAssigneeCredentials("operator");
  if (!creds) return null;

  let ec2: ReturnType<typeof createEC2Client> | undefined;
  try {
    ec2 = createEC2Client({ region: AWS_REGION, credentials: creds });
    const out = await withTimeout(
      ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] })),
      DISCOVERY_TIMEOUT_MS,
    );
    const image = out?.Images?.[0];
    if (!image || !image.ImageId) return null;
    const meta: AmiMetadata = {
      imageId: image.ImageId,
      ...(image.Name !== undefined ? { name: image.Name } : {}),
      ...(image.PlatformDetails !== undefined
        ? { platformDetails: image.PlatformDetails }
        : {}),
    };
    metadataCache.set(amiId, meta);
    return meta;
  } catch {
    return null;
  } finally {
    ec2?.destroy();
  }
}

/**
 * Return the raw `Image.PlatformDetails` string for `amiId`, or `null`
 * when the AMI cannot be resolved. Used by the SSH-bundle Windows
 * fail-fast in `compound-helpers.ts`. The caller treats `null` as
 * "assume non-Windows" — a transient AWS API blip should not block
 * an apply.
 *
 * This call is cheap (cached) and idempotent across the CLI run.
 */
export async function getAmiPlatformDetails(
  amiId: string,
): Promise<string | null> {
  const meta = await describeAmiMetadata(amiId);
  return meta?.platformDetails ?? null;
}

/**
 * Resolve the default SSH user for an AMI ID.
 *
 * Throws `AmiIsWindowsError` when the AMI's PlatformDetails is
 * "Windows" — defense-in-depth; the compound-plan SSH gate
 * fail-fasts much earlier.
 *
 * On unknown AMIs (rare — homebrew images, mid-region custom builds)
 * the function emits a warn-level log entry with an actionable hint
 * (when `runId` is provided) and falls back to `ec2-user`.
 *
 * `runId` is optional so unit tests can call without threading a fake
 * run id; production callers in `apply-single.ts` always pass it.
 */
export async function getAmiDefaultUser(
  amiId: string,
  runId?: string,
): Promise<string> {
  const meta = await describeAmiMetadata(amiId);
  if (meta?.platformDetails === PLATFORM_DETAILS_WINDOWS) {
    throw new AmiIsWindowsError(amiId);
  }

  const name = meta?.name ?? "";
  const mapped = matchAmiNameToUser(name);
  if (mapped !== null) return mapped;

  // Fallback path: log a warn so the user can self-correct if SSH fails.
  if (runId) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: LogLevel.WARN,
      action: LOG_ACTIONS.PLAN_GENERATED,
      extras: {
        phase: "ami_default_user_unknown",
        amiId,
        amiName: name || undefined,
        hint: `AMI default user is unknown for ${amiId}; falling back to ${DEFAULT_SSH_USER_FALLBACK} — try ubuntu or admin if SSH fails`,
      },
    });
  }
  return DEFAULT_SSH_USER_FALLBACK;
}

/**
 * Best-effort variant for callers that have already proven the AMI is
 * not Windows (Story iii apply-success path: by the time we're here,
 * `compound-helpers.ts` has already gated). Wraps `getAmiDefaultUser`
 * in a try/catch so a DescribeImages throttle never blocks rendering.
 *
 * Exported separately from `getAmiDefaultUser` because the throwing
 * variant is the better contract for tests (they assert exact
 * exceptions); the safe variant is what `apply-single.ts` actually
 * calls.
 */
export async function tryGetAmiDefaultUser(
  amiId: string,
  runId: string,
): Promise<string | undefined> {
  try {
    return await getAmiDefaultUser(amiId, runId);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log({
      ts: new Date().toISOString(),
      runId,
      level: LogLevel.INFO,
      action: LOG_ACTIONS.APPLY_SUCCEEDED,
      extras: { describeImagesSkipped: errMsg, amiId },
    });
    return undefined;
  }
}

/**
 * Pure mapping function — exported for tests. Returns `null` when no
 * rule matched (caller decides on the fallback string + log emission).
 *
 * Order is load-bearing:
 *   - amzn2023 / al2023 must beat the broader amzn2 / al2- pattern.
 *   - rhel / red.?hat is independent of suse-family rules.
 */
export function matchAmiNameToUser(amiName: string): string | null {
  if (!amiName) return null;
  if (/amzn2023|al2023|amazon-linux-2023/i.test(amiName)) return "ec2-user";
  if (/amzn2|al2-/i.test(amiName)) return "ec2-user";
  if (/ubuntu/i.test(amiName)) return "ubuntu";
  if (/debian/i.test(amiName)) return "admin";
  if (/rhel|red.?hat/i.test(amiName)) return "ec2-user";
  if (/sles|suse/i.test(amiName)) return "ec2-user";
  if (/centos/i.test(amiName)) return "ec2-user";
  return null;
}

/**
 * Internal — used by tests to seed the cache without making a real
 * AWS call. Not part of the public production surface.
 */
export const __TEST__ = {
  seedCache(amiId: string, meta: Omit<AmiMetadata, "imageId">): void {
    metadataCache.set(amiId, { imageId: amiId, ...meta });
  },
};
