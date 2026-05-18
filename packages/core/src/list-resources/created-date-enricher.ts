/**
 * Created-date enrichment for `assignee admin list` (feature-list-created-date-enrichment).
 *
 * Resolves live creation timestamps from AWS describe APIs for resource rows
 * whose `createdDate` would otherwise remain `N/A`. Initial support covers
 * the resource types that make up > 80% of typical Assignee.ai inventories:
 *
 *   AWS::KMS::Key              → kms:DescribeKey → KeyMetadata.CreationDate
 *   AWS::S3::Bucket            → s3:ListBuckets  → match by name → CreationDate
 *   AWS::CloudFront::Distribution → cloudfront:GetDistribution → LastModifiedTime
 *   AWS::IAM::ManagedPolicy    → iam:GetPolicy   → Policy.CreateDate
 *   AWS::Lambda::Function      → lambda:GetFunctionConfiguration → LastModified
 *   AWS::DynamoDB::Table       → dynamodb:DescribeTable → Table.CreationDateTime
 *
 * AWS::IAM::Role is deliberately excluded — it is already enriched by the
 * existing `enrichWithIamRoles` injector which has richer data.
 *
 * Batching: one SDK call per (resourceType, region) tuple for S3 (ListBuckets
 * returns all). For KMS, CloudFront, IAM, Lambda, and DynamoDB, each ARN
 * requires its own describe API call; those are fanned out in parallel via
 * Promise.allSettled within each (resourceType, region) group.
 *
 * Failure semantics: per-tuple errors degrade to no entry in the returned Map
 * (rows stay N/A) with a single stderr warning per tuple. Never throws.
 */

import {
  KMSClient,
  DescribeKeyCommand,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";
import {
  S3Client,
  ListBucketsCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  GetDistributionCommand,
  type CloudFrontClientConfig,
} from "@aws-sdk/client-cloudfront";
import {
  IAMClient,
  GetPolicyCommand,
  type IAMClientConfig,
} from "@aws-sdk/client-iam";
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  type LambdaClientConfig,
} from "@aws-sdk/client-lambda";
import {
  DynamoDBClient,
  DescribeTableCommand,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { RESOURCE_TYPES } from "../config/resource-types.js";
import { LIST_RESOURCE_TYPES } from "../config/resource-types/companion.js";
import type { ManagedResource } from "./types.js";
import type { CreatedDateEnricher } from "./fetch-managed-resources.js";

/**
 * Error names/codes that indicate a resource was tagged but no longer exists
 * (deleted between RGTA scan and describe call). Spec §147 says these should
 * degrade silently to N/A rather than emitting a warning (F#8).
 */
const NOT_FOUND_ERROR_NAMES = new Set([
  "NotFoundException", // KMS
  "NoSuchBucket", // S3
  "NoSuchDistribution", // CloudFront
  "NoSuchEntityException", // IAM
  "ResourceNotFoundException", // Lambda, DynamoDB
]);

/**
 * Returns true when the error indicates a resource-not-found condition that
 * should be silently degraded to N/A (not warned about).
 */
function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as Error & { name?: string }).name ?? "";
  const code = (err as Error & { Code?: string }).Code ?? "";
  return NOT_FOUND_ERROR_NAMES.has(name) || NOT_FOUND_ERROR_NAMES.has(code);
}

/** Per-call timeout for describe APIs (5 seconds per spec). */
const DESCRIBE_TIMEOUT_MS = 5_000;

/** Shared credential shape injected by the caller. */
export interface CreatedDateEnricherCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Wraps a Promise with a timeout. Rejects with "TIMEOUT" if the inner promise
 * does not resolve within `ms` milliseconds.
 *
 * The timer handle is cleared once the inner promise settles to avoid
 * event-loop handle leaks (F#13) that would delay process exit by up to
 * `ms` × N tuples after a successful describe call.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((_, reject) => {
    handle = setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (handle !== undefined) clearTimeout(handle);
  });
}

/**
 * Formats an ISO 8601 timestamp into `YYYY-MM-DD`, optionally appending
 * a `(modified)` annotation when the source field is `LastModifiedTime`
 * rather than a true creation date.
 */
function toDateLabel(iso: string, modified = false): string {
  const date = iso.slice(0, 10); // "YYYY-MM-DD"
  return modified ? `${date} (modified)` : date;
}

