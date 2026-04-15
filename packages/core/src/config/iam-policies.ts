/**
 * IAM policy document generators for the 3-user credential model.
 * Single source of truth — derives permissions from SUPPORTED_TYPES_ARRAY
 * and getRequiredIamActions().
 *
 * This file is now a pure barrel re-export. Implementation lives under
 * `./iam-policies/` split by concern:
 *   - `types.ts`              — PolicyStatement / PolicyDocument + IAM_USER_NAMES + IAM_POLICY_NAMES
 *   - `wildcard-collapser.ts` — collapseToWildcards (byte-compression helper)
 *   - `action-collector.ts`   — collectServiceActions + splitServiceActions + tag-scoped sets
 *   - `operator.ts`           — operatorPolicy + operatorServicesA/B
 *   - `reader.ts`             — readerPolicy
 *   - `auditor.ts`            — auditorPolicy
 *
 * @see Story 18.8 — IAM Security Overhaul
 */

export * from "./iam-policies/index.js";
