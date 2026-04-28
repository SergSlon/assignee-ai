// ---------------------------------------------------------------------------
// Compute extractors — EC2 instance type, AMI ID, RDS engine version.
// ---------------------------------------------------------------------------
//
// Extracted verbatim from `intent-parser.ts` as part of RW7 decomposition.
// Each function pre-extracts a user-asserted token from the natural-language
// intent and writes it to `elicitedOptions` (validated) or appends an
// actionable error string to `errors[]` (rejected). Defaults engine downstream
// only fills absent keys; never overrides an assertion.
//
// TODO(RW7-merge): once `validators/token-validators.ts` (worker A) lands,
// replace the temporary local copies of `INSTANCE_FAMILY_PREFIXES`,
// `isValidInstanceType`, `isValidAmiId`, `isValidEngineVersion`, and
// `mentionsDatabaseEngine` below with imports from
// `../validators/token-validators.js`. The constants and functions are
// duplicated here to keep this file independently compilable in the parallel
// extraction window; once the validators module exists the duplicates must
// be deleted to avoid drift (a single source of truth for the family-prefix
// allow-list is mandatory — see manifest §Risks/cross-cluster gotchas #1).

// ---------------------------------------------------------------------------
// TEMPORARY LOCAL COPIES (delete once worker A lands — see TODO above)
// ---------------------------------------------------------------------------

/**
 * Recognised EC2 instance-family prefixes. Shared with `isValidInstanceType`
 * in the validators module — kept in sync there once worker A lands.
 */
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
 * Validates an EC2 instance-type token against a known-family set.
 * Returns true only when both the family prefix (e.g. `t3`) and the
 * size suffix (e.g. `micro`) are recognised. Rejects hallucinated
 * values like `t99.huge` — finding C-13.
 */
function isValidInstanceType(value: string): boolean {
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
function isValidAmiId(value: string): boolean {
  return /^ami-([0-9a-f]{8}|[0-9a-f]{17})$/.test(value);
}

/** Matches an RDS-compatible engine version tuple like `16.3` or `8.0.35`. */
function isValidEngineVersion(value: string): boolean {
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
