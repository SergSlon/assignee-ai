/**
 * Canonical list of AWS regions where Bedrock + the Anthropic Claude /
 * Amazon Nova models are confirmed enabled and available.
 *
 * Lifted from `apps/cli/src/constants/bedrock-regions.ts` in Story 50-4
 * Wave 5.1 so the in-core LLM Bedrock-region helper (also lifted in
 * Wave 5.1) can use it without reaching back into the CLI. The CLI's
 * old path becomes a thin re-export shim.
 *
 * Intentionally a SHORT list (the canonical "everyone uses these"
 * regions) rather than the exhaustive AWS region availability matrix.
 * The goal is "give the user a working AWS_REGION value", not
 * "document AWS service availability".
 *
 * // Source: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html — verified 2026-04-25
 * W5-05 (P007-tech → L1-F09): added eu-west-2 (London) + eu-north-1 (Stockholm).
 * Additive only — no regions removed.
 */
export const KNOWN_BEDROCK_REGIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
] as const;
