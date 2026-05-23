/**
 * Advice post-filters — suppress self-referential and stale advice lines.
 *
 * Self-referential advice: advice that tells the planner to do what the
 * user ALREADY asked (e.g. "Change the TopicName to 'genai-next-events'"
 * when the plan already has `TopicName: "genai-next-events"`).
 *
 * Stale advice: advice describing a property change that matches the
 * value already present in the plan (DF-A2/B3/C4/D4/E4 carryovers).
 *
 * The filter is CONSERVATIVE:
 *   - Only suppresses when the proposed value EXACTLY matches what is
 *     already in the plan.
 *   - Genuine guidance ("Consider Multi-AZ for production reliability",
 *     "Use Reserved Instances for sustained workloads") is preserved.
 *   - IAM / cost-actionable hints are never pattern-matched here.
 *
 * @see Story SX-6 — Suppress self-referential advice lines (PH1-C-4)
 */

/**
 * Patterns that introduce a direct planner instruction.
 * Each regex captures the proposed value in capture group 1 so the
 * caller can cross-reference against the plan.
 */

interface MatchPattern {
  /** Regex applied to the advice line. */
  regex: RegExp;
  /** Extract the proposed string value from match groups. Returns undefined when not determinable. */
  extractValue: (match: RegExpMatchArray) => string | undefined;
  /** Extract the property key from match groups. Returns undefined when not determinable. */
  extractKey: (match: RegExpMatchArray) => string | undefined;
}

/**
 * "Change the <Property> to '<Value>'"
 * "Change <Property> to '<Value>'"
 */
