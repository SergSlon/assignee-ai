# Reviewer: ACCEPT — Quinn (qa) — EPIC-106-PRUNE

# EPIC-106 PricingUnit Prune Review — 5454a90e

## Verdict

ACCEPT — All six closure criteria satisfied. The dead 4-entry `PricingUnit`
display-unit constant is removed from `constants/pricing-api.ts`, its
re-export is dropped from the barrel, the lone test caller is repointed to
the canonical `PriceUnit.PER_GB_MONTH_LONG` (byte-identical `"/GB-month"`),
no orphan imports remain, and the unrelated `pricing/units.ts` `PricingUnit`
(decomposer unit-of-measure enum) is untouched. CHANGELOG entry is concise
and accurate. Diff stat is appropriately minimal (4 files, +9/-10).

## Closure criteria verified

1. 4-entry `PricingUnit` deleted from `constants/pricing-api.ts`:
   diff `packages/core/src/constants/pricing-api.ts` shows the 7-line
   `export const PricingUnit = {...}` block (GB_MONTH, PARAM_HOUR, HOUR,
   MILLION_REQUESTS) removed at lines 58-63 (pre-commit numbering).
2. Test caller compiles and asserts identical canonical string:
   `packages/core/src/graph/nodes/preflight-guard.test.ts:1373-1375`
   now asserts `$0.0230${PriceUnit.PER_GB_MONTH_LONG}` (PriceUnit imported
   from `../../pricing/price-units.js` at line 5). `PER_GB_MONTH_LONG` is
   byte-identical `"/GB-month"` to the removed `PricingUnit.GB_MONTH`.
3. No orphan imports — `git grep "PricingUnit"` across
   `packages/core/src/constants/`, `packages/core/src/graph/`, and
   `packages/core/src/barrels/` at commit `5454a90e` returns zero hits;
   `git grep "from.*['\"].*constants/pricing-api['\"]"` shows no remaining
   importer pulls `PricingUnit` from the display-unit module.
4. Unrelated `PricingUnit` in `pricing/units.ts` untouched:
   `git show 5454a90e:packages/core/src/pricing/units.ts` shows the
   decomposer unit-of-measure enum (GB, REQUESTS, INSTANCE, ADDRESS,
   GATEWAY, ALB, NLB, ALARM, SECRET, PARAMETER, MESSAGES, MINUTES,
   NOTIFICATIONS, RCU, WCU, GB_SECOND, LCU_HR, NLCU_HR, KEY, MIBPS)
   intact and not part of this commit's diff stat.
5. Barrel re-export hygiene preserved:
   `packages/core/src/barrels/config/constants.ts:165` drops `PricingUnit`
   from the `from "../../constants/pricing-api.js"` export group; sibling
   exports (`PricingFilter`, `PricingTerm`, `PricingScale`, `LambdaPricing`)
   retained. Build would fail on a stale re-export, so this is type-gated.
6. CHANGELOG entry accurate and concise:
   `CHANGELOG.md` under `[Unreleased] > ### Removed` describes the deletion
   ("Dead PricingUnit parallel constant... zero callers except one test,
   repointed to PriceUnit.PER_GB_MONTH_LONG. Closes EPIC-106 strategies-
   review OOS paydown.") — one bullet, factually correct.

## Findings

- None.

## Notes

- Naming collision with `pricing/units.ts` `PricingUnit`: verified
  intentional and legitimate. The deleted symbol was a display-unit
  suffix constant ("/GB-month", "/hour" — for formatted cost strings);
  the surviving symbol is the canonical AWS-pricing-API unit-of-measure
  enum referenced by decomposers ("GB", "RCU", "alarm"). Different
  semantic domains; the prune removes the dead duplicate-by-name and
  leaves the live, decomposer-critical enum untouched. The collision
  is reduced (not increased) by this commit because there is now only
  one `PricingUnit` symbol in the codebase.
- Display-unit replacement (`PriceUnit.PER_GB_MONTH_LONG` from
  `packages/core/src/pricing/price-units.js`) is byte-identical to the
  deleted `PricingUnit.GB_MONTH`, so the test asserts the same wire
  output — no behavioural drift.
- Diff stat (4 files, +9/-10) is consistent with a tight chore: const
  delete + barrel update + single test import swap + CHANGELOG entry.
  No collateral source changes detected.