/** Extract the bucket name from an S3 ARN (arn:aws:s3:::bucket-name). */
function s3BucketNameFromArn(arn: string): string {
  // S3 ARN format: arn:aws:s3:::bucket-name (no region/account)
  const parts = arn.split(":::");
  return parts[1] ?? arn.split(":").pop() ?? "";
}

/** Extract the key ID (or alias path) from a KMS ARN.
 *
 * Handles two shapes:
 *   key ARN:   arn:aws:kms:us-east-1:123456789012:key/b725bae0-...   → "b725bae0-..."
 *   alias ARN: arn:aws:kms:us-east-1:123456789012:alias/my-key       → "alias/my-key"
 *
 * KMS DescribeKey accepts a full key ID for key ARNs, but requires the
 * "alias/" prefix for alias ARNs — returning just the bare name would cause
 * an InvalidKeyId error.
 */
function kmsKeyIdFromArn(arn: string): string {
  // Alias ARN: contains ":alias/" segment — preserve the "alias/" prefix
  if (arn.includes(":alias/")) {
    const idx = arn.indexOf(":alias/");
    return arn.substring(idx + 1); // "alias/my-key"
  }
  // Key ARN: arn:aws:kms:us-east-1:123456789012:key/b725bae0-...
  const keyPart = arn.split("/").pop();
  return keyPart ?? arn;
}

/** Extract CloudFront distribution ID from ARN. */
function cloudfrontDistributionIdFromArn(arn: string): string {
  // arn:aws:cloudfront::account:distribution/E3B1MIRNBPH9JG
  return arn.split("/").pop() ?? arn;
}

/** Extract Lambda function name from ARN. */
function lambdaFunctionNameFromArn(arn: string): string {
  // arn:aws:lambda:region:account:function:my-function
  return arn.split(":").pop() ?? arn;
}

/** Extract DynamoDB table name from ARN. */
function dynamoTableNameFromArn(arn: string): string {
  // arn:aws:dynamodb:region:account:table/my-table
  return arn.split("/").pop() ?? arn;
}

// ── Per-type describe handlers ─────────────────────────────────────────────

async function describeKmsKeys(
  arns: string[],
  credentials: CreatedDateEnricherCredentials,
  region: string,
): Promise<Map<string, string>> {
  const clientConfig: KMSClientConfig = {
    region,
    credentials,
    maxAttempts: 3, // F#5: ensure retry strategy is active
  };
  const client = new KMSClient(clientConfig);
  const result = new Map<string, string>();

  try {
    const settled = await Promise.allSettled(
      arns.map(async (arn) => {
        const keyId = kmsKeyIdFromArn(arn);
        const resp = await withTimeout(
          client.send(new DescribeKeyCommand({ KeyId: keyId })),
          DESCRIBE_TIMEOUT_MS,
        );
        const creationDate = resp.KeyMetadata?.CreationDate;
        if (creationDate) {
          result.set(arn, toDateLabel(creationDate.toISOString()));
        }
      }),
    );

    // F#8: filter NotFound (resource deleted after RGTA scan) — degrade silently.
    const failures = settled.filter(
      (r) => r.status === "rejected" && !isNotFoundError(r.reason),
    );
    if (failures.length > 0) {
      process.stderr.write(
        `⚠ Warning: Could not describe ${failures.length} KMS key(s) in ${region} for created-date enrichment.\n`,
      );
    }
  } finally {
    client.destroy();
  }

  return result;
}