const CHANGE_TO_PATTERN: MatchPattern = {
  regex: /\bchange\s+(?:the\s+)?(\w+)\s+to\s+['"`]([^'"`]+)['"`]/i,
  extractValue: (m) => m[2],
  extractKey: (m) => m[1],
};

/**
 * "Set <Property> to <Value> to match the user intent"
 * "Set the <Property> to '<Value>'"
 */
const SET_TO_PATTERN: MatchPattern = {
  regex:
    /\bset\s+(?:the\s+)?(\w+)\s+to\s+['"`]?([^'"`,.]+?)['"`]?(?:\s+to\s+match|\s+for\s+|\s*$)/i,
  extractValue: (m) => m[2]?.trim(),
  extractKey: (m) => m[1],
};

/**
 * "Update the <Property> to '<Value>'"
 */
const UPDATE_TO_PATTERN: MatchPattern = {
  regex: /\bupdate\s+(?:the\s+)?(\w+)\s+to\s+['"`]([^'"`]+)['"`]/i,
  extractValue: (m) => m[2],
  extractKey: (m) => m[1],
};

/**
 * Stale already-applied boolean/flag patterns:
 * "Enable <PropertyName>" when plan already has <PropertyName>: true
 */
const ENABLE_PATTERN: MatchPattern = {
  regex: /\benable\s+(\w[\w.]+)/i,
  extractValue: (_m) => undefined, // boolean check — no string value needed
  extractKey: (m) => m[1],
};

const ALL_PATTERNS: MatchPattern[] = [
  CHANGE_TO_PATTERN,
  SET_TO_PATTERN,
  UPDATE_TO_PATTERN,
  ENABLE_PATTERN,
];

/**
 * Recursively search for a property key in the plan object.
 * Keys are matched case-insensitively to tolerate CamelCase drift.
 *
 * Returns the value if found, or `undefined`.
 */
function findPlanValue(
  plan: Record<string, unknown>,
  targetKey: string,
): unknown {
  const lower = targetKey.toLowerCase();
  for (const [k, v] of Object.entries(plan)) {
    if (k.toLowerCase() === lower) return v;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const nested = findPlanValue(v as Record<string, unknown>, targetKey);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Returns true when the advice line should be suppressed.
 *
 * Suppression criteria:
 *   - The line matches a direct-instruction pattern, AND
 *   - The proposed value is already present in the plan for that key.
 *
 * For "Enable <Property>": suppressed when plan[property] is truthy (true / "enabled" / non-empty).
 */
function isSelfReferential(
  line: string,
  plan: Record<string, unknown>,
): boolean {
  for (const pattern of ALL_PATTERNS) {
    const match = line.match(pattern.regex);
    if (!match) continue;

    const key = pattern.extractKey(match);
    if (!key) continue;

    const planValue = findPlanValue(plan, key);
    if (planValue === undefined) continue; // key absent → keep the advice

    if (pattern === ENABLE_PATTERN) {
      // Stale boolean advice: suppress if plan value is truthy
      if (
        planValue === true ||
        planValue === "enabled" ||
        planValue === "true"
      ) {
        return true;
      }
      continue;
    }

    const proposedValue = pattern.extractValue(match);
    if (proposedValue === undefined) continue;

    // Stringify plan value for comparison (handles numbers stored as strings)
    const planStr = String(planValue).trim();
    if (planStr === proposedValue.trim()) {
      return true;
    }
  }
  return false;
}

/**
 * Post-filter pass applied to all advice hint lines before render.
 *
 * Removes lines that:
 *   1. Use a "Change/Set/Update/Enable" verb pattern, AND
 *   2. The proposed change already matches the current plan value.
 *
 * Lines that do NOT match any pattern are always preserved (e.g.
 * "Consider Multi-AZ for production reliability",
 * "Use Reserved Instances for sustained workloads").
 *
 * @param adviceLines  Raw advice strings from LLM + rule-based advisors.
 * @param plan         The current desiredState / plan object to cross-reference.
 * @returns            Filtered lines with self-referential entries removed.
 */
export function filterSelfReferentialAdvice(
  adviceLines: string[],
  plan: Record<string, unknown>,
): string[] {
  return adviceLines.filter((line) => !isSelfReferential(line, plan));
}

/**
 * F11 insurance (2026-05-23) — filter LLM-generated advice that
 * contradicts emitted BP findings.
 *
 * Class of failure mode: the LLM advice block is free-text and is NOT
 * fact-checked against the structured BP rule output. A PTY-driven
 * audit captured the LLM recommending `t2.micro` in the Advice block
 * while BP-EC2-015 ("EC2 instance should use current generation
 * instance type") emitted in the same plan output. Two contradictory
 * signals in one render.
 *
 * Concrete patterns suppressed (one per emitted finding family):
 *
 *   BP-EC2-015 fired                  → drop any advice line that
 *     ("current generation")             names a previous-gen EC2 type
 *                                        (t1/t2, m1/m2/m3/m4, c1/c3/c4,
 *                                         r3/r4, i2)
 *
 *   BP-EC2-002 fired                  → drop any advice line that
 *     ("EBS volumes encrypted")          explicitly recommends an
 *                                        unencrypted EBS volume or
 *                                        `Encrypted: false`
 *
 *   BP-S3-001 / 002 / 003 / 004       → drop any advice line that
 *     ("S3 public-access blocking")      recommends a public-read
 *                                        canned ACL or disabling a
 *                                        PublicAccessBlock control
 *
 * The filter is CONSERVATIVE:
 *
 *   - Only fires when the finding is actually present in the
 *     emitted set for this plan.
 *   - Only matches explicit anti-fix tokens (instance-type prefixes,
 *     canned ACL values, literal `Encrypted: false` / `BlockPublicAcls
 *     = false` settings); does NOT match prose that merely mentions
 *     the topic ("encryption is important", "review public access").
 *   - When in doubt, the advice line is KEPT (no false-positive
 *     filtering of legitimate guidance).
 *
 * This is "insurance" rather than load-bearing — the LLM doesn't
 * always emit contradictory advice. But the latent failure mode is
 * real and one rendered contradiction shakes user trust in the whole
 * output. New finding families can be added by following the
 * `{is<Family>Finding, names<AntiFix>}` predicate pair below.
 *
 * @see _backlog/wizard-ux-audit-2026-05-22.md F11
 *
 * @param adviceLines  Raw advice strings from LLM + rule-based advisors.
 * @param findings     The set of BPFindings emitted for the plan.
 * @returns            Filtered lines with contradicting entries removed.
 */
interface MinimalFinding {
  practiceId: string;
  title: string;
}

/**
 * Word-boundary regex matching a previous-generation EC2 instance
 * type token: `<family>.<size>` where:
 *
 *   <family>: t1, t2 (burstable),
 *             m1, m2, m3, m4 (general purpose),
 *             c1, c3, c4 (compute optimised),
 *             r3, r4 (memory optimised),
 *             i2 (storage optimised, HDD-dense)
 *   <size>:   nano | micro | small | medium | large | xlarge | <N>xlarge
 *
 * Requires both `\b` boundaries so doc-URL fragments like `/c3.html`
 * or section references like `see c3. of the guide` do NOT match
 * (Quinn HIGH-1 — Pre-existing FP in the original substring-prefix
 * implementation that violated the conservative-keep posture).
 */
const PREV_GEN_INSTANCE_REGEX =
  /\b(?:t[12]|m[1-4]|c[134]|r[34]|i2)\.(?:nano|micro|small|medium|large|x?large|\d+xlarge)\b/i;

/** Predicate matching the BP-EC2-015 finding by id or title fragment. */
function isCurrentGenFinding(f: MinimalFinding): boolean {
  if (f.practiceId === "BP-EC2-015") return true;
  return f.title.toLowerCase().includes("current generation instance type");
}

/** Predicate matching an advice line that names a previous-gen type. */
function namesPreviousGenInstance(line: string): boolean {
  return PREV_GEN_INSTANCE_REGEX.test(line);
}

/**
 * EBS encryption — BP-EC2-002 enforces `Encrypted: true` on the
 * BlockDeviceMappings[*].Ebs of every EC2 instance. The LLM
 * occasionally emits cost-flavoured advice that contradicts:
 * "to save on storage, use unencrypted EBS volumes" or literal
 * config snippets containing `Encrypted: false`.
 */
function isEbsEncryptionFinding(f: MinimalFinding): boolean {
  if (f.practiceId === "BP-EC2-002") return true;
  const lower = f.title.toLowerCase();
  return lower.includes("ebs") && lower.includes("encrypt");
}

const EBS_DISABLE_ENCRYPTION_PATTERNS: readonly RegExp[] = [
  // `Encrypted: false` / `Encrypted=false` / `"Encrypted": false`
  /\bencrypted\s*["']?\s*[:=]\s*false\b/i,
  // "unencrypted EBS / volume / disk / block storage"
  /\bunencrypted\s+(?:ebs|volume|disk|block\s+storage)\b/i,
  // "disable EBS encryption" / "skip encryption" / "turn off encryption"
  /\b(?:disable|remove|skip|turn\s+off)\s+(?:ebs\s+)?encryption\b/i,
];

function namesEbsDisableEncryption(line: string): boolean {
  return EBS_DISABLE_ENCRYPTION_PATTERNS.some((re) => re.test(line));
}

/**
 * S3 public-access — the BP-S3-001 / 002 / 003 / 004 family enforces
 * the four PublicAccessBlock controls. The LLM occasionally emits
 * advice suggesting public-read canned ACLs (for "easy CDN" / "static
 * website hosting") or literal config snippets disabling a
 * PublicAccessBlock field. Both directly contradict the emitted
 * findings.
 */
const BP_S3_PUBLIC_ACCESS_IDS: ReadonlySet<string> = new Set([
  "BP-S3-001", // BlockPublicAcls
  "BP-S3-002", // BlockPublicPolicy
  "BP-S3-003", // IgnorePublicAcls
  "BP-S3-004", // RestrictPublicBuckets
]);

function isS3PublicAccessFinding(f: MinimalFinding): boolean {
  if (BP_S3_PUBLIC_ACCESS_IDS.has(f.practiceId)) return true;
  const lower = f.title.toLowerCase();
  if (!lower.startsWith("s3 bucket")) return false;
  return (
    lower.includes("public") &&
    (lower.includes("acl") ||
      lower.includes("access") ||
      lower.includes("policies") ||
      lower.includes("policy"))
  );
}

const S3_PUBLIC_ACCESS_PATTERNS: readonly RegExp[] = [
  // Canned ACL values that grant public access (lowercase-hyphen
  // form, as written in CFN/Terraform/awscli). Negative lookbehind
  // ensures we don't match phrases like "deny public-read" /
  // "block public-read" / "disallow public-read" / "prevent
  // public-read" — those are pro-block recommendations and should be
  // kept. Only the raw token (or an "allow / grant / use / set …
  // public-read" preface) trips the filter.
  /(?<!\b(?:deny|block|disallow|prevent|restrict)\s+)\bpublic-read(?:-write)?\b/i,
  // Canned ACL values in CamelCase form (as written in the AWS SDKs
  // — `BucketCannedACL.PublicRead`, `ObjectCannedACL.PublicReadWrite`).
  // LLMs trained on SDK code regularly emit this casing. No lookbehind
  // needed: SDK-style references almost never appear inside negation
  // prose in advice text (Quinn HIGH-2).
  /\b(?:PublicRead|PublicReadWrite)\b/,
  // Literal `BlockPublicAcls: false` / `IgnorePublicAcls = false` /
  // `RestrictPublicBuckets: false` / `BlockPublicPolicy: false`.
  /\b(?:BlockPublicAcls|BlockPublicPolicy|IgnorePublicAcls|RestrictPublicBuckets)\s*["']?\s*[:=]\s*false\b/i,
];

function namesS3PublicAccessGrant(line: string): boolean {
  return S3_PUBLIC_ACCESS_PATTERNS.some((re) => re.test(line));
}

export function filterAdviceContradictingFindings(
  adviceLines: string[],
  findings: MinimalFinding[],
): string[] {
  const currentGenFiring = findings.some(isCurrentGenFinding);
  const ebsEncryptionFiring = findings.some(isEbsEncryptionFinding);
  const s3PublicAccessFiring = findings.some(isS3PublicAccessFinding);
  if (!currentGenFiring && !ebsEncryptionFiring && !s3PublicAccessFiring) {
    return adviceLines; // no relevant finding → no filtering needed
  }
  return adviceLines.filter((line) => {
    if (currentGenFiring && namesPreviousGenInstance(line)) return false;
    if (ebsEncryptionFiring && namesEbsDisableEncryption(line)) return false;
    if (s3PublicAccessFiring && namesS3PublicAccessGrant(line)) return false;
    return true;
  });
}
