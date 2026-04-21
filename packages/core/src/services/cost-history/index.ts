/**
 * Cost-history scoping service (Epic 92 Wave 4.c, F-A-20 / F-D-34).
 *
 * ## Why this module exists
 *
 * The plan-generator's `readMemoryHints` filters the user-visible
 * "Cost History" and "Previous error" lines by `resourceType` alone.
 * That scope is too wide: sibling agents / unrelated projects with the
 * same resource type bleed history into each other. Agent D planning a
 * fresh S3 bucket saw Agent A's failed `dogfood-e92-a-s3-...` name from
 * a completely different session (F-CROSS-001 in
 * `_bmad-output/implementation-artifacts/epic-92-findings-d.md`).
 *
 * This service owns the scope-aware cost-history infrastructure:
 *
 *   1. Stable intent hashing (`computeIntentHash`).
 *   2. A scope tuple derived from agent state (`scopeOfState`).
 *   3. A sidecar index at `~/.assignee/memory/cost-history-scope.json`
 *      that records `{runId, intentHash, projectDir, desiredName,
 *      resourceType, timestamp}` per provision/failure. Entries are
 *      joined against the canonical provisions / failures logs by
 *      `runId`, so the existing Zod schemas are not modified —
 *      downstream consumers (`optimize`, `list --total-cost`) keep
 *      reading the untouched files.
 *   4. Scope-narrowed readers: `readScopedProvisions`,
 *      `readScopedFailures`, `readScopedProvisionHintLine`.
 *   5. Pure helpers reused by `llm-helpers.ts` for F-D-34:
 *      - `scrubEmptyErrorMetadata` — strips `Status Code: 0`,
 *        `Request ID: null`, empty `(Service: X)` parentheticals.
 *      - `extractDesiredNameFromErrorMessage` — best-effort parse of
 *        the offending resource identifier from a stored error string.
 *      - `extractDesiredNameFromState` — pulls the primary-identifier
 *        value from `desiredState` (when populated) and falls back to
 *        the user-intent `named <token>` pattern.
 *
 * ## Safe defaults
 *
 * `scopeMatches` is a **negative filter**: legacy records without
 * sidecar entries still appear (backward compat), and only records
 * that contradict the current scope are excluded. That closes
 * F-CROSS-001 (distinct projectDirs → distinct cost-history) without
 * making the hint vanish for everyone until the sidecar backfills.
 *
 * ## Rules
 *
 *   - Schema additive only — this module adds a sidecar, not a new
 *     column on the canonical Zod schemas.
 *   - Real fixtures. No hardcoded prices.
 *   - Fire-and-forget writes — log on failure, never throw.
 */
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { defaultMemoryService, MemoryService } from "@/services/memory.js";
import type { ProvisionRecord, FailureRecord } from "@/schema/memory.js";
import type { AgentState } from "@/graph/graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { ASSIGNEE_DIR } from "@/config/constants/paths.js";

// ── Scope primitives ───────────────────────────────────────────────────────

/** Scope tuple derived from runtime state. Both axes are optional. */
export interface HistoryScope {
  intentHash?: string;
  projectDir?: string;
}

/**
 * Stable sha256 hex digest of the user's intent text. Normalised by
 * trimming + lowercasing so casing / surrounding whitespace collapse
 * to the same hash. Empty / whitespace-only input returns `""` (no
 * scope axis).
 */
