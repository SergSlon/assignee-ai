/**
 * S3 Upload Service — uploads local files to an S3 bucket for static website hosting.
 *
 * Uses ASSIGNEE_OPERATOR_* credentials via operatorCredentials(), consistent with
 * all other AWS SDK clients in the CLI.
 *
 * @see Story 37.3 — S3 Static Site Upload
 */

import {
  S3Client,
  PutObjectCommand,
  PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { ConfigurationError, IamEffect } from "@assignee/core";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import { EnvVar } from "../constants/env-vars.js";
import { ContentType } from "../constants/errors.js";

export interface UploadResult {
  uploaded: number;
  failed: number;
  totalBytes: number;
  errors: Array<{ file: string; error: string }>;
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
function createS3Client(region?: string): S3Client {
  // L-A10: A previous refactor removed AWS_REGION validation, so when neither
  // an explicit override nor process.env.AWS_REGION was set, the SDK silently
  // defaulted to us-east-1 — uploading to the wrong region with no warning.
  // Restore the explicit error so misconfiguration fails fast.
  const resolvedRegion = region ?? process.env[EnvVar.AWS_REGION]?.trim() ?? "";
  if (!resolvedRegion) {
    throw new ConfigurationError(
      "AWS_REGION is missing or empty — set it in .env (or pass an explicit region) before running setup.",
    );
  }
  return new S3Client({
    region: resolvedRegion,
    credentials: requireAssigneeCredentials("operator"),
  });
}

/**
 * Configure a public-read bucket policy for static website hosting.
 *
 * Allows anonymous GET requests on all objects in the bucket, which is
 * required for S3 website hosting to serve files to browsers.
 *
 * @param bucketName - Target S3 bucket name
 * @param options    - Optional region override
 */
export async function configureBucketPolicy(
  bucketName: string,
  options?: { region?: string },
): Promise<void> {
  const client = createS3Client(options?.region);

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicReadGetObject",
        Effect: IamEffect.ALLOW,
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucketName}/*`,
      },
    ],
  };

  await client.send(
    new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policy),
    }),
  );
}

/**
 * Upload local files to an S3 bucket for static website hosting.
 *
 * Reads operator credentials from the environment (ASSIGNEE_OPERATOR_* vars),
 * collects all files recursively from `sourceDir`, and uploads each with the
 * correct MIME type. Individual file failures do not stop the upload — errors
 * are collected and returned in the result.
 *
 * @param bucketName - Target S3 bucket name
 * @param sourceDir  - Local directory containing static site files
 * @param options    - Optional region override and progress callback
 * @returns Upload result with counts and any errors
 */
export async function uploadStaticSite(
  bucketName: string,
  sourceDir: string,
  options?: {
    region?: string;
    onProgress?: (progress: UploadProgress) => void;
  },
): Promise<UploadResult> {
  const client = createS3Client(options?.region);

  const allFiles = collectFiles(sourceDir);
  const result: UploadResult = {
    uploaded: 0,
    failed: 0,
    totalBytes: 0,
    errors: [],
  };

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i]!;
    const key = relative(sourceDir, filePath).split("\\").join("/"); // normalise Windows paths
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

  return result;
}
