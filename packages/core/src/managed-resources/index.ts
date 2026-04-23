/**
 * Public barrel for `@assignee/core/managed-resources` — dual-index
 * (arn | primaryIdentifier) read-side projection over the provision
 * log, plus the non-taggable-construct classifier.
 *
 * Epic 98 e98.W1.B1 (B-02 BLOCKER): list + destroy paths need a unified
 * lookup across taggable resources (RGTA-enumerated, ARN-keyed) and
 * non-taggable constructs (provision-log-only, primaryIdentifier-keyed).
 */

export {
  NON_TAGGABLE_RESOURCE_TYPES,
  isNonTaggableConstruct,
} from "./non-taggable.js";
export {
  findProvisionRecord,
  listProvisionRecords,
  listNonTaggableProvisionRecords,
  type StoredProvisionRecord,
} from "./store.js";
