import { z } from "zod";
import {
  ExecutionStatus,
  PatternId,
  RESOURCE_TYPES,
  SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES,
  defaultPatternRegistry,
  renderSupportedTypesHint,
  sanitizeUserIntent,
} from "../../index.js";
import type { LlmPort } from "../../index.js";
import {
  resolveCompoundPatternIdLiteral,
  resolveSingletonOverride,
} from "../../intent/compound-keywords.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import type { AgentState } from "../graph-state.js";

/**
 * Human-readable hint shown when an unsupported resource type is
 * requested. Pulled from the core help-hints single source of truth
 * (Story 54-it1-04) so the node's errorMessage, the CLI's `--help`
 * output, and the MCP plan-resource tool all render from the same
 * registry-derived strings. The `short` style omits the EFS/CFN
 * detail lines to keep the inline graph-state errorMessage compact.
 */
const SUPPORTED_TYPES_HINT = renderSupportedTypesHint("short");

const intentParserSchema = z.object({
  resourceType: z.enum([...SUPPORTED_TYPES, "UNSUPPORTED"] as [
    string,
    ...string[],
  ]),
});

// ---------------------------------------------------------------------------
// Epic 92 wave 2 — user-asserted token extraction.
// ---------------------------------------------------------------------------
//
// The defaults engine (intent-defaults/) historically rewrote user-asserted
// values: e.g. "t3.micro web server" was rewritten to t3.small, "10.42.0.0/16"
// silently overridden to 10.0.0.0/16. The parser now pre-extracts tokens
// from the user's natural-language intent and writes them to
// `elicitedOptions` before the defaults engine runs. Defaults only fill
// absent keys; they never override an assertion.
//
// Invalid asserted values fail the plan with an actionable error — no
// silent fallback. This closes findings B-01, B-07, B-09, B-16, C-12,
// C-13, A-03.

/** Known EC2 instance-type family prefixes (current-gen + common legacy). */
const INSTANCE_FAMILY_PREFIXES: ReadonlySet<string> = new Set([
  // Burstable
  "t2",
  "t3",
  "t3a",
  "t4g",
  // General purpose
  "m4",
  "m5",
  "m5a",
  "m5n",
  "m6i",
  "m6a",
  "m6g",
  "m7i",
  "m7g",
  // Compute optimised
  "c4",
  "c5",
  "c5a",
  "c5n",
  "c6i",
  "c6a",
  "c6g",
  "c7i",
  "c7g",
  // Memory optimised
  "r4",
  "r5",
  "r5a",
  "r5b",
  "r5n",
  "r6i",
  "r6a",
  "r6g",
  "r7i",
  "r7g",
  "x1",
  "x1e",
  "x2iezn",
  "x2iedn",
  "x2idn",
  "z1d",
  // Storage optimised
  "i3",
  "i3en",
  "i4i",
  "d2",
  "d3",
  "d3en",
  "h1",
  // Accelerated
  "p3",
  "p4d",
  "p4de",
  "p5",
  "g3",
  "g4dn",
  "g5",
  "g5g",
  "inf1",
  "inf2",
  "trn1",
  // Legacy
  "a1",
]);

/** Known EC2 instance-size suffixes. */
const INSTANCE_SIZE_SUFFIXES: ReadonlySet<string> = new Set([
  "nano",
  "micro",
  "small",
  "medium",
  "large",
  "xlarge",
  "2xlarge",
  "3xlarge",
  "4xlarge",
  "6xlarge",
  "8xlarge",
  "9xlarge",
  "10xlarge",
  "12xlarge",
  "16xlarge",
  "18xlarge",
  "24xlarge",
  "32xlarge",
  "48xlarge",
  "metal",
]);

/**
 * Standard AWS commercial + GovCloud regions. Kept local to the parser
 * so validation doesn't depend on runtime MCP calls — the parser runs
 * before any MCP resolution and should fail fast on hallucinated
 * region strings.
 */
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

/** Validates VPC-grade CIDR (/16-/28) per RFC 4632 + AWS VPC limits. */
export function isValidCidr(value: string, kind: "vpc" | "source"): boolean {
  const cidrRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
  const match = cidrRegex.exec(value);
  if (!match) return false;
  const octets = [match[1], match[2], match[3], match[4]].map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return false;
  const prefix = Number(match[5]);
  if (kind === "vpc") return prefix >= 16 && prefix <= 28;
  return prefix >= 0 && prefix <= 32;
}

/**
 * Validates an EC2 instance-type token against a known-family set.
 * Returns true only when both the family prefix (e.g. `t3`) and the
 * size suffix (e.g. `micro`) are recognised. Rejects hallucinated
 * values like `t99.huge` — finding C-13.
 */
export function isValidInstanceType(value: string): boolean {
  const lower = value.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot < 1) return false;
  const family = lower.slice(0, dot);
  const size = lower.slice(dot + 1);
  return (
    INSTANCE_FAMILY_PREFIXES.has(family) && INSTANCE_SIZE_SUFFIXES.has(size)
  );
}

/** Matches the AWS AMI identifier format (`ami-` + 8 or 17 lowercase hex). */
export function isValidAmiId(value: string): boolean {
  return /^ami-([0-9a-f]{8}|[0-9a-f]{17})$/.test(value);
}

