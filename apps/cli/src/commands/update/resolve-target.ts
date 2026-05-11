/**
 * `assignee update` target resolver.
 *
 * Maps the operator-supplied `<target>` (bucket name / ARN / runId)
 * to a fully-qualified update target: bucket + region + (optional)
 * linked CloudFront distribution + (optional) DomainName.
 *
 * Order of operations
 * -------------------
 * 1. Classify the input via `classifyTarget`.
 * 2. Query the local provision-records store for matching entries.
 *    - runId      → ALL entries with that runId.
 *    - arn/bucket → match by resourceArn / suffix.
 * 3. Identify the S3 bucket entry (required) + paired CloudFront
 *    distribution entry (optional — same runId AND compound, or first
 *    other entry with the same runId).
 * 4. Provision-record fallback to live AWS: when --no-invalidation is
 *    NOT set AND we did not find a distribution in the store, call
 *    `cloudfront:ListDistributions` and look for any origin whose
 *    DomainName matches `<bucket>.s3.<...>.amazonaws.com` (both the
 *    legacy regionless form and the regioned form).
 *      - zero matches → throw USAGE_ERROR with a help hint.
 *      - 1 match      → use it.
 *      - 2+ matches   → throw USAGE_ERROR with the list of candidates
 *                       and a hint to use --no-invalidation manually.
 */

import {
  AssigneeError,
  listProvisionRecords,
  defaultMemoryService,
  type StoredProvisionRecord,
  withTimeout,
} from "@assignee/core";
import { AWS_REGION } from "../../config/constants.js";
import { ErrorCode } from "../../constants/errors.js";
import { classifyTarget } from "./arg-parser.js";

/**
 * Real-AWS-shape origin entry from `cloudfront:ListDistributions`.
 * Keeping the type local avoids dragging the SDK's heavy types into
 * the command surface.
 */
interface CfOrigin {
  DomainName?: string;
}
interface CfDistributionSummary {
  Id?: string;
  ARN?: string;
  DomainName?: string;
  Origins?: { Items?: CfOrigin[] };
}

export interface UpdateTarget {
  bucketName: string;
  bucketArn: string;
  region: string;
  distributionId?: string;
  distributionArn?: string;
  cloudFrontDomainName?: string;
}

/**
 * Shape of a single raw provision record consumed by the resolver.
 * Only the fields the resolver actually uses are listed so tests can
 * inject a minimal mock without rebuilding the full ProvisionRecord
 * shape.
 */
export interface RawProvisionForResolver {
  runId: string;
  resourceType: string;
  resourceArn: string;
  region: string;
  cloudFrontDomainName?: string;
}

export interface ResolveOptions {
  /** When true, skip the ListDistributions fallback entirely. */
  skipCloudFrontLookup?: boolean;
  /** Override for tests — defaults to a real ListDistributions call. */
  listDistributions?: () => Promise<CfDistributionSummary[]>;
  /** Override for tests — defaults to `listProvisionRecords()`. */
  loadProvisions?: () => Promise<StoredProvisionRecord[]>;
  /**
   * Override for tests — defaults to `defaultMemoryService.readProvisions()`.
   * Lets the test seed a `cloudFrontDomainName` value on the raw
   * record without mocking the memory service singleton.
   */
  loadRawProvisions?: () => Promise<RawProvisionForResolver[]>;
}

/**
 * Build the canonical S3 ARN for a bucket name. Partition-aware so
 * GovCloud / China callers get the right partition.
 */
function s3Arn(bucketName: string, region: string): string {
  // We rely on the existing partition helper rather than re-deriving
  // the prefix locally.
  return `arn:${getPartition(region)}:s3:::${bucketName}`;
}

/**
 * Tiny partition resolver — picked here instead of importing
 * `getPartitionFromRegion` to keep this module's import surface
 * minimal (it is loaded from the CLI app, not core). This mirrors
 * the inline logic in `aws-partition.ts` for the three real
 * partitions.
 */
function getPartition(region: string): string {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  return "aws";
}

/**
 * Extract the bare S3 bucket name from a value that may be either a
 * full `arn:aws:s3:::<name>` ARN OR the bare name. Mirrors
 * `static-site-upload.ts:parseBucketName`.
 */
function parseBucketName(stored: string): string {
  return stored.startsWith("arn:")
    ? (stored.split(":::").at(-1) ?? stored)
    : stored;
}

/**
 * Find a CloudFront distribution whose origin DomainName resolves to
 * the given S3 bucket. Returns the FIRST matching candidate when the
 * match set has exactly one entry; otherwise null. The caller decides
 * how to handle zero / 1 / N hits.
 */
