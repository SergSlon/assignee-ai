/**
 * Vitest global setup — runs before each test file's imports are resolved.
 *
 * Story 48-11: ensure AWS_REGION is a valid region string even when the
 * outer shell exports `AWS_REGION=""` (empty-creds CI). Module-level
 * constants like `config/constants.ts#AWS_REGION` use `?? "us-east-1"`
 * which does NOT catch empty strings (only null/undefined). Setting the
 * env var here — before any module is loaded — guarantees the fallback
 * fires correctly.
 */
if (!process.env["AWS_REGION"]) {
  process.env["AWS_REGION"] = "us-east-1";
}
