/**
 * S3 Upload Service — uploads local files to an S3 bucket for static website hosting.
 *
 * Uses ASSIGNEE_OPERATOR_* credentials via requireAssigneeCredentials("operator"), consistent with
 * all other AWS SDK clients in the CLI.
 *
 * @see Story 37.3 — S3 Static Site Upload
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, extname, sep as pathSep } from "node:path";
import { ConfigurationError } from "../errors.js";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import { EnvVar } from "../constants/env-vars.js";
import { ContentType } from "../constants/errors.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";

// T2-1: re-export configureBucketPolicy from its canonical module.
// Backwards-compat shim so existing importers (barrel, tests, CLI
// s3-upload.ts) need no change.
export { configureBucketPolicy } from "./s3-public-website-policy.js";

export interface UploadResult {
  uploaded: number;
  failed: number;
  totalBytes: number;
  errors: Array<{ file: string; error: string }>;
  /**
   * Count of remote objects deleted because they had no local
   * counterpart. Always `0` when the caller does not pass
   * `{ deleteOrphans: true }`. Additive — pre-feature callers and
   * tests see the same field set with the value zero.
   */
  deleted: number;
}

export interface UploadProgress {
  current: number;
  total: number;
  file: string;
}

/**
 * MIME type mapping for common static site file extensions.
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": ContentType.JAVASCRIPT,
  ".mjs": ContentType.JAVASCRIPT,
  ".json": ContentType.JSON,
  ".png": "image/png",
  ".jpg": ContentType.JPEG,
  ".jpeg": ContentType.JPEG,
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".map": ContentType.JSON,
  ".webmanifest": "application/manifest+json",
  // ── `assignee dev update` follow-on: video / audio / markdown ─────────
  // The `update` command refreshes existing static sites that today
  // routinely embed marketing video clips, podcasts, or doc previews.
  // Without these mappings S3 served `application/octet-stream` which
  // forces a download instead of streaming inline.
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".md": "text/markdown",
};

/** Resolve MIME type from file extension, defaulting to application/octet-stream. */
export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Recursively collect all files in a directory.
 * Returns absolute paths for every regular file found.
 */
export function collectFiles(dir: string, base?: string): string[] {
  const root = base ?? dir;
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // Skip symlinks for security
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, root));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Create an S3Client using the centralized credential helper.
 *
 * Throws `MissingAssigneeCredentialsError` (from @assignee/core) when
 * `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY`
 * are not set in the environment. Never falls through to the default AWS
 * credential chain (~/.aws/credentials, SSO, IMDS).
 */
function createS3Client(region?: string, config?: ConfigPort): S3Client {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  // L-A10: A previous refactor removed AWS_REGION validation, so when neither
  // an explicit override nor process.env.AWS_REGION was set, the SDK silently
  // defaulted to us-east-1 — uploading to the wrong region with no warning.
  // Restore the explicit error so misconfiguration fails fast.
  const resolvedRegion =
    region ?? effectiveConfig.get(EnvVar.AWS_REGION)?.trim() ?? "";
  if (!resolvedRegion) {
    throw new ConfigurationError(
      "AWS_REGION is missing or empty — set it in .env (or pass an explicit region) before running setup.",
    );
  }
  return new S3Client({
    region: resolvedRegion,
    credentials: requireAssigneeCredentials("operator", effectiveConfig),
  });
}

/**
 * Upload local files to an S3 bucket for static website hosting.
 *
 * Reads operator credentials from the environment (ASSIGNEE_OPERATOR_* vars),
 * collects all files recursively from `sourceDir`, and uploads each with the
 * correct MIME type. Individual file failures do not stop the upload — errors
 * are collected and returned in the result.
 *
 * When `options.deleteOrphans === true`, after the upload loop completes
 * the function paginates `ListObjectsV2` over the bucket, computes the set
 * of remote keys that have no local counterpart, and deletes them in
 * 1000-key batches via `DeleteObjectsCommand` (AWS limit). The result
 * carries the `deleted` count.
 *
 * @param bucketName - Target S3 bucket name
 * @param sourceDir  - Local directory containing static site files
 * @param options    - Optional region override, progress callback, orphan deletion
 * @returns Upload result with counts and any errors
 */
