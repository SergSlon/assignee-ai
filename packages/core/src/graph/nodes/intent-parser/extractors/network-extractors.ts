// ---------------------------------------------------------------------------
// Network extractors — pulled from intent-parser.ts during RW7 decomposition.
// ---------------------------------------------------------------------------
//
// This module owns the network-shaped assertion extractors that share two
// concerns: CIDR-block validation (extractCidr, extractSgIngress) and AWS
// region tokenisation (extractRegion + maskNameSpans). Co-locating them
// keeps the regex-heavy parsing in one place and lets `KNOWN_AWS_REGIONS`
// stay private to the only function that consumes it.
//
// Public surface (consumed by extractors/orchestrate-extraction.ts):
//   - extractCidr
//   - extractRegion
//   - extractSgIngress
//   - extractNoVpcDirective
//
// `maskNameSpans` is a private helper used only by `extractRegion`. It is
// intentionally NOT exported — the masking heuristic is region-specific
// and other extractors should not rely on it.
//
// Import edges:
//   - `isValidCidr` from the sibling validators module (worker A's output).
//   - `RESOURCE_TYPES` from the core barrel — three `..` up from
//     `extractors/` to land in `packages/core/src/index.js`.
//   - `log`, `LOG_ACTIONS` from the logger barrel — used only by
//     `extractRegion` for the REGION_EXTRACTION instrumentation hook.

import { RESOURCE_TYPES } from "../../../../index.js";
import { log, LOG_ACTIONS } from "../../../../utils/logger/index.js";
import { isValidCidr } from "../validators/token-validators.js";

// ---------------------------------------------------------------------------
// KNOWN_AWS_REGIONS — closed set used by `extractRegion` to fail loudly on
// hallucinated region codes. Kept module-private; the orchestrator does
// not need to introspect the set.
// ---------------------------------------------------------------------------

const KNOWN_AWS_REGIONS: ReadonlySet<string> = new Set([
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "us-gov-east-1",
  "us-gov-west-1",
  "af-south-1",
  "ap-east-1",
  "ap-south-1",
  "ap-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ca-central-1",
  "ca-west-1",
  "cn-north-1",
  "cn-northwest-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "sa-east-1",
]);

/**
 * Extracts the first CIDR-shaped token from the intent and writes the
 * appropriate CFN field into `elicited` based on the resource context.
 *
 * Branches on `resourceType`:
 *   - VPC / Subnet → `CidrBlock` with `/16-/28` validation.
 *   - Route        → `DestinationCidrBlock` with `/0-/32` validation
 *                    (default routes legitimately span the whole prefix
 *                    space — `0.0.0.0/0`, host routes `/32`, etc.).
 *   - Other        → `__assertedCidr` informational hint.
 *
 * Adversarial CIDRs anywhere in the intent (not just the first token)
 * raise an error so a planted bad block can never reach the synthesiser.
 */
export function extractCidr(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  const cidrRegex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/g;
  const matches = intent.match(cidrRegex);
  if (!matches || matches.length === 0) return;

  // First CIDR token → CidrBlock (VPC / Subnet context) or
  // DestinationCidrBlock (Route) or informational hint (SG, etc.).
  // Additional CIDRs become SecurityGroupIngress sources downstream.
  const primary = matches[0]!;
  // Choose validation kind based on resource context.
  //   VPC / Subnet  → "vpc" (/16-/28, RFC 4632 + AWS VPC limits)
  //   Route         → "source" (/0-/32) — Route destinations legitimately
  //                   span the whole prefix space: 0.0.0.0/0 is the
  //                   canonical default route, /32 is a host route,
  //                   /16-/20 matches in-VPC routes. e96.W2.R6 —
  //                   rejecting 0.0.0.0/0 as a Route destination broke
  //                   the Route BP tests (B-03 regression of Epic 94
  //                   u.c.3).
  //   else (SG, …)  → "source" (/0-/32)
  const isVpcSizedCidrResource =
    resourceType === RESOURCE_TYPES.EC2_VPC ||
    resourceType === RESOURCE_TYPES.EC2_SUBNET;
  const isRouteDestinationResource = resourceType === RESOURCE_TYPES.EC2_ROUTE;
  const kind = isVpcSizedCidrResource ? "vpc" : "source";
  if (!isValidCidr(primary, kind)) {
    const hint = isVpcSizedCidrResource
      ? "Each octet must be 0-255 and the prefix must be 16-28 for a VPC."
      : "Each octet must be 0-255 and the prefix must be 0-32.";
    errors.push(
      `Invalid CIDR block "${primary}". Expected IPv4 CIDR (e.g. 10.0.0.0/16). ${hint}`,
    );
    return;
  }
  // VPC / Subnet → CidrBlock. Route → DestinationCidrBlock. Else → hint.
  if (isVpcSizedCidrResource) {
    elicited["CidrBlock"] = primary;
  } else if (isRouteDestinationResource) {
    elicited["DestinationCidrBlock"] = primary;
  } else {
    elicited["__assertedCidr"] = primary;
  }
  // Validate all CIDR tokens so adversarial inputs anywhere fail loudly.
  for (let i = 1; i < matches.length; i++) {
    if (!isValidCidr(matches[i]!, "source")) {
      errors.push(
        `Invalid CIDR block "${matches[i]}". Expected IPv4 CIDR (e.g. 10.0.0.0/16).`,
      );
    }
  }
}

