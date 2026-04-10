# MCP Intelligence Maximization Audit

**Date:** 2026-04-10
**Epic:** 44 — Dynamic Data & LLM Routing
**Story:** 44.6

---

## 1. Current MCP Integration Matrix

### 1.1 MCP Servers Deployed

| Server          | Package Pin                                          | Credential Role | Lazy-Load Commands    |
| --------------- | ---------------------------------------------------- | --------------- | --------------------- |
| Pricing         | `awslabs.aws-pricing-mcp-server@1.0.6`               | reader          | plan, apply, optimize |
| Documentation   | `awslabs.aws-documentation-mcp-server@1.1.1`         | reader          | plan, apply           |
| IAM             | `awslabs.iam-mcp-server@1.0.2`                       | auditor         | status                |
| WA Security     | `awslabs.well-architected-security-mcp-server@0.1.7` | auditor         | status                |
| Cost Management | `awslabs.aws-cost-management-mcp-server@1.0.2`       | auditor         | status                |

All servers are supply-chain pinned (never `@latest`). Optional servers degrade gracefully — 3s timeout, `Promise.allSettled`, local fallback.

### 1.2 Tool Usage by Node/Utility

| Tool                        | MCP Server      | Used By                                                                          | Purpose                                                        |
| --------------------------- | --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `get_pricing`               | Pricing         | option-elicitor, preflight-guard, mcp-advisor, cost-optimizer, pricing-lookup.ts | Live $/hr in wizard prompts, cost estimation gate, rightsizing |
| `search_documentation`      | Documentation   | mcp-advisor, bp-mcp-enricher, display-docs.ts                                    | Context hints for advice, BP validation enrichment, field help |
| `read_sections`             | Documentation   | display-docs.ts                                                                  | Full doc page reads for trade-off analysis                     |
| `read_documentation`        | Documentation   | display-docs.ts                                                                  | Direct doc page reads                                          |
| `simulate_principal_policy` | IAM             | preflight-guard                                                                  | Pre-apply IAM permission validation                            |
| `CheckSecurityServices`     | WA Security     | mcp-advisor, bp-mcp-enricher                                                     | Verify security services enabled                               |
| `GetSecurityFindings`       | WA Security     | security-posture.ts                                                              | Post-provision SecurityHub/GuardDuty findings                  |
| `get_cost_and_usage`        | Cost Management | billing.ts, list-resources.ts                                                    | Live billing for current month                                 |
| `get_cost_forecast`         | Cost Management | billing.ts                                                                       | Forecast for destroy savings estimate                          |

### 1.3 Pipeline Node Inventory

| Node                 | Receives Tools? | MCP Tools Used                                                 | Notes                                      |
| -------------------- | --------------- | -------------------------------------------------------------- | ------------------------------------------ |
| intent_parser        | No              | —                                                              | LLM-only classification                    |
| schema_fetcher       | No              | —                                                              | Direct SDK (CloudFormation schema service) |
| option_elicitor      | Yes             | `get_pricing`                                                  | Live pricing in wizard labels              |
| compound_dispatcher  | No              | —                                                              | Pattern routing only                       |
| plan_generator       | No              | —                                                              | LLM-only JSON generation                   |
| advice_generator     | Yes             | `get_pricing`, `search_documentation`, `CheckSecurityServices` | Context enrichment for hints               |
| bp_evaluator         | Yes             | —                                                              | Tools passed but not directly called       |
| fix_applicator       | No              | —                                                              | BP fix application                         |
| preflight_guard      | Yes             | `get_pricing`, `simulate_principal_policy`                     | Cost + IAM validation                      |
| human_approval       | No              | —                                                              | HITL gate                                  |
| resource_provisioner | No              | —                                                              | CloudControl provision                     |
| status_poller        | No              | —                                                              | CloudControl polling                       |
| result_formatter     | No              | —                                                              | Display formatting only                    |

---

## 2. Unused MCP Capabilities — Go/No-Go Analysis

### Opportunity 1: Live Lambda runtime catalog via Documentation MCP

- **Tool:** `search_documentation` or `read_sections`
- **Target:** `lambda-function.ts` plugin / option-elicitor
- **Current state:** 8 hardcoded runtimes in the Lambda plugin
- **Opportunity:** Query AWS docs for current Lambda runtime support page → parse runtime table → dynamic wizard options
- **Effort:** S (1 day)
- **Impact:** HIGH — new runtimes (nodejs24.x, python3.14) appear without code changes
- **Risk:** Doc page format changes could break parsing; need robust fallback to hardcoded list
- **Go/No-Go:** **GO** — this is Story 44.4, already planned
- **Dependencies:** None

### Opportunity 2: Live pricing in wizard instance type labels via Pricing MCP