export async function uploadStaticSite(
  bucketName: string,
  sourceDir: string,
  options?: {
    region?: string;
    onProgress?: (progress: UploadProgress) => void;
    config?: ConfigPort;
    /**
     * `assignee dev update` follow-on: when `true`, deletes remote objects
     * whose key is NOT present in the local upload set. Default `false`
     * (additive-only is the safer default for first-time uploads).
     */
    deleteOrphans?: boolean;
  },
): Promise<UploadResult> {
  const client = createS3Client(options?.region, options?.config);

  const allFiles = collectFiles(sourceDir);

  // T3-2: snapshot localKeys at upload START, before the upload loop.
  // Computing localKeys from `allFiles` AFTER the loop would be racy:
  // if the OS removes a local file between `collectFiles` and the orphan
  // sweep, that file's key is absent from the late-computed set, causing
  // the still-valid remote object to be incorrectly treated as an orphan
  // and deleted. By snapshotting here we close the race window — any file
  // that existed when we started the upload is included in localKeys even
  // if it disappears mid-flight.
  const localKeys = new Set<string>(
    allFiles.map((f) => relative(sourceDir, f).split(pathSep).join("/")),
  );

  const result: UploadResult = {
    uploaded: 0,
    failed: 0,
    totalBytes: 0,
    errors: [],
    deleted: 0,
  };

  /** S3 keys we successfully PUT in this run — used by the orphan sweep. */
  const uploadedKeys = new Set<string>();

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]!;
    // Story 50-2: use path.sep (runtime platform separator) instead of the
    // hard-coded "\\" literal. On POSIX hosts path.sep === "/", so the
    // split is a no-op (identity). On Windows hosts path.sep === "\\",
    // so the replacement still converts backslashes → forward slashes.
    // Literal "\\" only matched on Windows, which is what the original
    // comment intended, but a Windows user with a bind-mounted POSIX
    // drive would have produced the wrong result.
    const key = relative(sourceDir, filePath).split(pathSep).join("/");
    const contentType = getMimeType(filePath);

    try {
      const body = readFileSync(filePath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      result.uploaded += 1;
      result.totalBytes += body.length;
      uploadedKeys.add(key);
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        file: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    options?.onProgress?.({
      current: i + 1,
      total: allFiles.length,
      file: key,
    });
  }

  // ── Orphan sweep (opt-in) ───────────────────────────────────────────
  if (options?.deleteOrphans === true) {
    // `localKeys` was snapshotted at upload-start (T3-2 race-closure).
    // Files that FAILED to upload are still in localKeys (their key was
    // computed from the snapshot), so they are NOT treated as orphans —
    // the bucket may already hold a prior-run version of the file.
    // The set we want is `remote - localKeys`.

    const orphans: string[] = [];
    let continuationToken: string | undefined;
    do {
      const listResp = (await client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: continuationToken,
        }),
      )) as {
        Contents?: Array<{ Key?: string }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const obj of listResp.Contents ?? []) {
        const k = obj.Key;
        if (k && !localKeys.has(k)) orphans.push(k);
      }
      continuationToken = listResp.IsTruncated
        ? listResp.NextContinuationToken
        : undefined;
    } while (continuationToken);

    // S3 DeleteObjects is capped at 1000 keys per request. Batch.
    for (let i = 0; i < orphans.length; i += 1000) {
      const batch = orphans.slice(i, i + 1000);
      try {
        const delResp = (await client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: batch.map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        )) as { Errors?: Array<{ Key?: string; Message?: string }> };
        // Successful deletes = batch size minus error count.
        const errCount = delResp.Errors?.length ?? 0;
        result.deleted += batch.length - errCount;
        for (const e of delResp.Errors ?? []) {
          result.errors.push({
            file: e.Key ?? "<unknown>",
            error: `delete failed: ${e.Message ?? "unknown"}`,
          });
        }
      } catch (err) {
        // Whole-batch failure (network, throttling). Record each key.
        for (const k of batch) {
          result.errors.push({
            file: k,
            error: `delete failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }
    }
  }

  return result;
}