/**
 * Mask `named <X>` / `called <X>` / `name=<X>` spans so the region
 * extractor never scans a user-supplied resource name. Replaces the
 * span body with spaces (length-preserving) so downstream indexing is
 * not disturbed.
 *
 * Epic 98 W2.R1 (B-09): the region regex accepts an alpha-alpha-digit
 * shape (`my-abc-1`), so any resource name with 2-3 lowercase leading
 * chars followed by a hyphenated digit tail would be classified as an
 * unknown region. The name is the user's to pick; we must NOT
 * recycle it as a region candidate.
 *
 * Module-private — do NOT export. Other extractors should not rely on
 * the mask shape, which is tightly coupled to the region regex.
 */
function maskNameSpans(intent: string): string {
  let masked = intent;
  // `named <span>` / `called <span>` — mirror the terminator set used
  // in extractResourceName. Case-insensitive; preserves length so the
  // later regex indices line up with the original intent.
  const spanRegex =
    /\b(?:named|called)\s+((?:\.(?=[A-Za-z0-9])|[^\n,;.?!])*)/gi;
  masked = masked.replace(spanRegex, (match) => " ".repeat(match.length));
  // `name=<token>` / `Name=<token>` — no whitespace between keyword
  // and value. Terminate on whitespace or clause punctuation.
  const kvRegex = /\bname\s*=\s*[^\s,;.?!]+/gi;
  masked = masked.replace(kvRegex, (match) => " ".repeat(match.length));
  return masked;
}

/**
 * Extracts an AWS region token from the intent and writes it to
 * `elicited["__assertedRegion"]` — fails on unknown region codes.
 *
 * Two-pass resolution (W2.R1):
 *   1. Prefer explicit region-tail: `region <X>` / `in <X>` / `at <X>`.
 *      The leading keyword is a loud assertion — trust it over anything
 *      that merely looks region-shaped.
 *   2. Fallback scan over the intent with `named <X>` / `called <X>` /
 *      `name=<X>` spans masked out (via `maskNameSpans`), so a bucket
 *      named `my-abc-1` cannot be misread as a region.
 *
 * Anchors use whitespace / string-boundary instead of JS `\b`: word
 * boundaries treat `-` as a word-boundary, which would let the regex
 * match a region-shaped substring buried inside a longer hyphenated
 * identifier (e.g. `us-east-1` inside `my-bucket-us-east-1`). The
 * intent-parser's job is to extract regions the user actually
 * asserted — not tokens that happen to pattern-match deep inside a
 * resource name.
 *
 * Emits a `REGION_EXTRACTION` log line for telemetry on every call,
 * including null-candidate "no region found" terminations.
 */