export function computeIntentHash(userIntent: string | undefined): string {
  if (!userIntent) return "";
  const normalized = userIntent.trim().toLowerCase();
  if (normalized.length === 0) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** Extracts the current scope from an `AgentState`. */
export function scopeOfState(state: AgentState): HistoryScope {
  return {
    intentHash: computeIntentHash(state.userIntent) || undefined,
    projectDir: state.projectDir || undefined,
  };
}

/**
 * Returns `true` when the record does NOT contradict the current scope.
 *
 * Precedence — `projectDir` wins over `intentHash` because project
 * identity is the stronger equivalence. Two sibling intents in the
 * SAME project share cost history; the same intent in DIFFERENT
 * projects does not (F-CROSS-001 is exactly that: same-type plans in
 * different projects must not leak).
 *
 *   - Both sides have `projectDir` set:
 *       * Match → TRUE (accept regardless of intentHash).
 *       * Differ → FALSE (cross-project leakage blocked).
 *   - Exactly one side has `projectDir`: fall through to intentHash.
 *   - Neither side has `projectDir`: fall through to intentHash.
 *   - intentHash defined both sides AND differ → FALSE.
 *   - Otherwise → TRUE.
 *
 * Legacy records missing either axis still match (that is backward-
 * compat by design).
 */
export function scopeMatches(
  record: { intentHash?: string; projectDir?: string },
  scope: HistoryScope,
): boolean {
  if (record.projectDir && scope.projectDir) {
    return record.projectDir === scope.projectDir;
  }
  if (
    record.intentHash &&
    scope.intentHash &&
    record.intentHash !== scope.intentHash
  ) {
    return false;
  }
  return true;
}

// ── Sidecar index storage ──────────────────────────────────────────────────

const SIDECAR_FILENAME = "cost-history-scope.json";
const MEMORY_DIR = path.join(os.homedir(), ASSIGNEE_DIR, "memory");

/** One sidecar row per provision / failure, keyed by canonical runId. */
export interface ScopeIndexEntry {
  runId: string;
  resourceType: string;
  intentHash?: string;
  projectDir?: string;
  desiredName?: string;
  timestamp: string;
}

/**
 * Sidecar store. Parallel file to provisions.json / failures.json
 * under `~/.assignee/memory/`. Constructor-injected directory for
 * test isolation (same pattern as `MemoryService`).
 */
export class CostHistoryStore {
  readonly dir: string;

  constructor(dir: string = MEMORY_DIR) {
    this.dir = dir;
  }

  private filePath(): string {
    return path.join(this.dir, SIDECAR_FILENAME);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /**
   * Returns sidecar entries; drops structurally invalid rows and
   * returns `[]` on missing / corrupt file (graceful degradation —
   * mirrors `MemoryService.readProvisions`).
   */
  async readEntries(): Promise<ScopeIndexEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath(), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is ScopeIndexEntry =>
          !!e &&
          typeof e === "object" &&
          typeof (e as ScopeIndexEntry).runId === "string" &&
          typeof (e as ScopeIndexEntry).resourceType === "string" &&
          typeof (e as ScopeIndexEntry).timestamp === "string",
      );
    } catch {
      return [];
    }
  }

  /** Fire-and-forget append; logs on failure. */
  async appendEntry(entry: ScopeIndexEntry): Promise<void> {
    try {
      await this.ensureDir();
      const existing = await this.readEntries();
      existing.push(entry);
      await fs.writeFile(
        this.filePath(),
        JSON.stringify(existing, null, 2),
        "utf-8",
      );
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: entry.runId,
        level: "info",
        action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
        extras: { phase: "cost_history_sidecar_write", error: String(err) },
      });
    }
  }
}

export const defaultCostHistoryStore = new CostHistoryStore();

// ── Sidecar join ───────────────────────────────────────────────────────────

/** Canonical record + sidecar scope fields, joined at read time. */
export type Enriched<T extends { runId: string }> = T & {
  intentHash?: string;
  projectDir?: string;
};

/**
 * Threads sidecar fields onto records with matching `runId`. Records
 * without a matching sidecar entry keep their canonical shape (legacy
 * records stay visible).
 */
export function joinWithScope<T extends { runId: string }>(
  records: T[],
  sidecar: ScopeIndexEntry[],
): Array<Enriched<T>> {
  if (sidecar.length === 0) return records as Array<Enriched<T>>;
  const byRunId = new Map(sidecar.map((e) => [e.runId, e] as const));
  return records.map((r) => {
    const side = byRunId.get(r.runId);
    if (!side) return r as Enriched<T>;
    return {
      ...r,
      intentHash: side.intentHash,
      projectDir: side.projectDir,
    } as Enriched<T>;
  });
}

// ── Scoped readers ─────────────────────────────────────────────────────────