- **Tool:** `get_pricing`
- **Target:** option-elicitor `enrichWithLivePricing()`, EC2/RDS plugins
- **Current state:** Already partially implemented — `enrichWithLivePricing()` exists in wizard-helpers.ts and pricing-lookup.ts has `fetchEc2InstancePrices()` / `fetchRdsInstancePrices()`
- **Opportunity:** Replace the remaining hardcoded `~$X.XX/hr` label strings in EC2 `INSTANCE_CATEGORIES` and RDS instance class lists with live MCP prices
- **Effort:** M (2-3 days)
- **Impact:** HIGH — prices stay accurate as AWS updates quarterly
- **Risk:** Pricing MCP timeout (3s) on large type catalogs; mitigated by session cache
- **Go/No-Go:** **GO** — this is Story 44.2, already planned
- **Dependencies:** None (enrichment infrastructure exists)

### Opportunity 3: Live instance type catalog via AWS SDK + Pricing MCP

- **Tool:** `get_pricing` (for price enrichment after SDK discovery)
- **Target:** EC2/RDS plugins, option-elicitor
- **Current state:** 28 hardcoded EC2 types across 4 categories; missing m7i, r7g, c7g, t4g.2xlarge
- **Opportunity:** `DescribeInstanceTypes(current-generation=true)` → group by family → merge with Pricing MCP for $/hr → display as categorySelect
- **Effort:** M (2-3 days)
- **Impact:** HIGH — new types appear automatically
- **Risk:** SDK call adds ~1-2s latency; mitigated by 6s timeout + fallback to hardcoded
- **Go/No-Go:** **GO** — this is Story 44.3, already planned
- **Dependencies:** Story 44.2 (shares pricing enrichment infra)

### Opportunity 4: Budget-aware defaults via Cost Management MCP

- **Tool:** `get_cost_and_usage`
- **Target:** plan_generator or option-elicitor
- **What:** "Your account spent $X on EC2 last month — suggest t3.small not m5.xlarge"
- **Effort:** M (2-3 days)
- **Impact:** MEDIUM — useful for cost-conscious users, but privacy-sensitive (shows spending)
- **Risk:** Requires BILLING server during plan (currently only in status); adds ~2s latency; privacy concern if shared terminal
- **Go/No-Go:** **DEFER** — nice-to-have but privacy risk needs UX design (opt-in). Plan for post-Phase 2.
- **Dependencies:** Would need BILLING server added to plan/apply command map

### Opportunity 5: Least-privilege IAM role generation via IAM MCP

- **Tool:** `simulate_principal_policy`
- **Target:** plan_generator (for Lambda/ECS task roles)
- **What:** Auto-generate minimal IAM policies by simulating required actions against the provisioned resources
- **Effort:** L (3-5 days)
- **Impact:** HIGH — major security win, but complex
- **Risk:** IAM simulation requires knowing the resource ARNs before they exist; chicken-and-egg problem. Would need a two-pass approach (provision → simulate → generate policy → update)
- **Go/No-Go:** **DEFER** — high value but architecture complexity is L. Needs its own epic.
- **Dependencies:** Resource must exist first for simulation; needs post-provision hook

### Opportunity 6: WA Security enrichment for BP evaluator (pre-provision)

- **Tool:** `CheckSecurityServices` / `GetSecurityFindings`
- **Target:** bp_evaluator node
- **What:** Enrich BP findings with Well-Architected pillar references before provision
- **Effort:** S (1 day)
- **Impact:** LOW — BP already covers security. WA adds labels, not new findings.
- **Risk:** WA Security MCP currently runs post-provision (status command). Adding to plan/apply increases cold-start by ~1 server.
- **Go/No-Go:** **NO-GO** — marginal value vs. cold-start cost. bp-mcp-enricher already does this partially in advice generation.
- **Dependencies:** Would need WA_SECURITY added to plan/apply command map

### Opportunity 7: Dynamic CloudFormation type discovery via Documentation MCP

- **Tool:** `search_documentation`
- **Target:** intent_parser
- **What:** Dynamically discover new CloudFormation resource types instead of hardcoded SUPPORTED_TYPES
- **Effort:** L (3-5 days)
- **Impact:** LOW — new types require plugin implementation, not just discovery
- **Risk:** Doc page format fragile; intent parser runs on every command (latency-critical)
- **Go/No-Go:** **NO-GO** — adding a type requires a plugin (wizard fields, toCfn mapper), not just knowing it exists. Zero benefit without the plugin.
- **Dependencies:** N/A

### Opportunity 8: Replace hardcoded price hints with Pricing MCP lookups

- **Tool:** `get_pricing`
- **Target:** cost-advisor.ts hint strings
- **What:** Replace the ~11 hardcoded dollar amounts in advisory hints with live prices
- **Effort:** S (1 day)
- **Impact:** MEDIUM — keeps hints accurate, but they're already marked with `~` (approximate)
- **Risk:** Adds MCP dependency to a currently-offline code path; need graceful fallback
- **Go/No-Go:** **GO** — this is Story 44.5, already planned
- **Dependencies:** Story 44.2 (shares pricing infra)

---

## 3. Hardcoded Data Inventory

### 3.1 Price Hints (cost-advisor.ts)