async function describeS3Buckets(
  arns: string[],
  credentials: CreatedDateEnricherCredentials,
  region: string,
): Promise<Map<string, string>> {
  // s3:ListBuckets returns all buckets in one call — match by name
  const clientConfig: S3ClientConfig = {
    region,
    credentials,
    maxAttempts: 3, // F#5: ensure retry strategy is active
  };
  const client = new S3Client(clientConfig);
  const result = new Map<string, string>();

  try {
    const resp = await withTimeout(
      client.send(new ListBucketsCommand({})),
      DESCRIBE_TIMEOUT_MS,
    );

    const bucketMap = new Map<string, Date>();
    for (const b of resp.Buckets ?? []) {
      if (b.Name && b.CreationDate) {
        bucketMap.set(b.Name, b.CreationDate);
      }
    }

    for (const arn of arns) {
      const name = s3BucketNameFromArn(arn);
      const date = bucketMap.get(name);
      if (date) {
        result.set(arn, toDateLabel(date.toISOString()));
      }
    }
  } catch (err) {
    process.stderr.write(
      `⚠ Warning: Could not list S3 buckets in ${region} for created-date enrichment: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  } finally {
    client.destroy();
  }

  return result;
}

async function describeCloudFrontDistributions(
  arns: string[],
  credentials: CreatedDateEnricherCredentials,
): Promise<Map<string, string>> {
  // CloudFront is global — no region needed
  const clientConfig: CloudFrontClientConfig = {
    region: "us-east-1",
    credentials,
    maxAttempts: 3, // F#5: ensure retry strategy is active
  };
  const client = new CloudFrontClient(clientConfig);
  const result = new Map<string, string>();

  try {
    const settled = await Promise.allSettled(
      arns.map(async (arn) => {
        const distId = cloudfrontDistributionIdFromArn(arn);
        const resp = await withTimeout(
          client.send(new GetDistributionCommand({ Id: distId })),
          DESCRIBE_TIMEOUT_MS,
        );
        const lastModified = resp.Distribution?.LastModifiedTime;
        if (lastModified) {
          // CloudFront doesn't expose a CreationDate — use LastModifiedTime
          // and annotate to avoid claiming it's the exact creation timestamp.
          result.set(arn, toDateLabel(lastModified.toISOString(), true));
        }
      }),
    );

    // F#8: filter NotFound (resource deleted after RGTA scan) — degrade silently.
    const failures = settled.filter(
      (r) => r.status === "rejected" && !isNotFoundError(r.reason),
    );
    if (failures.length > 0) {
      process.stderr.write(
        `⚠ Warning: Could not describe ${failures.length} CloudFront distribution(s) for created-date enrichment.\n`,
      );
    }
  } finally {
    client.destroy();
  }

  return result;
}

async function describeIamManagedPolicies(
  arns: string[],
  credentials: CreatedDateEnricherCredentials,
): Promise<Map<string, string>> {
  // IAM is global
  const clientConfig: IAMClientConfig = {
    region: "us-east-1",
    credentials,
    maxAttempts: 3, // F#5: ensure retry strategy is active
  };
  const client = new IAMClient(clientConfig);
  const result = new Map<string, string>();

  try {
    const settled = await Promise.allSettled(
      arns.map(async (arn) => {
        const resp = await withTimeout(
          client.send(new GetPolicyCommand({ PolicyArn: arn })),
          DESCRIBE_TIMEOUT_MS,
        );
        const createDate = resp.Policy?.CreateDate;
        if (createDate) {
          result.set(arn, toDateLabel(createDate.toISOString()));
        }
      }),
    );

    // F#8: filter NotFound (resource deleted after RGTA scan) — degrade silently.
    const failures = settled.filter(
      (r) => r.status === "rejected" && !isNotFoundError(r.reason),
    );
    if (failures.length > 0) {
      process.stderr.write(
        `⚠ Warning: Could not describe ${failures.length} IAM managed policy/policies for created-date enrichment.\n`,
      );
    }
  } finally {
    client.destroy();
  }

  return result;
}

async function describeLambdaFunctions(
  arns: string[],
  credentials: CreatedDateEnricherCredentials,
  region: string,
): Promise<Map<string, string>> {
  const clientConfig: LambdaClientConfig = {
    region,
    credentials,
    maxAttempts: 3, // F#5: ensure retry strategy is active
  };
  const client = new LambdaClient(clientConfig);
  const result = new Map<string, string>();

  try {
    const settled = await Promise.allSettled(
      arns.map(async (arn) => {
        const fnName = lambdaFunctionNameFromArn(arn);
        const resp = await withTimeout(
          client.send(
            new GetFunctionConfigurationCommand({ FunctionName: fnName }),
          ),
          DESCRIBE_TIMEOUT_MS,
        );
        // Lambda returns LastModified as an ISO 8601 string (not a Date).
        // LastModified is the last deploy date (not creation); annotate
        // consistently with CloudFront's (modified) label (F#9).
        const lastModified = resp.LastModified;
        if (lastModified) {
          result.set(arn, toDateLabel(lastModified, true));
        }
      }),
    );

    // F#8: filter NotFound (resource deleted after RGTA scan) — degrade silently.
    const failures = settled.filter(
      (r) => r.status === "rejected" && !isNotFoundError(r.reason),
    );
    if (failures.length > 0) {
      process.stderr.write(
        `⚠ Warning: Could not describe ${failures.length} Lambda function(s) in ${region} for created-date enrichment.\n`,
      );
    }
  } finally {
    client.destroy();
  }

  return result;
}

async function describeDynamoTables(
  arns: string[],
  credentials: CreatedDateEnricherCredentials,
  region: string,
): Promise<Map<string, string>> {
  const clientConfig: DynamoDBClientConfig = {
    region,
    credentials,
    maxAttempts: 3, // F#5: ensure retry strategy is active
  };
  const client = new DynamoDBClient(clientConfig);
  const result = new Map<string, string>();

  try {
    const settled = await Promise.allSettled(
      arns.map(async (arn) => {
        const tableName = dynamoTableNameFromArn(arn);
        const resp = await withTimeout(
          client.send(new DescribeTableCommand({ TableName: tableName })),
          DESCRIBE_TIMEOUT_MS,
        );
        const creationDate = resp.Table?.CreationDateTime;
        if (creationDate) {
          result.set(arn, toDateLabel(creationDate.toISOString()));
        }
      }),
    );

    // F#8: filter NotFound (resource deleted after RGTA scan) — degrade silently.
    const failures = settled.filter(
      (r) => r.status === "rejected" && !isNotFoundError(r.reason),
    );
    if (failures.length > 0) {
      process.stderr.write(
        `⚠ Warning: Could not describe ${failures.length} DynamoDB table(s) in ${region} for created-date enrichment.\n`,
      );
    }
  } finally {
    client.destroy();
  }

  return result;
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Creates a `CreatedDateEnricher` that fans out to per-type AWS describe
 * APIs to resolve creation timestamps.
 *
 * @param credentials - AWS credentials to use for SDK calls (operator role).
 * @param fallbackRegion - Region to use when the resource ARN has no region
 *   (e.g. global services). Callers pass the CLI's configured region.
 */
export function createListCreatedDateEnricher(
  credentials: CreatedDateEnricherCredentials,
  fallbackRegion: string,
): CreatedDateEnricher {
  return async (resources: ManagedResource[]): Promise<Map<string, string>> => {
    const result = new Map<string, string>();

    // Group resources by (resourceType, region) — region normalised for
    // global services so we don't fire duplicate describe calls.
    type TupleKey = `${string}::${string}`;
    const grouped = new Map<TupleKey, ManagedResource[]>();

    for (const r of resources) {
      if (!r.arn) continue; // non-taggable primaryIdentifier rows — skip
      const region = r.region === "global" ? fallbackRegion : r.region;
      const key: TupleKey = `${r.resourceType}::${region}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(r);
      grouped.set(key, bucket);
    }

    // Fan out per-type handler for each (resourceType, region) group in parallel.
    const groupEntries = [...grouped.entries()];
    await Promise.allSettled(
      groupEntries.map(async ([key, group]) => {
        const resourceType = group[0]!.resourceType;
        const regionForType =
          group[0]!.region === "global" ? fallbackRegion : group[0]!.region;
        const arns = group.map((r) => r.arn).filter(Boolean);
        if (arns.length === 0) return;

        try {
          let typeResult: Map<string, string>;

          switch (resourceType) {
            case RESOURCE_TYPES.KMS_KEY:
              typeResult = await describeKmsKeys(
                arns,
                credentials,
                regionForType,
              );
              break;
            case RESOURCE_TYPES.S3_BUCKET:
              typeResult = await describeS3Buckets(
                arns,
                credentials,
                regionForType,
              );
              break;
            case RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION:
              typeResult = await describeCloudFrontDistributions(
                arns,
                credentials,
              );
              break;
            case LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY:
              typeResult = await describeIamManagedPolicies(arns, credentials);
              break;
            case RESOURCE_TYPES.LAMBDA_FUNCTION:
              typeResult = await describeLambdaFunctions(
                arns,
                credentials,
                regionForType,
              );
              break;
            case RESOURCE_TYPES.DYNAMODB_TABLE:
              typeResult = await describeDynamoTables(
                arns,
                credentials,
                regionForType,
              );
              break;
            default:
              // Unsupported type — leave as N/A (v1 scope)
              return;
          }

          for (const [arn, date] of typeResult) {
            result.set(arn, date);
          }
        } catch (err) {
          // Per-tuple failure: warn once, don't crash, don't add entries
          // (those rows remain N/A in the final output).
          process.stderr.write(
            `⚠ Warning: Created-date enrichment failed for ${key}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
      }),
    );

    return result;
  };
}
