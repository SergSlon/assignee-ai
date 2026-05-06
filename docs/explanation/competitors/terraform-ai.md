# Terraform AI (HCP Terraform AI + Spacelift Intent + ControlMonkey + ecosystem)

> _Snapshot date: April 2026. The competitive landscape moves fast — claims about specific pricing, feature surfaces, or roadmap items are accurate as of the date noted and may have shifted since. Verify against the linked official sources before acting on them._

## Positioning

"Terraform AI" is the umbrella for a cluster of 2025-2026 AI-over-Terraform offerings that give natural-language authoring and agentic execution on top of HCL workflows:

- **HCP Terraform AI** (HashiCorp / IBM, 2025) — the most mature: the HCP Terraform MCP server lets AI agents (Cursor, Claude Code, Windsurf) query the Terraform Registry, author HCL, trigger workspace runs, and receive policy-compliant plans.
- **Spacelift Intent** (open-source, April 2026) — MCP-based NL→HCL provisioning with a Sentinel/OPA policy gate; connects to the user's preferred AI assistant.
- **ControlMonkey MCP Server** — allows Cursor/Claude/Windsurf to run Terraform operations safely with guardrails.
- **Workik** — SaaS codegen tool, NL→Terraform, GitHub-integrated.
- **Terrashark** (community Claude Code skill) — grounds Terraform generation in official HashiCorp best practices to fight hallucinations.

## Scope

- All produce **HCL code**; provisioning is still `terraform plan` + `terraform apply` with state backend (local / S3 / HCP / Spacelift).
- Provider coverage = Terraform's 4,800+ providers (the category-defining moat).
- Policy/safety via Sentinel (HCP), OPA/Conftest, Checkov, or Spacelift stacks.
- Pricing: HCP Terraform per-resource-per-month under IBM (rising 18% YoY post-acquisition); Spacelift Intent free/OSS core + SaaS; Workik per-seat.

## Where they win

- **Inherits Terraform's ecosystem** — every provider, every module, every Stack Overflow answer.
- **Policy maturity** — Sentinel + OPA are battle-tested across Fortune 500.
- **MCP pattern is ecosystem-blessed** — HashiCorp, Spacelift, env0, ControlMonkey all converged on MCP as the AI-tool interface. This commoditizes the "AI + Terraform" bridge.
- **HCL is still the de-facto IaC language** — 3x CV density vs. Pulumi.

## Where Assignee.ai differentiates

- **No state file, no HCL.** Terraform AI tools end at "here's the HCL, run `terraform apply`" — user inherits state-management overhead (concurrent-apply corruption, drift, "2 AM console fixes"). Assignee provisions via CCAPI directly; source of truth is the AWS tag.
- **Cost preflight is native.** Terraform AI tools plug Infracost as a post-hoc PR comment; Assignee blocks confirm until cost is approved.
- **BP auto-fix pre-apply.** Terrashark/Checkov/Sentinel are scanners or policy engines; Assignee's 185 BP rules mutate the plan before the user sees it. Faster than policy-deny → edit → retry loop.
- **HITL in English, not HCL review.** User reads "Create RDS db.t3.medium, $34/mo, encrypted" — not a `diff` of `aws_db_instance.this` HCL.
- **Risk:** HCP Terraform AI + Spacelift Intent collectively cover the HCL-literate platform-engineer audience. Assignee must own the _non-Terraform-literate AWS user_ — anyone who already thinks in HCL will prefer the ecosystem.

## Source URLs

- https://spacelift.io/blog/terraform-ai
- https://controlmonkey.io/blog/terraform-ai-prompts/
- https://www.firefly.ai/academy/terraform-ai
- https://github.com/LukasNiessen/terrashark
- https://workik.com/terraform-code-generator

## Related

- `competitors/pulumi-ai.md` — direct analog in the Pulumi stack
- `competitors/claude-writes-terraform.md` — the raw-LLM baseline these sit on top of
- `competitors/cdk-ai.md` — AWS-native equivalent
