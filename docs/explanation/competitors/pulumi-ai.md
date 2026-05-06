# Pulumi AI / Copilot / Neo

> _Snapshot date: April 2026. The competitive landscape moves fast — claims about specific pricing, feature surfaces, or roadmap items are accurate as of the date noted and may have shifted since. Verify against the linked official sources before acting on them._

## Positioning

Pulumi AI is the umbrella for three overlapping AI surfaces on top of Pulumi's multi-language IaC platform:

1. **Pulumi AI** (2023) — natural language → Pulumi code generation (TypeScript/Python/Go/C#/Java/YAML). 200k+ questions asked publicly.
2. **Pulumi Copilot** (2024) — VS Code + Pulumi Cloud assistant with four skills (Insights, Cloud API, Code, Docs). Troubleshoots compliance errors, queries resource state.
3. **Pulumi Neo** (Sept 2025) — "agentic AI platform engineer." Natural language multi-step workflows ("find all Lambda functions with deprecated runtimes and upgrade them"), autonomous execution with **PR-based approval gates**, policy remediation, SOC 2 governance.

Pulumi Cloud: $1.5B valuation (Oct 2025 Series D, $145M); Seattle; ~200 employees.

## Scope

- Multi-cloud (AWS, Azure, GCP, Kubernetes, 100+ providers) via Pulumi's resource providers.
- State-backed IaC — requires Pulumi Cloud or self-hosted state backend.
- Produces or mutates Pulumi **code**; the deployment loop is still `pulumi up` (generate → review PR → apply).
- Pricing: Individual free (no AI), **Team $40/mo (Neo included)**, Enterprise $400/mo, Business Critical custom.

## Where they win

- Most mature AI roadmap in IaC; Neo is the only production agentic IaC agent today.
- Multi-cloud (Assignee is AWS-only today; Epic 13 deferred).
- Real programming languages — loops, conditionals, types — vs HCL limitations.
- PR-based approval integrates with existing GitHub/GitLab review culture.
- Werner Enterprises case study: 3 days → 4 hours provisioning (75% faster).

## Where Assignee.ai differentiates

- **No IaC to learn**: Pulumi Neo generates/mutates Pulumi code; the user still lives inside the Pulumi model (state, stacks, providers, programming language). Assignee provisions directly via CloudControl API — no code artifact to maintain.
- **Entry bar**: Assignee is a free CLI (pre-public) vs Pulumi's $40/mo Team tier for any AI and Pulumi Cloud lock-in for state.
- **Local-first**: Assignee runs Bedrock inference against the user's own AWS account; no credentials leave the machine. Pulumi Cloud holds state.
- **Built-in loop**: Cost preflight + 185 BP rules + auto-fix + HITL are first-class; Pulumi treats policy-as-code as a separate SKU (CrossGuard/Policy Packs).
- **Stateless provisioning**: CCAPI is the source of truth; no state file to corrupt or drift.

## Source URLs

- https://www.pulumi.com/docs/ai/
- https://www.pulumi.com/docs/pulumi-cloud/neo/
- https://www.pulumi.com/pricing/
- https://www.infoq.com/news/2025/09/pulumi-neo/
- https://www.pulumi.com/blog/2025-product-launches/

## Related

- `competitors/kagent.md` — different scope (K8s ops)
- `competitors/sst.md` — different scope (app framework)
