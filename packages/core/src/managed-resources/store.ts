/**
 * Managed-resource store — dual-index read-only projection.
 *
 * Epic 98 e98.W1.B1, Epic 97 B-02:
 *
 *   `writeProvisionRecord` already writes one entry per successful apply
 *   into `~/.assignee/memory/provisions.json`, using `resourceArn` as the
 *   opaque identifier slot. For taggable resources that's a full AWS ARN;
 *   for the non-taggable constructs from `non-taggable.ts` it's the bare
 *   CCAPI primaryIdentifier (`rtb-XXX|0.0.0.0/0`, `rtbassoc-XXX`, etc.).
 *
 *   This module is the typed read-side view: every provision record is
 *   projected into a `StoredProvisionRecord` tagged with a `keyKind`
 *   discriminator so list + destroy + resolver callers don't have to
 *   re-derive the type-classification logic.
 *
 * SRP: one reason to change — when the provision-log shape evolves
 * (e.g. a new column or a schema bump), update the projection in one
 * place rather than the three call sites.
 */

import { defaultMemoryService } from "@/services/memory.js";
import type { ProvisionRecord } from "@/schema/memory.js";
import { isNonTaggableConstruct } from "./non-taggable.js";

/**
 * A single provision-log entry with its key classification applied.
 *
 * - `keyKind: "arn"` — `key` is a full AWS ARN (taggable resource).
 * - `keyKind: "primaryIdentifier"` — `key` is the CCAPI primary identifier
 *   (e.g. `rtb-XXX|0.0.0.0/0`) because the resourceType is non-taggable
 *   and has no standalone ARN per arn-templates.ts.
 *
 * Both kinds share the same surface because callers (list, destroy) want
 * a uniform projection — the discriminator lets them label the rendered
 * row correctly (`--json` surfaces `arn: null` when `keyKind !== "arn"`).
 */
export interface StoredProvisionRecord {
  keyKind: "arn" | "primaryIdentifier";
  key: string;
  resourceType: string;
  region: string;
  createdDate: string;
  estimatedMonthlyCost: string;
  runId: string;
}

/** Classify one provision log entry into its `keyKind`. */
function classify(entry: ProvisionRecord): "arn" | "primaryIdentifier" {
  // Non-taggable constructs never produce an ARN; their `resourceArn`
  // slot in the log is the bare primaryIdentifier.
  if (isNonTaggableConstruct(entry.resourceType)) return "primaryIdentifier";
  // For taggable types the provision log carries a full ARN (display-resolved
  // by `apply-single.ts` → `buildResourceArn`). If the value doesn't start
  // with "arn:" we treat it as a primaryIdentifier too — defensive for legacy
  // rows written before arn-display resolution existed.
  return entry.resourceArn.startsWith("arn:") ? "arn" : "primaryIdentifier";
}

/**
 * Load the full provision log projected into `StoredProvisionRecord`.
 * The async wrapper mirrors the other memory-service getters so callers
 * don't couple to the underlying file-read sync/async split.
 */
export async function listProvisionRecords(): Promise<StoredProvisionRecord[]> {
  const raw = await defaultMemoryService.readProvisions();
  const out: StoredProvisionRecord[] = [];
  for (const entry of raw) {
    if (!entry.resourceArn) continue;
    out.push({
      keyKind: classify(entry),
      key: entry.resourceArn,
      resourceType: entry.resourceType,
      region: entry.region,
      createdDate: entry.timestamp,
      estimatedMonthlyCost: entry.estimatedMonthlyCost,
      runId: entry.runId,
    });
  }
  return out;
}

/**
 * Look up a single stored record by its identifier — matches either the
 * full-ARN key OR the primaryIdentifier key. Returns the FIRST match;
 * ambiguity is handled by the caller (destroy's `pickFromMatches`
 * flow) because disambiguation is a UX concern.
 *
 * Matching semantics:
 *   - exact string match on `key`
 *   - exact match on `key.split("/").pop()` OR `key.split(":").pop()`
 *     suffixes, so a user typing the bare resource name hits a matching
 *     ARN-keyed row (symmetric with `loadProvisionData`'s suffix index).
 */
export async function findProvisionRecord(
  identifier: string,
): Promise<StoredProvisionRecord | null> {
  const records = await listProvisionRecords();
  const needle = identifier;
  for (const r of records) {
    if (r.key === needle) return r;
  }
  // Suffix fallback — mirrors `loadProvisionData`'s name-suffix index.
  // Try both separators; ARNs like `arn:aws:s3:::my-bucket` have no
  // slashes, so split-by-slash returns the whole ARN unchanged. Only
  // accept the suffix when the split actually produced a smaller token.
  for (const r of records) {
    const slashTail = r.key.includes("/") ? r.key.split("/").pop() : null;
    const colonTail = r.key.split(":").pop();
    if (slashTail && slashTail === needle) return r;
    if (colonTail && colonTail !== r.key && colonTail === needle) return r;
  }
  return null;
}

/** Filter stored records to just the non-taggable set. */
export async function listNonTaggableProvisionRecords(): Promise<
  StoredProvisionRecord[]
> {
  const records = await listProvisionRecords();
  return records.filter((r) => r.keyKind === "primaryIdentifier");
}