| Hint                       | Current Value     | Recommendation                                  |
| -------------------------- | ----------------- | ----------------------------------------------- |
| NAT Gateway fixed cost     | ~$32/mo           | **Replace with MCP** (Story 44.5)               |
| ALB fixed cost             | ~$16/mo           | **Replace with MCP** (Story 44.5)               |
| CloudWatch alarm cost      | $0.10/alarm/month | **Replace with MCP** (Story 44.5)               |
| CloudWatch Logs ingestion  | $0.50/GB          | **Replace with MCP** (Story 44.5)               |
| CloudFront invalidation    | $0.005 each       | **Keep as-is** — rarely changes, low drift risk |
| EventBridge custom events  | $1.00/million     | **Keep as-is** — rarely changes                 |
| EFS provisioned throughput | ~$6/MiB-s-month   | **Replace with MCP** (Story 44.5)               |
| EFS One Zone savings       | ~47% cheaper      | **Keep as-is** — percentage, not absolute price |
| S3 Intelligent-Tiering     | ~45% savings      | **Keep as-is** — percentage, not absolute price |
| ARM/Graviton savings       | ~20% cheaper      | **Keep as-is** — percentage, not absolute price |

### 3.2 Instance Type Mappings (advice/constants.ts, cost-optimizer.ts)

| Data                                     | Location          | Recommendation                                     |
| ---------------------------------------- | ----------------- | -------------------------------------------------- |
| ARM_EQUIVALENTS (t3→t4g, m5→m6g, c5→c6g) | constants.ts      | **Keep as-is** — structural mapping, not a catalog |
| SPOT_ELIGIBLE_PREFIXES (t3, t4g)         | constants.ts      | **Keep as-is** — policy decision, not data         |
| RDS_LARGE_CLASS_PREFIXES (db.r5, db.r6g) | constants.ts      | **Keep as-is** — advisory threshold                |
| RDS ARM equivalents (4 mappings)         | cost-optimizer.ts | **Keep as-is** — structural mapping                |
| RDS_BUDGET_ALTERNATIVES                  | constants.ts      | **Keep as-is** — recommendation, not catalog       |

### 3.3 Lambda Pricing Fallback (constants/pricing.ts)

| Data                     | Value        | Recommendation                                         |
| ------------------------ | ------------ | ------------------------------------------------------ |
| USD_PER_MILLION_REQUESTS | 0.2          | **Keep as fallback** — stable since 2014, offline-only |
| USD_PER_GB_SECOND        | 0.0000166667 | **Keep as fallback** — same, offline-only              |
| DEFAULT_MEMORY_MB        | 128          | **Keep as-is** — AWS default                           |

### 3.4 Free Tier Maps (utils/free-tier.ts)

| Data                      | Recommendation                                       |
| ------------------------- | ---------------------------------------------------- |
| ALWAYS_FREE_RESOURCES     | **Keep as-is** — structural, not pricing data        |
| ALWAYS_FREE_WITH_LIMITS   | **Keep as-is** — limits change rarely; no MCP source |
| LEGACY_ELIGIBLE_RESOURCES | **Keep as-is** — policy boundary, not dynamic        |
| FREE_TIER_CUTOFF_DATE     | **Keep as-is** — one-time AWS policy change          |

---

## 4. Summary & Recommendations

### Concrete opportunities (≥3 required by AC):

1. **Story 44.4 — Live Lambda runtime catalog** (GO, S, HIGH impact)
2. **Story 44.2 — Live pricing in wizard labels** (GO, M, HIGH impact)
3. **Story 44.3 — Live instance type catalog** (GO, M, HIGH impact)
4. **Story 44.5 — Replace hardcoded price hints** (GO, S, MEDIUM impact)
5. **Budget-aware defaults** (DEFER — privacy risk needs UX design)
6. **Least-privilege IAM generation** (DEFER — needs own epic, L effort)
7. **WA Security pre-provision enrichment** (NO-GO — marginal value)
8. **Dynamic CFN type discovery** (NO-GO — types need plugins)

### MCP utilization score

- **Pricing MCP:** 85% utilized (5 integration points; remaining: hint strings in 44.5)
- **Documentation MCP:** 40% utilized (2 integration points; opportunities: runtime catalog, field docs)
- **IAM MCP:** 30% utilized (1 integration point; opportunity: least-privilege, but deferred)
- **WA Security MCP:** 60% utilized (3 integration points; no more practical opportunities)
- **Cost Management MCP:** 70% utilized (2 integration points; opportunity: budget-aware defaults, but deferred)

### Architecture observations

1. The existing graceful-degradation pattern (3s timeout → local fallback) is solid and should be reused by all new integrations.
2. The session price cache (price-cache.ts) prevents redundant MCP calls and should be extended to cover new pricing lookups.
3. The server-map.ts lazy loading ensures only needed servers start per command — any new integration must update this map.
4. All hardcoded dollar amounts in display code are advisory hints, not calculation inputs — the pricing pipeline is already MCP-powered.

---

_This audit feeds into Stories 44.2–44.5 scope decisions and future epic planning._