function findDistributionsForBucket(
  bucketName: string,
  dists: readonly CfDistributionSummary[],
): CfDistributionSummary[] {
  // Both shapes are produced by S3 origins in CloudFront:
  //   - regioned:    <bucket>.s3.<region>.amazonaws.com
  //   - legacy:      <bucket>.s3.amazonaws.com
  //   - dualstack:   <bucket>.s3.dualstack.<region>.amazonaws.com
  //   - China:       <bucket>.s3.<region>.amazonaws.com.cn
  //   - website:     <bucket>.s3-website-<region>.amazonaws.com
  //                  / <bucket>.s3-website.<region>.amazonaws.com
  // We only handle the first four (the CloudFront-Origin-Access
  // pattern uses the regioned / legacy / dualstack form, and the
  // `.amazonaws.com.cn` suffix is the China-partition equivalent;
  // website endpoints are an anti-pattern with CloudFront because
  // they break OAC).
  const match = new RegExp(
    `^${escapeRegex(bucketName)}\\.s3(\\.dualstack)?(\\.[a-z0-9-]+)?\\.amazonaws\\.com(\\.cn)?$`,
    "i",
  );
  return dists.filter((d) =>
    (d.Origins?.Items ?? []).some(
      (o) => typeof o.DomainName === "string" && match.test(o.DomainName),
    ),
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read the FULL `ProvisionRecord` set (not just the projected
 * `StoredProvisionRecord`) so we can access the optional
 * `cloudFrontDomainName` slot on CloudFront entries. This makes one
 * extra fs read per `assignee update` invocation; cheap enough that
 * it's not worth threading the raw shape through `listProvisionRecords`.
 */
async function loadRawProvisions(): Promise<
  ReadonlyArray<{
    runId: string;
    resourceType: string;
    resourceArn: string;
    region: string;
    cloudFrontDomainName?: string;
  }>
> {
  // defaultMemoryService.readProvisions returns ProvisionRecord[].
  const raw = await defaultMemoryService.readProvisions();
  return raw.map((r) => ({
    runId: r.runId,
    resourceType: r.resourceType,
    resourceArn: r.resourceArn,
    region: r.region,
    cloudFrontDomainName: r.cloudFrontDomainName,
  }));
}

/**
 * Live `cloudfront:ListDistributions`. Lazy SDK import per the
 * project convention (see `destroy-strategies/strategies/cloudfront-distribution.ts:47`).
 */
async function liveListDistributions(): Promise<CfDistributionSummary[]> {
  const { CloudFrontClient, ListDistributionsCommand } =
    await import("@aws-sdk/client-cloudfront");
  const { requireAssigneeCredentials } = await import("@assignee/core");
  const cf = new CloudFrontClient({
    region: AWS_REGION,
    credentials: requireAssigneeCredentials("operator"),
  });
  const out: CfDistributionSummary[] = [];
  let marker: string | undefined;
  do {
    // A6 (M-H-013): wrap each page call in a 30s timeout to prevent
    // the resolver from hanging indefinitely when CloudFront is slow.
    const pagePromise = cf.send(
      new ListDistributionsCommand({ Marker: marker }),
    ) as Promise<{
      DistributionList?: {
        Items?: CfDistributionSummary[];
        IsTruncated?: boolean;
        NextMarker?: string;
      };
    }>;
    const resp = await withTimeout(pagePromise, 30_000);
    if (resp === null) {
      throw new AssigneeError(
        "ListDistributions timed out after 30s — check CloudFront connectivity or pass --no-invalidation to skip the lookup.",
        ErrorCode.USAGE_ERROR,
      );
    }
    for (const item of resp.DistributionList?.Items ?? []) out.push(item);
    marker = resp.DistributionList?.IsTruncated
      ? resp.DistributionList?.NextMarker
      : undefined;
  } while (marker);
  return out;
}

/**
 * Resolve the operator's `<target>` into a usable `UpdateTarget`.
 */
export async function resolveUpdateTarget(
  rawTarget: string,
  options: ResolveOptions = {},
): Promise<UpdateTarget> {
  const classification = classifyTarget(rawTarget);
  const loadProvisions =
    options.loadProvisions ??
    (async () => {
      const stored = await listProvisionRecords();
      return stored;
    });
  const loadRaw = options.loadRawProvisions ?? loadRawProvisions;
  // The full-record read is only needed when we want
  // `cloudFrontDomainName` off a CloudFront provision row.
  const rawRecords = await loadRaw();
  const records = await loadProvisions();

  // ── Find the S3 bucket entry ─────────────────────────────────────
  let bucketEntry: StoredProvisionRecord | undefined;
  let bucketName: string;
  let region: string;

  if (classification.kind === "runId") {
    const matches = records.filter((r) => r.runId === rawTarget.trim());
    bucketEntry = matches.find((r) => /::S3::Bucket$/i.test(r.resourceType));
    if (!bucketEntry) {
      throw new AssigneeError(
        `No S3 bucket found in provision records for run ${rawTarget}. Verify the runId via 'assignee list'.`,
        ErrorCode.USAGE_ERROR,
      );
    }
    bucketName = parseBucketName(bucketEntry.key);
    region = bucketEntry.region || AWS_REGION;
  } else {
    bucketName = classification.bucketName;
    // Try to find a matching S3 bucket provision record so we can pick
    // up region + linked distribution. If absent, we still proceed —
    // the user may be running update against a bucket assignee never
    // recorded (e.g. provisioned with a previous CLI version).
    bucketEntry = records.find(
      (r) =>
        /::S3::Bucket$/i.test(r.resourceType) &&
        (parseBucketName(r.key) === bucketName || r.key === bucketName),
    );
    region = bucketEntry?.region ?? AWS_REGION;
  }

  const bucketArn =
    bucketEntry?.keyKind === "arn" && bucketEntry.key.startsWith("arn:")
      ? bucketEntry.key
      : s3Arn(bucketName, region);

  // ── Find the linked CloudFront distribution (if any) ─────────────
  let distributionId: string | undefined;
  let distributionArn: string | undefined;
  let cloudFrontDomainName: string | undefined;

  if (bucketEntry) {
    // Sibling distribution: same runId AND CloudFront type.
    const sibling = records.find(
      (r) =>
        r.runId === bucketEntry!.runId &&
        /::CloudFront::Distribution$/i.test(r.resourceType),
    );
    if (sibling) {
      // Sibling's `key` is the CloudFront distribution Id (CCAPI
      // primaryIdentifier for distributions). For full-ARN keys
      // (defensive — CloudFront ARN form would be
      // `arn:aws:cloudfront::ACCT:distribution/<id>`), split on '/'.
      distributionId = sibling.key.startsWith("arn:")
        ? (sibling.key.split("/").at(-1) ?? sibling.key)
        : sibling.key;
      if (sibling.key.startsWith("arn:")) {
        distributionArn = sibling.key;
      }
      // Look up the raw record so we can hydrate the optional
      // cloudFrontDomainName field.
      const rawSibling = rawRecords.find(
        (r) =>
          r.runId === sibling.runId &&
          /::CloudFront::Distribution$/i.test(r.resourceType),
      );
      if (rawSibling?.cloudFrontDomainName) {
        cloudFrontDomainName = rawSibling.cloudFrontDomainName;
      }
    }
  }

  // ── ListDistributions fallback ───────────────────────────────────
  // Only when we did NOT find a sibling in the provision store. The
  // caller can opt out via `skipCloudFrontLookup` (e.g. when
  // --no-invalidation is set so a missing distribution is not an
  // error).
  if (!distributionId && !options.skipCloudFrontLookup) {
    const lister = options.listDistributions ?? liveListDistributions;
    let candidates: CfDistributionSummary[];
    try {
      const all = await lister();
      candidates = findDistributionsForBucket(bucketName, all);
    } catch (err) {
      throw new AssigneeError(
        `Could not enumerate CloudFront distributions to find the one fronting ${bucketName}: ${
          err instanceof Error ? err.message : String(err)
        }. Pass --no-invalidation to skip cache invalidation, or run the invalidation manually.`,
        ErrorCode.USAGE_ERROR,
      );
    }
    if (candidates.length === 0) {
      // Not an error if the caller is OK uploading without invalidating.
      // The action layer interprets `distributionId === undefined` and
      // either prompts the user, throws, or proceeds based on
      // --no-invalidation.
    } else if (candidates.length === 1) {
      const only = candidates[0]!;
      distributionId = only.Id;
      distributionArn = only.ARN;
      cloudFrontDomainName = only.DomainName;
    } else {
      const list = candidates
        .map(
          (c) => `  - ${c.Id ?? "<no-id>"}  (${c.DomainName ?? "<no-domain>"})`,
        )
        .join("\n");
      throw new AssigneeError(
        `${candidates.length} CloudFront distributions front s3://${bucketName}:\n${list}\n` +
          "Disambiguation is not yet supported — pass --no-invalidation and run the invalidation manually until that lands.",
        ErrorCode.USAGE_ERROR,
      );
    }
  }

  return {
    bucketName,
    bucketArn,
    region,
    ...(distributionId ? { distributionId } : {}),
    ...(distributionArn ? { distributionArn } : {}),
    ...(cloudFrontDomainName ? { cloudFrontDomainName } : {}),
  };
}