export function extractRegion(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  // e96.W1.B3 + e98.W2.R1 — Match region-shaped tokens with 2-4
  // hyphen-separated segments, the last segment being a number.
  // Examples we want to catch: us-east-1, eu-west-2, us-gov-east-1,
  // eu-west-fake-1. The last form is adversarial (C-13) — we need to
  // match it so validation can fail loudly rather than silently
  // accepting.
  const regionShape = /([a-z]{2,3}(?:-[a-z]+){1,3}-\d+)/;
  const tailRegex = new RegExp(
    `\\b(?:region|in|at)\\s+${regionShape.source}(?=\\s|$|[.,;:!?])`,
    "gi",
  );
  let candidate: string | undefined;
  let path: "tail" | "substring" | "none" = "none";
  let tailMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((tailMatch = tailRegex.exec(intent)) !== null) {
    const tok = tailMatch[1]!.toLowerCase();
    if (/^[a-z]{2,3}-/.test(tok)) {
      candidate = tok;
      path = "tail";
      break;
    }
  }
  if (candidate === undefined) {
    const masked = maskNameSpans(intent);
    const regionRegex =
      /(?<=^|\s)([a-z]{2,3}(?:-[a-z]+){1,3}-\d+)(?=\s|$|[.,;:!?])/g;
    const matches = masked.match(regionRegex);
    if (matches && matches.length > 0) {
      // Pick the first candidate whose leading segment is 2-3 lowercase
      // letters (the AWS convention) so we don't false-positive on
      // ami- / arn- / other prefixed tokens.
      candidate = matches.find((t) => /^[a-z]{2,3}-/.test(t));
      if (candidate !== undefined) {
        path = "substring";
      }
    }
  }
  if (candidate === undefined) {
    log({
      ts: new Date().toISOString(),
      runId: "",
      level: "info",
      action: LOG_ACTIONS.REGION_EXTRACTION,
      extras: { path, candidate: null },
    });
    return;
  }
  log({
    ts: new Date().toISOString(),
    runId: "",
    level: "info",
    action: LOG_ACTIONS.REGION_EXTRACTION,
    extras: { path, candidate },
  });
  if (!KNOWN_AWS_REGIONS.has(candidate)) {
    errors.push(
      `Unknown AWS region "${candidate}". Use a valid region code (e.g. us-east-1, eu-west-1, ap-southeast-2).`,
    );
    return;
  }
  elicited["__assertedRegion"] = candidate;
}

/**
 * Extracts security-group ingress port+CIDR+protocol triples from
 * "allowing port 443" / "allow port 22 from 0.0.0.0/0" / "port 8080
 * tcp" / "port 80-443" (range) / "open port 443" phrasings.
 *
 * Assembles one `SecurityGroupIngress` entry per port phrase found.
 * Defaults: protocol → tcp, CidrIp → `0.0.0.0/0`, ToPort → FromPort
 * for single-port phrases.
 *
 * Validation:
 *   - Ports must be 0-65535 (raises error otherwise).
 *   - CIDR sources must pass `isValidCidr(_, "source")` (/0-/32).
 *
 * Writes only when at least one valid ingress rule was assembled.
 */
export function extractSgIngress(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  // Phrases we match:
  //   "allowing port 443"
  //   "allow port 22 from 0.0.0.0/0"
  //   "port 8080 tcp"
  //   "port 80-443"  (range)
  //   "open port 443"
  // We assemble one SecurityGroupIngress entry per port phrase found.
  const phraseRegex =
    /\b(?:allow(?:ing)?|open(?:ing)?|port[s]?)\s+(?:tcp\s+|udp\s+)?(?:port\s+)?(\d{1,5})(?:-(\d{1,5}))?(?:\s+(?:from\s+)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}))?(?:\s+(tcp|udp|icmp))?/gi;
  const ingress: Array<Record<string, unknown>> = [];
  let match: RegExpExecArray | null;
  while ((match = phraseRegex.exec(intent)) !== null) {
    const fromPort = Number(match[1]);
    const toPort = match[2] !== undefined ? Number(match[2]) : fromPort;
    if (fromPort < 0 || fromPort > 65535 || toPort < 0 || toPort > 65535) {
      errors.push(
        `Invalid port "${match[1]}${match[2] !== undefined ? `-${match[2]}` : ""}". Ports must be 0-65535.`,
      );
      continue;
    }
    const cidr = match[3];
    if (cidr !== undefined && !isValidCidr(cidr, "source")) {
      errors.push(
        `Invalid CIDR block "${cidr}" in security-group ingress rule.`,
      );
      continue;
    }
    const protocol = (match[4] ?? "tcp").toLowerCase();
    ingress.push({
      IpProtocol: protocol,
      FromPort: fromPort,
      ToPort: toPort,
      CidrIp: cidr ?? "0.0.0.0/0",
    });
  }
  if (ingress.length > 0) {
    elicited["SecurityGroupIngress"] = ingress;
  }
}

/**
 * Detects an explicit "no VPC" / "standalone" directive in the intent
 * and stamps `elicited["__noVpc"] = true` so the planner skips the
 * default VPC attachment for SG resources.
 */
export function extractNoVpcDirective(
  intentLower: string,
  elicited: Record<string, unknown>,
): void {
  const noVpc =
    /\b(?:do not attach (?:to )?(?:any )?vpc|without (?:a|any) vpc|no vpc|standalone sg|standalone security group|not attached to any vpc)\b/.test(
      intentLower,
    );
  if (noVpc) elicited["__noVpc"] = true;
}
