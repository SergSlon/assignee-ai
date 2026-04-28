// ---------------------------------------------------------------------------
// Compute extractors — EC2 instance type, AMI ID, RDS engine version.
// ---------------------------------------------------------------------------
//
// Extracted verbatim from `intent-parser.ts` as part of RW7 decomposition.
// Each function pre-extracts a user-asserted token from the natural-language
// intent and writes it to `elicitedOptions` (validated) or appends an
// actionable error string to `errors[]` (rejected). Defaults engine downstream
// only fills absent keys; never overrides an assertion.

import {
  INSTANCE_FAMILY_PREFIXES,
  isValidAmiId,
  isValidEngineVersion,
  isValidInstanceType,
  mentionsDatabaseEngine,
} from "../validators/token-validators.js";

// ---------------------------------------------------------------------------
// Compute extractors
// ---------------------------------------------------------------------------

/** Extracts an EC2 instance-type token; fails on unknown family/size. */
export function extractInstanceType(
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
export function extractAmiId(
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

/** Extracts an RDS engine-version token when the intent signals RDS. */
export function extractEngineVersion(
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