export async function readScopedProvisions(
  state: AgentState,
  memory: MemoryService = defaultMemoryService,
  store: CostHistoryStore = defaultCostHistoryStore,
): Promise<Array<Enriched<ProvisionRecord>>> {
  const scope = scopeOfState(state);
  try {
    const [provisions, sidecar] = await Promise.all([
      memory.readProvisions(),
      store.readEntries(),
    ]);
    return joinWithScope(provisions, sidecar)
      .filter(
        (p) =>
          p.resourceType === (state.resourceType ?? "") &&
          scopeMatches(p, scope),
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: { phase: "read_scoped_provisions", error: String(err) },
    });
    return [];
  }
}

export async function readScopedFailures(
  state: AgentState,
  memory: MemoryService = defaultMemoryService,
  store: CostHistoryStore = defaultCostHistoryStore,
): Promise<Array<Enriched<FailureRecord>>> {
  const scope = scopeOfState(state);
  try {
    const [failures, sidecar] = await Promise.all([
      memory.readFailures(),
      store.readEntries(),
    ]);
    return joinWithScope(failures, sidecar)
      .filter(
        (f) =>
          f.resourceType === (state.resourceType ?? "") &&
          scopeMatches(f, scope),
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: { phase: "read_scoped_failures", error: String(err) },
    });
    return [];
  }
}

/**
 * Formatted `Previous provision of this type: ...` hint line scoped
 * to the current plan, or `""` when no record matches. Self-contained
 * A-20 entrypoint — future stories can wire this in where the
 * resource-type-only block currently lives.
 */
export async function readScopedProvisionHintLine(
  state: AgentState,
  memory: MemoryService = defaultMemoryService,
  store: CostHistoryStore = defaultCostHistoryStore,
): Promise<string> {
  const scoped = await readScopedProvisions(state, memory, store);
  const prev = scoped[0];
  if (!prev) return "";
  const dateStr = new Date(prev.timestamp).toLocaleDateString();
  return `Previous provision of this type: ${prev.estimatedMonthlyCost}/month (run ${prev.runId}, ${dateStr}).`;
}

// ── Name extraction (F-D-34) ───────────────────────────────────────────────

const PRIMARY_ID_CANDIDATES = [
  "BucketName",
  "FunctionName",
  "TableName",
  "RoleName",
  "TopicName",
  "QueueName",
  "DBInstanceIdentifier",
  "RepositoryName",
  "LogGroupName",
  "AlarmName",
  "Name",
] as const;

/**
 * Pulls the resource's "desired name" from the partial state.
 *   1. If `desiredState` is populated, return the first present
 *      primary-identifier key (BucketName, FunctionName, …).
 *   2. Else scan `userIntent` for `named <token>` / `called <token>`
 *      / `name: <token>` — the intent-parser prompt steers users
 *      toward these forms.
 *   3. Otherwise `undefined`.
 *
 * Tokens must match `[A-Za-z0-9_-]{3,}` so casual words (`a`, `an`,
 * `it`) aren't taken as names.
 */
export function extractDesiredNameFromState(input: {
  desiredState?: Record<string, unknown>;
  userIntent?: string;
}): string | undefined {
  const { desiredState, userIntent } = input;
  if (desiredState && typeof desiredState === "object") {
    for (const key of PRIMARY_ID_CANDIDATES) {
      const val = desiredState[key];
      if (typeof val === "string" && val.length > 0) return val;
    }
  }
  if (typeof userIntent === "string" && userIntent.length > 0) {
    const m = userIntent.match(
      /\b(?:named|called|name[:\s=]+)\s+([A-Za-z0-9_-]{3,})/i,
    );
    if (m && m[1]) return m[1];
  }
  return undefined;
}

