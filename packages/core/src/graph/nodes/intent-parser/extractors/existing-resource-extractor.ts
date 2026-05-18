/**
 * Existing-resource extractor (EPIC-107-2, PH1-G-2 deep fix).
 *
 * Runs early in the intent-parser stack to discover existing AWS resources
 * matching the user's intent. Matched resources land in graph-state as
 * `ExistingResource[]` (read-only — NEVER destroyed by `assignee infra destroy`).
 *
 * Architecture (Winston ADR 2026-05-15, Option D):
 *   Backed by the existing direct-SDK `aws-resource-discovery` module via
 *   the `ResourceDiscoveryPort` abstraction. No MCP servers, no new cache
 *   infrastructure — reuses `cachedDiscover()` per-fetcher TTL (300s default).
 *
 * Failure contract (CC #5):
 *   Discovery errors are caught by the port impl and logged once with
 *   callsite "intent-parser/existing-resource-extractor". The extractor
 *   always returns [] on failure — the caller falls through to the CP-3
 *   advisory path unchanged.
 *
 * Multi-match elicitation (Decision 2):
 *   When multiple resources match the intent, the extractor surfaces the
 *   full list. Tag-substring fast-path auto-selects when a unique match is
 *   found for a tag fragment present in the intent text. Otherwise, the
 *   caller is responsible for elicitation (e.g. option-elicitor picker).
 *
 * Destroy isolation invariant (Variation F):
 *   ExistingResource[] lives in `graph-state.existingResources`. The destroy
 *   strategies (bulk-action, single-flow) use `fetchManagedResources()` from
 *   provisions.json — they NEVER iterate existingResources. Tests in
 *   existing-resource-extractor.test.ts (Variation F) assert this explicitly.
 */

import type {
  ResourceDiscoveryPort,
  ExistingResource,
} from "../../../../services/resource-discovery-port.js";
import { log, LOG_ACTIONS } from "../../../../utils/logger/index.js";
import { AWS_REGION } from "../../../../config/constants/aws.js";

/** Keywords used to identify VPC intent in the user's text. */
const VPC_KEYWORDS = ["vpc", "virtual private cloud"];
/** Keywords used to identify subnet group intent. */
const SUBNET_GROUP_KEYWORDS = ["subnet group", "db subnet", "rds subnet"];
/** Keywords used to identify ECS cluster intent. */
const ECS_CLUSTER_KEYWORDS = [
  "ecs cluster",
  "ecs service",
  "container service",
  "fargate cluster",
];
/** Keywords used to identify ELB/load balancer intent. */
const ELB_KEYWORDS = [
  "load balancer",
  "alb",
  "nlb",
  "application load balancer",
  "network load balancer",
];

/**
 * Returns true when the lower-cased intent string contains any of the
 * given keywords.
 */
function intentContains(intentLower: string, keywords: string[]): boolean {
  return keywords.some((kw) => intentLower.includes(kw));
}

/**
 * Reserved noun-like words that frequently appear in resource labels but
 * carry no disambiguation signal (e.g. "vpc-staging (vpc-staging, …)"
 * contains "vpc" — selecting on "vpc" would mean "any VPC matches", which
 * is the opposite of disambiguation). These words are excluded from the
 * candidate-word pool. Kind-name fragments are particularly dangerous
 * since the label always embeds them.
 */
const TAG_AUTOSELECT_STOPWORDS = new Set([
  "vpc",
  "alb",
  "nlb",
  "elb",
  "ecs",
  "rds",
  "lb",
  "in",
  "the",
  "my",
  "our",
  "for",
  "with",
  "and",
  "or",
  "of",
  "to",
  "from",
  "on",
  "into",
  "use",
  "using",
  "create",
  "make",
  "new",
  "existing",
  "default",
]);

/**
 * Tag-substring auto-disambiguation fast-path (Decision 2, Variation B).
 *
 * EPIC-107-2 R2 (review finding #3): previous impl used `find()` which
 * picked the FIRST intent-word that uniquely matched a label — making
 * auto-selection word-order-sensitive and prone to false positives on
 * generic words like "rds" or "vpc" that happen to appear in only one
 * label by coincidence.
 *
 * The new algorithm:
 *   1. Tokenize intent into words ≥ 4 chars (3-char words like "rds",
 *      "vpc" are excluded as kind-name fragments).
 *   2. Drop stopwords (kind names, articles, helpers).
 *   3. For each remaining word, count how many candidate labels it
 *      matches. Track only words that uniquely match exactly one label.
 *   4. Auto-select ONLY when ALL unique-match words converge on the
 *      SAME candidate (convergence guard: matchedIds.size === 1).
 *   5. If multiple words yield unique-but-different matches, fall through
 *      to needsElicitation (ambiguous-which-to-trust).
 *
 * Returns the auto-selected resource, or null if no high-confidence match.
 */
