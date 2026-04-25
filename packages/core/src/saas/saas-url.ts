/**
 * SaaS URL derivation — single source of truth for the Assignee SaaS
 * API base URL (W5-01, P007-tech → L1-F05 + L1-F20 + L5-S03).
 *
 * Re-exports from `config/constants/saas.ts` so callers in the
 * `packages/core/src/saas/` namespace can import from a stable path
 * without reaching across package boundaries.
 *
 * Resolution order (W5-01):
 *   1. `ASSIGNEE_SAAS_URL` env var (validated — HTTPS required)
 *   2. Region-derived: `https://<AWS_REGION>.api.assignee.ai`
 *   3. Legacy US-East fallback: `https://app.assignee.ai`
 *
 * Region-derivation matrix (7 canonical regions tested):
 *   eu-central-1  → https://eu-central-1.api.assignee.ai
 *   eu-west-1     → https://eu-west-1.api.assignee.ai
 *   eu-west-2     → https://eu-west-2.api.assignee.ai
 *   eu-north-1    → https://eu-north-1.api.assignee.ai
 *   us-east-1     → https://us-east-1.api.assignee.ai
 *   us-west-2     → https://us-west-2.api.assignee.ai
 *   ap-south-1    → https://ap-south-1.api.assignee.ai
 *   (no region)   → https://app.assignee.ai  (legacy US-East)
 */
export { SAAS_API_URL } from "../config/constants/saas.js";
