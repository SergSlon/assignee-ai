// ---------------------------------------------------------------------------
// intent-parser/validators/token-validators.ts
// ---------------------------------------------------------------------------
//
// Foundation cluster (RW7-A): leaf-level token validators + the shared
// instance-type prefix/suffix sets used by both the validators themselves
// and the sibling compute-extractor cluster (Epic 92 wave 2 user-asserted
// token extraction).
//
// Invariant: this module imports from ZERO other intent-parser cluster files.
// Validators are pure string predicates with no I/O, no logger, no graph
// state, and no AWS-SDK dependencies — they must remain trivially testable
// and side-effect-free so callers can use them in hot paths (extraction
// runs once per user intent and inside the LLM-classification branch).
//
// Public exports (consumed by sibling clusters via this file's path):
//   - isValidCidr               (validators)              — also re-exported
//                                                            via index.ts so
//                                                            the public API
//                                                            shim keeps
//                                                            external test
//                                                            consumers
//                                                            unchanged.
//   - isValidInstanceType       (validators)              — ditto.
//   - isValidAmiId              (validators)              — ditto.
//   - isValidEngineVersion      (validators)              — ditto.
//   - INSTANCE_FAMILY_PREFIXES  (constant)                — needed by the
//                                                            compute-extractor
//                                                            cluster's
//                                                            extractInstanceType.
//                                                            Single source
//                                                            of truth — DO
//                                                            NOT redeclare
//                                                            elsewhere.
//   - mentionsDatabaseEngine    (predicate)               — needed by the
//                                                            compute-extractor
//                                                            cluster's
//                                                            extractEngineVersion.
//   - containsNonAscii          (predicate)               — needed by the
//                                                            name-extractor
//                                                            cluster's
//                                                            extractResourceName.
//
// Internal (file-private):
//   - INSTANCE_SIZE_SUFFIXES — used only by isValidInstanceType; kept
//     unexported so downstream clusters cannot drift the suffix set.

/**
 * Known RDS DB instance-class family tokens (the part after `db.` and before
 * the size suffix). Source-of-truth: `classifyRdsFamily` in
 * `packages/core/src/utils/aws-resource-discovery/rds.ts` — mirrors the
 * families handled there plus common legacy options.
 *
 * Note: RDS families share many tokens with EC2 families but are prefixed
 * by `db.` in the actual class string (e.g. `db.t4g.micro`). This set
 * contains ONLY the family token without the `db.` prefix so it can be
 * matched generically.
 */
export const RDS_INSTANCE_FAMILY_PREFIXES: ReadonlySet<string> = new Set([
  // Burstable (db.t*)
  "t2",
  "t3",
  "t3a",
  "t4g",
  // General purpose (db.m*)
  "m4",
  "m5",
  "m5d",
  "m6g",
  "m6i",
  "m7g",
  // Memory optimised (db.r* / db.x*)
  "r4",
  "r5",
  "r5b",
  "r6g",
  "r6i",
  "r7g",
  "x1",
  "x1e",
  "x2g",
]);

/** Full regex for a valid RDS DB instance class: `db.<family>.<size>`. */
export const RDS_INSTANCE_CLASS_REGEX =
  /\bdb\.([a-z][0-9][a-z]*[0-9]*[a-z]?)\.([a-z0-9]+)\b/gi;

/** Known EC2 instance-type family prefixes (current-gen + common legacy). */
export const INSTANCE_FAMILY_PREFIXES: ReadonlySet<string> = new Set([
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
 * Validates an RDS `DBInstanceClass` token (e.g. `db.t4g.micro`).
 * Returns true only when the family prefix AND size suffix are both
 * known. Rejects hallucinated values like `db.zz.xxlarge`.
 *
 * Note: `INSTANCE_SIZE_SUFFIXES` is shared with EC2 — RDS classes use
 * the same size vocabulary (micro, small, medium, large, xlarge, …).
 */
export function isValidDbInstanceClass(value: string): boolean {
  const lower = value.toLowerCase();
  // Must start with "db."
  if (!lower.startsWith("db.")) return false;
  const rest = lower.slice(3); // strip "db."
  const dot = rest.indexOf(".");
  if (dot < 1) return false;
  const family = rest.slice(0, dot);
  const size = rest.slice(dot + 1);
  return (
    RDS_INSTANCE_FAMILY_PREFIXES.has(family) && INSTANCE_SIZE_SUFFIXES.has(size)
  );
}

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
export function mentionsDatabaseEngine(intentLower: string): boolean {
  return /\b(postgres(ql)?|mysql|mariadb|aurora|oracle|sql server|sqlserver|rds|db\s*engine)\b/.test(
    intentLower,
  );
}

/**
 * True when the input string contains any code point outside ASCII
 * (0x00-0x7F). Used to detect `dögfood-ünicode` (non-ASCII → S3
 * forbids, Lambda forbids, most AWS name types forbid).
 */
export function containsNonAscii(s: string): boolean {
  // Walk char-by-char. Avoids regex to keep the rule obvious and
  // dependency-free.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) return true;
  }
  return false;
}
