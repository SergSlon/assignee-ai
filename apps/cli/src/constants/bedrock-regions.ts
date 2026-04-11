/**
 * Canonical list of AWS regions where Bedrock + the Anthropic Claude /
 * Amazon Nova models are confirmed enabled and available.
 *
 * Story 46.5 (2026-04-12): this list used to live inline in
 * `services/llm-adapter.ts`, forcing a CLI release every time Bedrock
 * added a new region. Extracting it to a dedicated constants module
 * gives us a single source of truth and a clean seam for a future
 * `.assignee/config.yaml`-driven override (Phase 2 — deferred until a
 * user actually hits the gap).
 *
 * Snapshot date: 2026-04. Confirmed via Bedrock console region picker
 * in us-east-1 + us-west-2 + eu-central-1 accounts on 2026-04-08.
 *
 * This is intentionally a SHORT list (the canonical "everyone uses
 * these" regions) rather than the exhaustive AWS region availability
 * matrix — the goal is "give the user a working AWS_REGION value",
 * not "document AWS service availability". When a region is missing
 * from this list but IS Bedrock-enabled for the user's account, the
 * detectBedrockRegionError hint still accepts an explicit AWS_REGION
 * override; the list only drives the "try one of these" suggestion
 * text in the error message.
 *
 * @see services/llm-adapter.ts — consumer (detectBedrockRegionError)
 */
export const KNOWN_BEDROCK_REGIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-central-1",
  "eu-west-1",
  "eu-west-3",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
] as const;