/** Matches an RDS-compatible engine version tuple like `16.3` or `8.0.35`. */
export function isValidEngineVersion(value: string): boolean {
  if (!/^\d+(\.\d+){1,2}$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  // Reject 99.99 / 999.* adversarial inputs — AWS RDS engine majors are all
  // below 20 for commercial engines (Postgres 17, MySQL 8.x, MariaDB 11.x,
  // Oracle 21, SQL Server 16, Aurora 3.x). Minor/patch can go higher but
  // an all-nines tuple is a clear hallucination signal.
  if (parts[0] !== undefined && parts[0] >= 50) return false;
  return true;
}

/** User-intent signals engine-version is being discussed. */
function mentionsDatabaseEngine(intentLower: string): boolean {
  return /\b(postgres(ql)?|mysql|mariadb|aurora|oracle|sql server|sqlserver|rds|db\s*engine)\b/.test(
    intentLower,
  );
}

/**
 * Structured advisory attached to the plan envelope when the parser
 * silently drops or alters a user-supplied token (e.g. the trailing
 * words of a multi-word `named` clause). Distinct from `errors[]`
 * which halts the plan — advisories are non-blocking diagnostics the
 * user should see but which don't invalidate the intent.
 *
 * Epic 94 Wave 1 fixer e94.R8 — closes A-06 (MED REGRESSION): before
 * this, `named bad bucket name` silently captured `bad` and dropped
 * `bucket name` with no user signal.
 *
 * Epic 94 Wave 2 fixer e94.N5 — extended with optional `details` to
 * carry structured `{from, to}` diffs for `NAME_REWRITTEN` and
 * `BP_ADJUSTED_VALUE` advisories. Additive field — pre-N5 consumers
 * read only `code` / `message` / `hint` and continue to work.
 */
export interface Advisory {
  /** Stable machine-readable code (e.g. `NAME_REMAINDER_IGNORED`). */
  code: string;
  /** Human-readable summary of what was dropped or altered. */
  message: string;
  /** Actionable fix hint so the user can rephrase. */
  hint: string;
  /**
   * Optional structured payload — e.g. `{from: "192.168.1.1", to:
   * "ip-192-168-1-1"}` for NAME_REWRITTEN, or `{field:
   * "RetentionInDays", from: 14, to: 30}` for BP_ADJUSTED_VALUE.
   * Consumers that pre-date N5 ignore this field.
   */
  details?: Record<string, unknown>;
}

export interface AssertionExtraction {
  elicited: Record<string, unknown>;
  errors: string[];
  /** Non-blocking advisories — e.g. trailing name tokens that were ignored. */
  advisories: Advisory[];
}

/**
 * Pre-extract user-asserted values from the natural-language intent.
 *
 * The extractor is intentionally conservative: a token is recognised only
 * when it is unambiguous (CIDR shape, AMI shape, known instance family
 * prefix + suffix, known region). Tokens that LOOK like an assertion but
 * fail validation produce a user-visible error — we never silently fall
 * back to defaults on an adversarial input.
 *
 * @param intent  Sanitised user intent string.
 * @param resourceType  Resolved resource type (may be empty for pattern match).
 */
export function extractAssertedValues(
  intent: string,
  resourceType: string,
): AssertionExtraction {
  const elicited: Record<string, unknown> = {};
  const errors: string[] = [];
  const advisories: Advisory[] = [];
  const intentLower = intent.toLowerCase();

  extractCidr(intent, resourceType, elicited, errors);
  extractInstanceType(intent, elicited, errors);
  extractAmiId(intent, elicited, errors);
  extractRegion(intent, elicited, errors);
  extractEngineVersion(intent, intentLower, elicited, errors);
  extractResourceName(intent, resourceType, elicited, errors, advisories);
  extractSgIngress(intent, elicited, errors);
  extractNoVpcDirective(intentLower, elicited);
  extractSnsProtocol(intent, intentLower, resourceType, elicited);
  extractRetentionDays(intent, intentLower, resourceType, elicited);

  return { elicited, errors, advisories };
}

/** Extracts the first CIDR-shaped token; fails on invalid. */
function extractCidr(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  const cidrRegex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/g;
  const matches = intent.match(cidrRegex);
  if (!matches || matches.length === 0) return;

  // First CIDR token → CidrBlock (VPC / Subnet / Route context)
  // Additional CIDRs become SecurityGroupIngress sources downstream.
  const primary = matches[0]!;
  // Choose validation kind based on resource context. VPC / Subnet / Route
  // demand /16-/28; SG sources can be /0-/32.
  const isNetworkResource =
    resourceType === RESOURCE_TYPES.EC2_VPC ||
    resourceType === RESOURCE_TYPES.EC2_SUBNET ||
    resourceType === RESOURCE_TYPES.EC2_ROUTE;
  const kind = isNetworkResource ? "vpc" : "source";
  if (!isValidCidr(primary, kind)) {
    errors.push(
      `Invalid CIDR block "${primary}". Expected IPv4 CIDR (e.g. 10.0.0.0/16). Each octet must be 0-255 and the prefix must be 16-28 for a VPC.`,
    );
    return;
  }
  // Network resources → CidrBlock; other resources → informational hint.
  if (isNetworkResource) {
    elicited["CidrBlock"] = primary;
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

/** Extracts an EC2 instance-type token; fails on unknown family/size. */
function extractInstanceType(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  // Match `<family>.<size>` word-bounded — e.g. t3.micro, m5.large, p4d.24xlarge.
  // Allow alphanumeric family tokens but keep the match tight so we don't
  // pick up unrelated dotted strings (hostnames, file names, etc.).
  const typeRegex = /\b([a-z][0-9][a-z]*[0-9]*[a-z]?)\.([a-z0-9]+)\b/gi;
  let match: RegExpExecArray | null;
  let found: string | null = null;
  while ((match = typeRegex.exec(intent)) !== null) {
    const token = match[0].toLowerCase();
    // Skip tokens that don't look like <family>.<size> at all (hostnames etc.)
    const family = match[1]!.toLowerCase();
    if (!INSTANCE_FAMILY_PREFIXES.has(family)) continue;
    if (!isValidInstanceType(token)) {
      errors.push(
        `Unknown EC2 instance type "${match[0]}". Use a valid family (t3, m5, c5, r5, ...) and size (micro, small, medium, large, xlarge, ...).`,
      );
      return;
    }
    found = token;
    break;
  }

  // Second pass: catch shapes that LOOK like an instance type but whose
  // family is unrecognised (adversarial "t99.huge"). Only fail if the
  // token is in an EC2/instance context — otherwise hostnames with dots
  // would trigger a false positive.
  if (!found) {
    const ctxRegex =
      /\b(?:ec2|instance|instance\s+type|compute)\b[^\n.]{0,120}?\b([a-z][0-9][a-z]*[0-9]*[a-z]?)\.([a-z0-9]+)\b/i;
    const ctxMatch = ctxRegex.exec(intent);
    if (ctxMatch) {
      const candidate = `${ctxMatch[1]!.toLowerCase()}.${ctxMatch[2]!.toLowerCase()}`;
      if (!isValidInstanceType(candidate)) {
        errors.push(
          `Unknown EC2 instance type "${candidate}". Use a valid family (t3, m5, c5, r5, ...) and size (micro, small, medium, large, xlarge, ...).`,
        );
        return;
      }
    }
  }

  if (found) elicited["InstanceType"] = found;
}

/** Extracts an AMI id; fails on malformed hex. */
function extractAmiId(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  const amiRegex = /\bami-[0-9a-zA-Z]{1,17}\b/g;
  const match = intent.match(amiRegex);
  if (!match || match.length === 0) return;
  const token = match[0]!;
  if (!isValidAmiId(token)) {
    errors.push(
      `Invalid AMI ID "${token}". Expected ami- followed by 8 or 17 hex characters (0-9a-f).`,
    );
    return;
  }
  elicited["ImageId"] = token;
}

/** Extracts an AWS region token; fails on unknown region. */
function extractRegion(
  intent: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  // Match region-shaped tokens with 2-4 hyphen-separated segments, the
  // last segment being a number. Examples we want to catch:
  //   us-east-1, eu-west-2, us-gov-east-1, eu-west-fake-1
  // The last form is adversarial (C-13) — we need to match it so
  // validation can fail loudly rather than silently accepting.
  const regionRegex = /\b([a-z]{2,3}(?:-[a-z]+){1,3}-\d+)\b/g;
  const matches = intent.match(regionRegex);
  if (!matches || matches.length === 0) return;
  // Pick the first candidate whose leading segment is 2-3 lowercase
  // letters (the AWS convention) so we don't false-positive on
  // ami- / arn- / other prefixed tokens.
  const candidate = matches.find((t) => /^[a-z]{2,3}-/.test(t));
  if (!candidate) return;
  if (!KNOWN_AWS_REGIONS.has(candidate)) {
    errors.push(
      `Unknown AWS region "${candidate}". Use a valid region code (e.g. us-east-1, eu-west-1, ap-southeast-2).`,
    );
    return;
  }
  elicited["__assertedRegion"] = candidate;
}

/** Extracts an RDS engine-version token when the intent signals RDS. */
function extractEngineVersion(
  intent: string,
  intentLower: string,
  elicited: Record<string, unknown>,
  errors: string[],
): void {
  if (!mentionsDatabaseEngine(intentLower)) return;
  // semver-like token, allowing 1-2 dots (16.3 or 8.0.35).
  const verRegex = /\b(\d+\.\d+(?:\.\d+)?)\b/g;
  let match: RegExpExecArray | null;
  while ((match = verRegex.exec(intent)) !== null) {
    const token = match[1]!;
    // Skip tokens that look like a CIDR fragment (already handled) or a
    // duration ("8.0" in "8.0 seconds") — require the engine-version
    // token to sit within ~40 chars of an engine keyword.
    const lo = Math.max(0, match.index - 40);
    const window = intentLower.slice(lo, match.index + token.length + 40);
    if (
      !/\b(postgres(ql)?|mysql|mariadb|aurora|oracle|sql server|sqlserver|version|engine)\b/.test(
        window,
      )
    ) {
      continue;
    }
    if (!isValidEngineVersion(token)) {
      errors.push(
        `Invalid RDS engine version "${token}". Use a supported version for your engine (e.g. Postgres 16.3, MySQL 8.0.35).`,
      );
      return;
    }
    elicited["EngineVersion"] = token;
    return;
  }
}

// ---------------------------------------------------------------------------
// Resource-name extractor (Epic 94 Wave 1 fixer e94.R8 — A-05 + A-06)
// ---------------------------------------------------------------------------
//
// Background: the previous extractor used
//   /\b(?:named|called)\s+['"]?([A-Za-z][A-Za-z0-9_-]{0,63})\b/
// which has two silent-data-loss bugs:
//
//   - Non-ASCII characters short-circuit the capture group. Input
//     `named dögfood-ünicode` captures just `d` (the `ö` is not in
//     `[A-Za-z0-9_-]`, so the quantifier ends after the first char).
//     R1's `validateDesiredStateNode` then sees a 1-char string and
//     rejects it with a generic length error instead of the real
//     "non-ASCII character" error the user needs. Worse: if the
//     captured prefix happened to be ≥3 chars, the validator would
//     accept a silently-mangled name.
//
//   - Multi-word names like `named bad bucket name` silently capture
//     only `bad`, discarding the trailing tokens. The plan succeeds
//     with the WRONG bucket name and the user has no signal the tail
//     was dropped.
//
// Fix: capture the full raw span after `named ` / `called ` up to a
// conservative boundary (known directive keyword, punctuation, or
// end-of-intent). Quoted spans preserve internal whitespace. Classify
// the result:
//
//   - Non-ASCII in the leading chunk → push INVALID_NAME error; no
//     `elicited` write so R1's validator does not see a mangled
//     value.
//   - Quoted span honouring spaces → treat the full quoted content
//     as the name (no advisory).
//   - Unquoted single token → write to the name field as before.
//   - Unquoted with trailing tail after a space → write the leading
//     token but also attach a NAME_REMAINDER_IGNORED advisory so the
//     user sees that their tail was discarded.

/**
 * Keywords that follow a name in natural-language AWS intents and
 * signal the name has ended. Used to trim trailing directive clauses
 * ("with versioning", "in us-east-1", "for the web tier") from the
 * raw remainder before we look for a leftover name tail.
 */
const NAME_BOUNDARY_KEYWORDS: ReadonlySet<string> = new Set([
  // Directive prepositions / connectives — these introduce a
  // configuration clause, not additional name tokens.
  "with",
  "for",
  "in",
  "on",
  "using",
  "allowing",
  "allow",
  "that",
  "which",
  "to",
  "from",
  "at",
  "and",
  "plus",
  "but",
  "where",
  "having",
  // Common config adjectives that appear right after a name.
  "encrypted",
  "versioned",
  "versioning",
  "tagged",
]);

/**
 * Return true when any char in `s` is outside the basic ASCII range
 * (0x00-0x7F). Used to detect `dögfood-ünicode` (non-ASCII → S3
 * forbids, Lambda forbids, most AWS name types forbid).
 */
function containsNonAscii(s: string): boolean {
  // Walk char-by-char. Avoids regex to keep the rule obvious and
  // dependency-free.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) return true;
  }
  return false;
}

/**
 * Parse the raw span after the "named " / "called " keyword into
 * either a quoted name (any chars between matching quotes) or an
 * unquoted leading token plus a trailing tail.
 *
 * Trailing boundary keywords ("with", "in", "for", …) terminate the
 * name so a clause like "named app-logs with versioning" does NOT
 * produce a `with versioning` remainder advisory.
 */
interface ParsedName {
  /** The captured name itself — unquoted, whitespace-preserving if quoted. */
  name: string;
  /** Tail tokens that followed the leading token and were NOT directive keywords. */
  remainder: string;
  /** True when the original form used `"..."` or `'...'`. */
  quoted: boolean;
}

function parseNameSpan(rawSpan: string): ParsedName | null {
  const trimmed = rawSpan.trimStart();
  if (trimmed.length === 0) return null;

  // Quoted form — honour any characters (including spaces) inside the
  // matched quote pair. Unicode rejection still applies at the caller.
  const quoteChar = trimmed[0];
  if (quoteChar === '"' || quoteChar === "'") {
    const end = trimmed.indexOf(quoteChar, 1);
    if (end > 1) {
      return {
        name: trimmed.slice(1, end),
        remainder: "",
        quoted: true,
      };
    }
    // Unterminated quote — fall through to unquoted parsing so we
    // don't silently drop the rest of the intent.
  }

  // Unquoted — the leading token is the first contiguous non-whitespace
  // run. We do NOT strip trailing punctuation at this stage because
  // "named 192.168.1.1" carries internal dots that are part of the
  // name (they need to survive so R1's validator sees the IPv4 shape
  // and rejects it). Sentence-ending punctuation is already excluded
  // by the outer span regex (`[^\n,;.?!]*`) — the leading token here
  // is guaranteed not to end in `.`, `,`, `;`, `?`, or `!`.
  //
  // Subsequent whitespace-delimited tokens form the raw tail; we cut
  // the tail at the first directive-keyword boundary so
  // "named app-logs with versioning" does not carry `with versioning`
  // as a name remainder.
  const match = /^(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return null;
  const leading = match[1]!;
  const tailRaw = (match[2] ?? "").trim();

  let remainderBeforeBoundary = "";
  if (tailRaw.length > 0) {
    const tokens = tailRaw.split(/\s+/);
    const accepted: string[] = [];
    for (const tok of tokens) {
      // Stop copying as soon as a directive keyword appears — the
      // user has transitioned from naming into configuration.
      if (NAME_BOUNDARY_KEYWORDS.has(tok.toLowerCase())) break;
      accepted.push(tok);
    }
    remainderBeforeBoundary = accepted.join(" ").trim();
  }

  return {
    name: leading,
    remainder: remainderBeforeBoundary,
    quoted: false,
  };
}

/**
 * Extracts "named X" / "called X" resource identifier.
 *
 * Epic 94 e94.R8 overhaul:
 *   - Captures multi-word / quoted spans (not just the first ASCII word).
 *   - Rejects unicode names with an explicit `INVALID_NAME` error
 *     surfaced through the standard `[ERROR]+[FIX]` path.
 *   - Emits a `NAME_REMAINDER_IGNORED` advisory when trailing tokens
 *     are dropped so the user knows their tail was ignored.
 */
function extractResourceName(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  errors: string[],
  advisories: Advisory[],
): void {
  // Grab the entire span after the "named" / "called" keyword up to
  // a conservative terminator: newline, clause-ending punctuation, or
  // end-of-intent. The span may include whitespace, unicode, and
  // quotes — classification happens in `parseNameSpan` below.
  //
  // Terminators:
  //   - `\n`, `,`, `;`, `?`, `!`  (always end the clause)
  //   - `.` ONLY when it is NOT followed by an alphanumeric
  //     character. `192.168.1.1` keeps its internal dots intact
  //     because each `.` is followed by a digit; but "named
  //     my-bucket. It must be encrypted" ends at the first `.` because
  //     the next char is a space.
  //
  // Using case-insensitive match so "Named", "NAMED", "Called" all
  // trigger the same path.
  const spanRegex = /\b(?:named|called)\s+((?:\.(?=[A-Za-z0-9])|[^\n,;.?!])*)/i;
  const match = spanRegex.exec(intent);
  if (!match) return;

  // Strip a single trailing clause-punctuation run (defensive — the
  // regex above already excludes them at the end, but covers the
  // case where the last `.` was part of a valid compound token
  // followed by end-of-string).
  const rawSpan = (match[1] ?? "").replace(/[.,;?!]+$/, "");
  const parsed = parseNameSpan(rawSpan);
  if (!parsed || parsed.name.length === 0) return;

  // A-05: non-ASCII characters are rejected EVERYWHERE in AWS
  // resource names (S3, Lambda, SQS, IAM, …). Surface an explicit
  // INVALID_NAME error instead of writing a silently-truncated
  // ASCII prefix that R1's validator would misattribute.
  if (containsNonAscii(parsed.name)) {
    errors.push(
      `Invalid resource name "${parsed.name}" — non-ASCII characters are not allowed. AWS resource names (S3 buckets, Lambda functions, SQS queues, IAM roles, …) must be ASCII-only. Rename using letters, digits, and hyphens.`,
    );
    return;
  }

  // A-06: unquoted multi-word remainder → emit advisory so the user
  // sees that their tail was dropped. Quoted spans are treated as a
  // single intentional name — no advisory even when they contain
  // whitespace.
  if (!parsed.quoted && parsed.remainder.length > 0) {
    advisories.push({
      code: "NAME_REMAINDER_IGNORED",
      message: `Ignored trailing tokens after the resource name: "${parsed.remainder}". Only "${parsed.name}" was used as the resource identifier.`,
      hint: `Use quotes to include spaces in the name (e.g. named "${parsed.name} ${parsed.remainder}"), or join the words with hyphens (e.g. ${parsed.name}-${parsed.remainder.replace(/\s+/g, "-")}).`,
    });
  }

  // Route the captured name to the correct CFN property. `resolveNameField`
  // returns null for types without a user-settable name — in that case the
  // captured value is silently dropped (no advisory, because there is no
  // name slot to put it in).
  const nameField = resolveNameField(resourceType);
  if (nameField) elicited[nameField] = parsed.name;
}

/**
 * Resolve the CFN property name that carries the user-settable resource
 * name for a given resource type. Returns `null` when the type has no
 * such field (e.g., EC2::Instance uses tags for naming, not a top-level
 * `Name` property).
 *
 * Exported so the plan-stage NAME_REWRITTEN comparator (N5) can
 * resolve the same field without duplicating the switch.
 */
export function resolveNameField(resourceType: string): string | null {
  switch (resourceType) {
    case RESOURCE_TYPES.LAMBDA_FUNCTION:
      return "FunctionName";
    case RESOURCE_TYPES.DYNAMODB_TABLE:
      return "TableName";
    case RESOURCE_TYPES.SNS_TOPIC:
      return "TopicName";
    case RESOURCE_TYPES.SQS_QUEUE:
      return "QueueName";
    case RESOURCE_TYPES.S3_BUCKET:
      return "BucketName";
    case RESOURCE_TYPES.ECS_CLUSTER:
      return "ClusterName";
    case RESOURCE_TYPES.ECR_REPOSITORY:
      return "RepositoryName";
    case RESOURCE_TYPES.LOGS_LOG_GROUP:
      return "LogGroupName";
    case RESOURCE_TYPES.IAM_ROLE:
      return "RoleName";
    default:
      return null;
  }
}

/** Extracts SG ingress port+CIDR+protocol triples. */
function extractSgIngress(
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

/** Extracts explicit "no VPC" / "standalone" directive. */
function extractNoVpcDirective(
  intentLower: string,
  elicited: Record<string, unknown>,
): void {
  const noVpc =
    /\b(?:do not attach (?:to )?(?:any )?vpc|without (?:a|any) vpc|no vpc|standalone sg|standalone security group|not attached to any vpc)\b/.test(
      intentLower,
    );
  if (noVpc) elicited["__noVpc"] = true;
}

/** Extracts SNS::Subscription Protocol from Endpoint token. */
function extractSnsProtocol(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  if (resourceType !== RESOURCE_TYPES.SNS_SUBSCRIPTION) return;
  // URL scheme → protocol (most common, closes D-26 half).
  const httpsMatch = /\bhttps:\/\/\S+/i.exec(intent);
  const httpMatch = /\bhttp:\/\/\S+/i.exec(intent);
  const sqsArnMatch = /arn:aws[\w-]*:sqs:[^\s"']+/i.exec(intent);
  const lambdaArnMatch = /arn:aws[\w-]*:lambda:[^\s"']+/i.exec(intent);
  const emailMatch = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.exec(intent);
  if (httpsMatch) {
    elicited["Protocol"] = "https";
    elicited["Endpoint"] = httpsMatch[0];
    return;
  }
  if (httpMatch) {
    elicited["Protocol"] = "http";
    elicited["Endpoint"] = httpMatch[0];
    return;
  }
  if (sqsArnMatch) {
    elicited["Protocol"] = "sqs";
    elicited["Endpoint"] = sqsArnMatch[0];
    return;
  }
  if (lambdaArnMatch) {
    elicited["Protocol"] = "lambda";
    elicited["Endpoint"] = lambdaArnMatch[0];
    return;
  }
  if (emailMatch && /\b(email|notify|subscribe)\b/.test(intentLower)) {
    elicited["Protocol"] = "email";
    elicited["Endpoint"] = emailMatch[0];
  }
}

/**
 * Extract an explicit "N days retention" clause for
 * `AWS::Logs::LogGroup`. The plan-generator's downstream comparator
 * raises this value to the BP minimum (30) when necessary and emits
 * a `BP_ADJUSTED_VALUE` advisory. Stored in `elicitedOptions` as an
 * integer (matching the CFN schema type).
 *
 * Epic 94 Wave 2 fixer e94.N5 — required for finding D-05 so the
 * comparator has a concrete asserted value to compare against.
 */
function extractRetentionDays(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  if (resourceType !== RESOURCE_TYPES.LOGS_LOG_GROUP) return;
  if (!/\bretention\b|\bretain\b/.test(intentLower)) return;
  // Accept "14 days retention" / "14-day retention" / "retention 14
  // days" / "retention of 14 days". Bound the number to 1-3652.
  const patterns: RegExp[] = [
    /\b(\d{1,4})[-\s]*days?\s+retention\b/i,
    /\bretention\s+(?:of\s+)?(\d{1,4})\s*days?\b/i,
    /\bretain\s+(?:for\s+)?(\d{1,4})\s*days?\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(intent);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    elicited["RetentionInDays"] = n;
    return;
  }
}

/**
 * Maps a compound PatternId to the primary AWS resource type that owns
 * the user-facing "named <x>" field in that pattern. Used to dispatch
 * {@link resolveNameField} inside the pattern-detect branch so
 * user-specified names (e.g. FunctionName, BucketName, ClusterName) are
 * preserved on the resource that actually carries them.
 *
 * Returns `null` for patterns whose resource set has no single
 * name-bearing resource or whose named resources are heterogeneous —
 * callers pass `""` to preserve today's no-op behavior for those.
 *
 * Epic 94 wave 1 fixer e94.R2 — closes regression A-02 introduced by
 * Epic 92 Story 92.1.a (the pattern-detect branch was passing `""`
 * for resource type, which caused user-named tokens to be dropped).
 */
function patternPrimaryResourceType(patternId: string): string | null {
  switch (patternId) {
    case PatternId.LAMBDA_WITH_EXEC_ROLE:
    case PatternId.SERVERLESS_API:
    case PatternId.SCHEDULED_LAMBDA:
    case PatternId.WEBSOCKET_API:
      return RESOURCE_TYPES.LAMBDA_FUNCTION;
    case PatternId.CONTAINER_SERVICE:
      return RESOURCE_TYPES.ECS_CLUSTER;
    case PatternId.MESSAGE_PROCESSING:
      return RESOURCE_TYPES.SQS_QUEUE;
    case PatternId.STATIC_WEBSITE:
      return RESOURCE_TYPES.S3_BUCKET;
    // EFS_WITH_VPC / THREE_TIER_WEB have no single name-bearing resource
    // that resolveNameField understands — fall through to null so the
    // caller preserves today's behavior (no regression).
    default:
      return null;
  }
}

/**
 * Merge a newly-emitted advisory list with any advisories already on
 * state (e.g. seeded by a prior graph run-through or a checkpoint
 * resume). Concatenates dedup-free because each run-through of the
 * node produces at most a handful of advisories; duplicates from the
 * same run are a bug-in-caller, not a merge concern.
 */
function mergeAdvisories(
  existing: Advisory[] | undefined,
  added: Advisory[],
): Advisory[] | undefined {
  if (added.length === 0) return existing;
  return [...(existing ?? []), ...added];
}

/**
 * Factory for the intent_parser LangGraph node.
 * Accepts llmClient via injection — no direct @ai-sdk imports.
 *
 * @see Story 9.5 — LLM client decoupling (M3)
 *
 * Epic 94 Wave 2 fixer e94.N5 adds two pre-`detect()` classification
 * passes:
 *
 *   1. Singleton-override cues (C-08, C-09): "mount target" / "http
 *      api gateway" force the classifier to a specific singleton
 *      resource type, overriding the registry's compound match.
 *   2. Pattern-ID literal lookup (C-07): if the intent contains one
 *      of the 6 literal pattern-IDs (case-insensitive, token-
 *      bounded), look up the pattern directly via
 *      `registry.get(patternId)` instead of going through `detect()`.
 *      Bypasses negativeKeywords — the user was explicit.
 */
export function createIntentParserNode({ llmClient }: { llmClient: LlmPort }) {
  return async function intentParserNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    // Sanitize user intent first (NFR-16: Prompt Injection Protection)
    const safeIntent = sanitizeUserIntent(state.userIntent);

    // ---------------------------------------------------------------
    // Step 1 — Singleton-override cues (C-08, C-09).
    // ---------------------------------------------------------------
    //
    // "Create an EFS mount target" must produce a single
    // AWS::EFS::MountTarget, not the 10-resource efs-with-vpc
    // compound. "Create an HTTP API Gateway" must produce a single
    // AWS::ApiGatewayV2::Api, not the 8-resource serverless-api
    // compound. These override the registry entirely.
    const singletonType = resolveSingletonOverride(safeIntent);
    if (singletonType !== null) {
      // Validate against SUPPORTED_TYPES — if the override targets an
      // unsupported type the override is silently ignored (defence in
      // depth; today both cues target supported types).
      if (!(SUPPORTED_TYPES as readonly string[]).includes(singletonType)) {
        // fall through to normal dispatch
      } else {
        const extraction = extractAssertedValues(safeIntent, singletonType);
        if (extraction.errors.length > 0) {
          return {
            userIntent: safeIntent,
            executionStatus: ExecutionStatus.FAILED,
            errorMessage: `Intent validation failed: ${extraction.errors.join(" ")}`,
          };
        }
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.INTENT_PARSED,
          extras: { resourceType: singletonType, pattern: null },
        });
        const merged = mergeElicited(
          state.elicitedOptions,
          extraction.elicited,
        );
        const mergedPresets = mergePresetFields(
          state.presetFields,
          extraction.elicited,
        );
        const mergedAdvisories = mergeAdvisories(
          state.advisories,
          extraction.advisories,
        );
        return {
          userIntent: safeIntent,
          resourceType: singletonType,
          ...(merged !== undefined ? { elicitedOptions: merged } : {}),
          ...(mergedPresets !== undefined
            ? { presetFields: mergedPresets }
            : {}),
          ...(mergedAdvisories !== undefined
            ? { advisories: mergedAdvisories }
            : {}),
        };
      }
    }

    // ---------------------------------------------------------------
    // Step 2 — Pattern-ID literal lookup (C-07).
    // ---------------------------------------------------------------
    //
    // Literal pattern-ID strings in the intent ("static-website",
    // "serverless-api", …) take precedence over the registry's
    // keyword matcher. The user has been explicit about which
    // compound they want — skip the negativeKeywords filter.
    const literalPatternId = resolveCompoundPatternIdLiteral(safeIntent);
    const literalPattern =
      literalPatternId !== null
        ? defaultPatternRegistry.get(literalPatternId)
        : undefined;

    // ---------------------------------------------------------------
    // Step 3 — Normal pattern detection (registry-level substring match).
    // ---------------------------------------------------------------
    const detectedPattern =
      literalPattern ?? defaultPatternRegistry.detect(safeIntent);
    if (detectedPattern !== undefined && detectedPattern !== null) {
      // Pre-extract asserted tokens so compound-plan consumers (downstream
      // wave) can honour user-specified CIDR / region / names even when
      // the pattern matcher short-circuits the LLM classifier.
      //
      // Epic 94 R2 / A-02: infer the primary resource type from the
      // pattern id so `resolveNameField` dispatches correctly and a
      // user-specified `named <x>` token lands on the right field
      // (FunctionName / BucketName / ClusterName / QueueName).
      const primaryType =
        patternPrimaryResourceType(detectedPattern.patternId) ?? "";
      const extraction = extractAssertedValues(safeIntent, primaryType);
      if (extraction.errors.length > 0) {
        return {
          userIntent: safeIntent,
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `Intent validation failed: ${extraction.errors.join(" ")}`,
        };
      }
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { resourceType: null, pattern: detectedPattern.patternId },
      });
      const merged = mergeElicited(state.elicitedOptions, extraction.elicited);
      const mergedPresets = mergePresetFields(
        state.presetFields,
        extraction.elicited,
      );
      const mergedAdvisories = mergeAdvisories(
        state.advisories,
        extraction.advisories,
      );
      return {
        userIntent: safeIntent,
        resourcePattern: detectedPattern,
        ...(merged !== undefined ? { elicitedOptions: merged } : {}),
        ...(mergedPresets !== undefined ? { presetFields: mergedPresets } : {}),
        ...(mergedAdvisories !== undefined
          ? { advisories: mergedAdvisories }
          : {}),
      };
    }

    // Bedrock classification — uses sanitized intent.
    // Wave-4 F5 P2-R2-6: three disambiguation sentences were added so that
    // "Create a standalone X" / "Create an X on its own" always classifies
    // as the bare X type instead of being rerouted through a compound
    // pattern. Needed to unblock three previously-skipped E2E plan tests
    // for bare RDS DBInstance / Events Connection / Events ApiDestination
    // — each is first-class in SUPPORTED_TYPES but the LLM defaulted to
    // compound-style routing without explicit guidance.
    const prompt = `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.
If the request says "standalone", "bare", "single", "on its own", or "just the X" (or otherwise explicitly asks for one resource in isolation), classify it as that exact type — do NOT reroute to a compound / multi-resource pattern even if the resource is usually deployed alongside others.
Events::Connection and Events::ApiDestination ARE first-class types in this list — classify as those when the intent is to create the Connection or ApiDestination itself, even without an accompanying Rule or EventBus.
RDS::DBInstance is first-class and MUST be classified as AWS::RDS::DBInstance when the request asks for a standalone database, regardless of whether a VPC / subnet group is mentioned.

Request: "${safeIntent}"`;
    const [err, output] = await llmClient.generateStructured(
      prompt,
      intentParserSchema,
      { callsite: "intent_parser", runId: state.runId },
    );

    if (err) {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Intent parsing failed. Hint: check Bedrock connectivity and AWS credentials. Error: ${err.message}`,
      };
    }

    if (output.resourceType === "UNSUPPORTED") {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage: `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
      };
    }

    // Extract asserted tokens against the resolved resource type so the
    // CIDR / name / ingress rules land on the right CFN properties.
    const extraction = extractAssertedValues(safeIntent, output.resourceType);
    if (extraction.errors.length > 0) {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Intent validation failed: ${extraction.errors.join(" ")}`,
      };
    }

    // Type safe cast since zod enum is derived from SUPPORTED_TYPES
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: { resourceType: output.resourceType, pattern: null },
    });
    const merged = mergeElicited(state.elicitedOptions, extraction.elicited);
    const mergedPresets = mergePresetFields(
      state.presetFields,
      extraction.elicited,
    );
    const mergedAdvisories = mergeAdvisories(
      state.advisories,
      extraction.advisories,
    );
    return {
      userIntent: safeIntent,
      resourceType: output.resourceType,
      ...(merged !== undefined ? { elicitedOptions: merged } : {}),
      ...(mergedPresets !== undefined ? { presetFields: mergedPresets } : {}),
      ...(mergedAdvisories !== undefined
        ? { advisories: mergedAdvisories }
        : {}),
    };
  };
}

/**
 * Merge parser-asserted values with any pre-existing elicitedOptions
 * (e.g. seeded from checkpoint resume). Parser assertions win only when
 * the key is absent — preserving prior state keeps the "additive only"
 * invariant from Epic 92 wave 2 plan.
 */
function mergeElicited(
  existing: Record<string, unknown> | undefined,
  asserted: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const assertedKeys = Object.keys(asserted);
  if (assertedKeys.length === 0) return existing;
  const base = existing ?? {};
  const merged: Record<string, unknown> = { ...base };
  for (const key of assertedKeys) {
    if (!(key in merged)) merged[key] = asserted[key];
  }
  return merged;
}

/**
 * Scalar asserted values (strings / booleans / numbers) are also mirrored
 * into `presetFields` so the option-elicitor's `applyPresetFields` path
 * (NEVER_ASK policy) propagates them through both the expert and wizard
 * paths without relying on downstream reads of `state.elicitedOptions`.
 *
 * Arrays and object values stay in `elicitedOptions` only — `presetFields`
 * is typed `Record<string, string>` and downstream consumers do their own
 * coercion (`"true"` → `true`). Array values (e.g., SecurityGroupIngress)
 * land in `elicitedOptions` where the LLM plan-merge step picks them up.
 *
 * Keys prefixed with `__` are parser-internal informational hints and are
 * NOT mirrored to presetFields — they are not real CFN properties.
 */
function mergePresetFields(
  existing: Record<string, string> | undefined,
  asserted: Record<string, unknown>,
): Record<string, string> | undefined {
  const base: Record<string, string> = { ...(existing ?? {}) };
  let changed = false;
  for (const [key, value] of Object.entries(asserted)) {
    if (key.startsWith("__")) continue;
    if (key in base) continue;
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      base[key] = String(value);
      changed = true;
    }
  }
  if (!changed && existing === undefined) return undefined;
  return base;
}
