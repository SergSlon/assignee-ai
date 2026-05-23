/**
 * Per-unit cost-rate detection — shared between sum/aggregation
 * helpers across bulk-destroy, admin list, and admin status.
 *
 * Many `estimatedMonthlyCost` strings reaching the CLI's renderers
 * are NOT flat monthly amounts but per-unit RATES (e.g.
 * `$0.0230/GB-month`, `$0.40/1000 requests`). Naively parsing them
 * with `/\$?([\d.]+)/` extracts the leading number ("0.0230") and
 * treats it as a fixed total — producing nonsense sums like
 * "$0.05/month" for two S3 buckets of unknown size.
 *
 * The fix everywhere is the same: detect the rate suffix, exclude
 * the value from the sum, and surface a `≥` lower-bound prefix in
 * the displayed total. This module centralises the detection so the
 * three callers cannot drift apart.
 *
 * @see _backlog/wizard-ux-audit-2026-05-22.md F6 (bulk-destroy)
 * @see _backlog/wizard-ux-audit-2026-05-22.md F16 (admin list)
 * @see _backlog/wizard-ux-audit-2026-05-22.md F19 (admin status)
 *
 * The patterns intentionally err on the side of CATCHING rates:
 * a false-positive (one rate-like string that's actually a flat
 * cost) only shifts the displayed total slightly low and adds a
 * "≥" prefix — a false-NEGATIVE would re-introduce the original
 * "$0.05/month" bug. Add new patterns as additional AWS price
 * shapes appear.
 */

/**
 * Regexes that identify per-unit cost-rate strings.
 *
 * Coverage:
 *   - `/GB-month`, `/GB-mo`, `/GB`               — S3, EBS, EFS storage rates
 *   - `/request`, `/requests`, `/req`, `/reqs`   — API / CloudFront per-request
 *   - `/1000 requests`, `/1k reqs`               — S3 / DynamoDB per-1k rate
 *   - `/call`, `/invocation`, `/exec`            — Lambda / Step Functions
 */
export const PER_UNIT_RATE_PATTERNS: readonly RegExp[] = [
  /\/GB(-month|-mo)?\b/i,
  /\/req(uest)?s?\b/i,
  /\/(1000|1k)\s*req(uest)?s?\b/i,
  /\/(call|invocation|exec)s?\b/i,
];

/**
 * Returns true when the cost string looks like a per-unit rate rather
 * than a flat monthly amount. Case-insensitive.
 *
 * Examples:
 *   isPerUnitRate("$0.0230/GB-month")           → true
 *   isPerUnitRate("$0.40/1000 requests")        → true
 *   isPerUnitRate("$0.0000002/invocation")      → true
 *   isPerUnitRate("$7.59/month")                → false
 *   isPerUnitRate("$0")                         → false
 *   isPerUnitRate("N/A")                        → false
 *   isPerUnitRate("Free")                       → false
 */
export function isPerUnitRate(costStr: string): boolean {
  return PER_UNIT_RATE_PATTERNS.some((re) => re.test(costStr));
}