/**
 * Best-effort parse of a resource identifier from a stored failure
 * message. Real AWS SDK errors put the offending name at the start:
 *
 *   "dogfood-e92-a-s3-1776800919 already exists (Service: S3, ...)"
 *   "Role with name my-role already exists."
 *   "Table already exists: orders-prod"
 *
 * Returns `undefined` when no identifier-looking token is found.
 *
 * **Tightened regex** — the leading-token path only fires for tokens
 * that look like resource identifiers (contain at least one digit OR
 * at least one hyphen), not natural-language prefixes like "Recent" /
 * "Bucket" / "Function". Combined with `isCommonPrefix`, this keeps
 * the name-mismatch filter from over-matching on normal English error
 * messages ("Old error", "Recent throttle error") that would
 * otherwise make the D-34 narrowing drop legitimate hints.
 */
export function extractDesiredNameFromErrorMessage(
  errorMessage: string | undefined,
): string | undefined {
  if (!errorMessage) return undefined;
  // Explicit `named <name>` / `with name <name>` — highest confidence.
  const named = errorMessage.match(
    /\b(?:with name|name[:\s=]+|named)\s+([A-Za-z0-9_][A-Za-z0-9._\-]{2,})/i,
  );
  if (named && named[1]) return named[1];
  // Trailing `: <name>` — also explicit (after an "already exists: " or
  // similar separator).
  const trailing = errorMessage.match(
    /:\s+([A-Za-z0-9_][A-Za-z0-9._\-]{2,})\s*$/,
  );
  if (trailing && trailing[1]) return trailing[1];
  // Leading token — but ONLY when it looks like a resource identifier
  // (digit or hyphen present) so natural-language error prefixes don't
  // get misclassified as names.
  const leading = errorMessage.match(/^([A-Za-z0-9_][A-Za-z0-9._\-]{2,})\s+/);
  if (
    leading &&
    leading[1] &&
    looksLikeResourceId(leading[1]) &&
    !isCommonPrefix(leading[1])
  ) {
    return leading[1];
  }
  return undefined;
}

/**
 * Heuristic — a token is an AWS-style resource id when it carries
 * at least one digit OR one hyphen / underscore / dot (the
 * separators used by bucket names, function names, instance ids,
 * etc.). Pure ASCII word tokens like `Recent` or `Old` fail this
 * test and fall through.
 */
function looksLikeResourceId(token: string): boolean {
  return /[0-9]/.test(token) || /[-_.]/.test(token);
}

/** Leading tokens that are noise, not resource names. */
function isCommonPrefix(token: string): boolean {
  const lc = token.toLowerCase();
  return (
    lc === "error" ||
    lc === "invalid" ||
    lc === "the" ||
    lc === "failed" ||
    lc === "cannot" ||
    lc === "unable" ||
    lc === "could" ||
    lc === "warning" ||
    lc === "bucket" ||
    lc === "table" ||
    lc === "function" ||
    lc === "role" ||
    lc === "resource"
  );
}

// ── Metadata scrub (F-D-34) ────────────────────────────────────────────────

/**
 * Removes empty-valued AWS SDK metadata from an error message.
 *
 * Fragments stripped (placeholder / null-valued — unactionable by the
 * user):
 *   - `Status Code: 0` — no HTTP call happened.
 *   - `Request ID: null` / `Request ID: undefined`.
 *   - `Extended Request ID: null` / `undefined`.
 *   - Parentheticals that now contain only `Service: X` (or nothing).
 *
 * Real fixture (F-CROSS-001):
 *
 *   `dogfood-... already exists (Service: S3, Status Code: 0, Request ID: null).`
 *   → `dogfood-... already exists.`
 */
export function scrubEmptyErrorMetadata(errorMessage: string): string {
  if (!errorMessage) return errorMessage;
  let s = errorMessage;
  s = s.replace(/,?\s*Status Code:\s*0\b/gi, "");
  s = s.replace(/,?\s*Request ID:\s*(null|undefined|-)\b/gi, "");
  s = s.replace(/,?\s*Extended Request ID:\s*(null|undefined|-)\b/gi, "");
  s = s.replace(/\s*\(\s*(?:Service:\s*[\w-]+\s*,?\s*)?\)/g, "");
  s = s.replace(/\(\s*,\s*/g, "(");
  s = s.replace(/\s*,\s*\)/g, ")");
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/\s+\./g, ".");
  return s;
}