function tagSubstringAutoSelect(
  candidates: ExistingResource[],
  intentLower: string,
): ExistingResource | null {
  if (candidates.length <= 1) return null;

  const words = intentLower
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !TAG_AUTOSELECT_STOPWORDS.has(w));

  // Build (word → matched-candidate) for every word that uniquely matches
  // exactly one label. Use a Map so we preserve order for deterministic
  // tie-breaking.
  const uniqueMatchByWord = new Map<string, ExistingResource>();
  for (const w of words) {
    const hits = candidates.filter((c) => c.label.toLowerCase().includes(w));
    if (hits.length === 1) {
      uniqueMatchByWord.set(w, hits[0]!);
    }
  }

  if (uniqueMatchByWord.size === 0) return null;

  // If all unique-match words point at the SAME candidate, that's a
  // high-confidence match — auto-select.
  const matchedIds = new Set([...uniqueMatchByWord.values()].map((c) => c.id));
  if (matchedIds.size > 1) {
    // Different words point at different candidates — ambiguous; let the
    // user / picker decide.
    return null;
  }

  // All words agree on one candidate. Return it.
  return [...uniqueMatchByWord.values()][0]!;
}

export interface ExtractExistingResult {
  /**
   * Existing resources that were unambiguously matched (or auto-selected by
   * the tag-substring fast-path). Ambiguous-kind candidates are NOT
   * included here — they would pollute graph state with N "Found existing"
   * lines and no commitment to any one. ADR Decision 2: when a picker
   * isn't possible (non-interactive mode), surface advisory + return empty
   * for that kind.
   */
  existing: ExistingResource[];
  /**
   * Per-kind candidate ambiguity report. Each entry: { kind, candidates }
   * — the candidates that would have been surfaced to the option-elicitor
   * picker if it were wired. The intent-parser uses this to emit a
   * targeted advisory listing the kinds and counts, so the user can
   * rephrase. Empty array when no kind is ambiguous.
   */
  ambiguous: Array<{ kind: string; candidates: ExistingResource[] }>;
  /**
   * When true, at least one resource kind had multiple matches and could
   * not be auto-disambiguated. Caller should surface an
   * `EXISTING_RESOURCE_AMBIGUOUS` advisory and (once wired) the
   * option-elicitor picker.
   */
  needsElicitation: boolean;
}

/**
 * Discovers existing AWS resources matching the user's intent.
 *
 * @param intent — raw user intent string.
 * @param port — ResourceDiscoveryPort impl (mock in tests, production in runtime).
 * @param region — AWS region (defaults to AWS_REGION env).
 * @param runId — correlation ID for structured log lines (defaults to
 *   "discovery" as a belt-and-suspenders fallback; callers should always
 *   pass state.runId so all DISCOVERY_* log lines are traceable).
 * @returns Discovered resources (may be empty) + elicitation flag.
 */
export async function extractExisting(
  intent: string,
  port: ResourceDiscoveryPort,
  region: string = AWS_REGION,
  runId: string = "discovery",
): Promise<ExtractExistingResult> {
  const intentLower = intent.toLowerCase();
  const opts = { region };

  const discovered: ExistingResource[] = [];

  try {
    if (intentContains(intentLower, VPC_KEYWORDS)) {
      const vpcs = await port.discoverVpcs(opts);
      discovered.push(...vpcs);
    }
    if (intentContains(intentLower, SUBNET_GROUP_KEYWORDS)) {
      const groups = await port.discoverSubnetGroups(opts);
      discovered.push(...groups);
    }
    if (intentContains(intentLower, ECS_CLUSTER_KEYWORDS)) {
      const clusters = await port.discoverEcsClusters(opts);
      discovered.push(...clusters);
    }
    if (intentContains(intentLower, ELB_KEYWORDS)) {
      const elbs = await port.discoverElbs(opts);
      discovered.push(...elbs);
    }
  } catch (err) {
    // The port impl catches errors itself; this is a belt-and-suspenders
    // guard for unexpected throws (e.g. import failures).
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.DISCOVERY_FAILURE,
      extras: {
        callsite: "intent-parser/existing-resource-extractor",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return { existing: [], ambiguous: [], needsElicitation: false };
  }

  if (discovered.length === 0) {
    return { existing: [], ambiguous: [], needsElicitation: false };
  }

  // Tag-substring auto-disambiguation fast-path: group by kind and check
  // if a unique match exists per kind.
  const byKind = new Map<string, ExistingResource[]>();
  for (const r of discovered) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }

  const selected: ExistingResource[] = [];
  const ambiguous: Array<{ kind: string; candidates: ExistingResource[] }> = [];

  for (const [kind, candidates] of byKind) {
    if (candidates.length === 1) {
      selected.push(candidates[0]!);
    } else {
      // Try tag-substring fast-path
      const autoMatch = tagSubstringAutoSelect(candidates, intentLower);
      if (autoMatch) {
        selected.push(autoMatch);
      } else {
        // EPIC-107-2 R2 (review finding #4): do NOT pollute `selected[]`
        // with all candidates — that ships N "Found existing X" lines
        // with no commitment to any. Per ADR Decision 2 (picker isn't
        // wired in this story), report the ambiguous kind so the caller
        // can emit a targeted advisory, but leave `selected[]` clean.
        ambiguous.push({ kind, candidates });
      }
    }
  }

  return {
    existing: selected,
    ambiguous,
    needsElicitation: ambiguous.length > 0,
  };
}
