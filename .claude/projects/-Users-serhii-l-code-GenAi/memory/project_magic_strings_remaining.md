---
name: Magic strings elimination progress
description: Tracks remaining magic strings — constants created but ~280 usages not yet replaced
type: project
---

## Status: Constants created, replacements incomplete (~280 remaining)

**Constants files created this session:**

- CfnKey (150+ CFN property keys) — packages/core/src/config/cfn-keys.ts
- PricingServiceCode, PricingProductFamily, PricingField, PricingMatchType, PricingKind — packages/core/src/pricing/filter-constants.ts
- PriceUnit — packages/core/src/pricing/price-units.ts
- PricingUnit — packages/core/src/pricing/units.ts
- LineItemLabel — packages/core/src/pricing/line-item-labels.ts
- PricingFilterValue — packages/core/src/pricing/pricing-filter-values.ts
- FieldLabel — packages/core/src/resource-plugins/field-labels.ts
- AwsDefault, ResourceDefault, AssigneeTag, RdsEngineDisplay, CloudWatchStatistic, AmiOs — packages/core/src/config/cfn-keys.ts
- IamEffect — packages/core/src/config/iam-effects.ts
- InstanceCategory — apps/cli/src/constants/instance-categories.ts
- WorkloadProfile — apps/cli/src/constants/workload-profiles.ts
- ReconcileAction — apps/cli/src/constants/reconcile-actions.ts
- AwsErrorName — apps/cli/src/constants/aws-errors.ts
- EnvVar — apps/cli/src/constants/env-vars.ts
- ErrorCode (extended) — apps/cli/src/constants/errors.ts
- LlmProvider — apps/cli/src/constants/errors.ts
- ContentType — apps/cli/src/constants/errors.ts
- PatternResourceId (5 pattern files) — packages/core/src/pattern-templates/pattern-resource-ids.ts
- PatternId — packages/core/src/pattern-templates/pattern-ids.ts
- FreeTierType — apps/cli/src/utils/free-tier.ts
- StateField — packages/core/src/schema/graph-state.ts
- DriftStatus, ChangeType — packages/core/src/schema/drift.ts
- FileName, UserMessage, PromiseStatus, UNKNOWN_FALLBACK — apps/cli/src/config/constants.ts
- Severity, FixType, FixAction — packages/best-practices/src/types.ts

**Remaining ~280 strings where constants exist but usages not replaced:**
Top offenders: "unknown" (10), "N/A" (10), "Type" (9), "cache" (8), "memory" (7), "SUCCESS" (6), "enforce" (5), discover-\* cache keys (5 each)

**Why:** Subagents created constants but didn't grep-and-replace in ALL consuming files. Need a final sweep with targeted `replace_all` edits.

**How to apply:** For each remaining string, grep production code, import the constant, replace. Most are 1-line edits per file.
