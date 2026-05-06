/**
 * Post-provision hooks for the static-website flow (Story 37.4, Task 4b).
 *
 * - uploadStaticSiteFiles: uploads a local source directory to S3 after the
 *   bucket is provisioned. Non-blocking — upload failures warn but never
 *   mark the provision as failed.
 * - printStaticWebsiteCloudFrontUrl: prints the CloudFront URL using the real
 *   DNS-resolvable hostname from ResourceResult.metadata.cloudFrontDomainName.
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import { type ResourceResult, RESOURCE_TYPES } from "@/index.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function uploadStaticSiteFiles(
  bucketName: string,
  sourceDir: string,
): Promise<void> {
  const { uploadStaticSite } = await import("@/services/s3-upload.js");

  const spinner = clack.spinner();
  spinner.start("Uploading files...");

  const result = await uploadStaticSite(bucketName, sourceDir, {
    onProgress: (p: { current: number; total: number; file: string }) => {
      spinner.message(`Uploading ${p.current}/${p.total}: ${p.file}`);
    },
  });

  spinner.stop(
    `Uploaded ${result.uploaded} files (${formatBytes(result.totalBytes)})`,
  );

  if (result.failed > 0) {
    process.stderr.write(
      chalk.yellow(`⚠ ${result.failed} files failed to upload\n`),
    );
    for (const err of result.errors) {
      process.stderr.write(chalk.dim(`  ${err.file}: ${err.error}\n`));
    }
  }
}

/**
 * Extract the bucket name from either a bare CCAPI identifier (which IS the
 * bucket name post-V6 P0 fix) or a full arn:aws:s3:::<name> ARN (defensive
 * fallback in case a future code path stores the full form).
 */
export function parseBucketName(resourceArn: string): string {
  return resourceArn.startsWith("arn:")
    ? (resourceArn.split(":::")[1] ?? "")
    : resourceArn;
}

/**
 * Print the CloudFront URL for a completed static-website compound.
 *
 * The distribution hostname is sourced from `ResourceResult.metadata.cloudFrontDomainName`,
 * which is populated by the status_poller from `ProgressEvent.ResourceModel.DomainName`
 * returned by GetResourceRequestStatus when the CREATE operation succeeds.
 *
 * IMPORTANT: CloudFront distribution IDs (e.g. "E3B1MIRNBPH9JG") are NOT hostnames.
 * The real DNS-resolvable hostname (e.g. "d1eka2i9dtl8tu.cloudfront.net") is an
 * AWS-assigned value that bears no relationship to the distribution ID. Using the
 * distribution ID as a hostname produces a broken URL that NXDOMAIN-fails in DNS.
 *
 * If `DomainName` is unavailable (e.g. provisioned by an older version or CCAPI did
 * not return ResourceModel), a fallback hint is printed with the manual
 * `aws cloudfront get-distribution` command instead of a broken URL.
 */
export function printStaticWebsiteCloudFrontUrl(
  completedResources: readonly ResourceResult[],
): void {
  const distribution = completedResources.find(
    (r) =>
      r.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
      r.resourceArn,
  );
  if (!distribution?.resourceArn) return;
  const distributionId = distribution.resourceArn;
  const domainName = distribution.metadata?.cloudFrontDomainName;

  if (domainName) {
    const cfUrl = `https://${domainName}`;
    process.stdout.write(
      chalk.cyan(`\n☁ CloudFront distribution created: ${cfUrl}\n`),
    );
    process.stdout.write(chalk.dim(`  Distribution ID: ${distributionId}\n`));
    process.stdout.write(
      chalk.dim(
        "  Status: propagating (may take 5-15 minutes before traffic flows)\n",
      ),
    );
    process.stdout.write(chalk.green(`  Recommended URL: ${cfUrl}\n`));
  } else {
    // Fallback: DomainName not captured (CCAPI did not return ResourceModel).
    // Print a clear diagnostic instead of a broken <id>.cloudfront.net URL.
    process.stdout.write(
      chalk.cyan(`\n☁ CloudFront distribution created: ${distributionId}\n`),
    );
    process.stdout.write(chalk.dim(`  Distribution ID: ${distributionId}\n`));
    process.stdout.write(
      chalk.dim(
        "  Status: propagating (may take 5-15 minutes before traffic flows)\n",
      ),
    );
    process.stdout.write(
      chalk.yellow(
        `  URL unavailable — run: aws cloudfront get-distribution --id ${distributionId} --query Distribution.DomainName --output text\n`,
      ),
    );
  }
}

/**
 * Drive the S3 upload for a single resource with defensive error handling.
 * Emits the "upload failed" warning banner in the same shape the existing
 * tests assert on.
 */
export async function runStaticSiteUploadFor(
  resourceArn: string,
  sourceDir: string,
): Promise<void> {
  const bucketName = parseBucketName(resourceArn);
  if (!bucketName) {
    process.stderr.write(
      chalk.yellow(`⚠ Could not parse bucket name from ARN: ${resourceArn}\n`),
    );
    return;
  }
  try {
    await uploadStaticSiteFiles(bucketName, sourceDir);
  } catch (err) {
    process.stderr.write(
      chalk.yellow(
        `⚠ File upload failed: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
    );
    process.stderr.write(
      chalk.dim(
        "  Files can be uploaded manually: aws s3 sync <dir> s3://<bucket>\n",
      ),
    );
  }
}
