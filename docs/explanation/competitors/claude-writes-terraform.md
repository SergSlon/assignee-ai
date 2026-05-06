# Claude writes Terraform (the raw-LLM baseline)

> _Snapshot date: April 2026. The competitive landscape moves fast — claims about specific pricing, feature surfaces, or roadmap items are accurate as of the date noted and may have shifted since. Verify against the linked official sources before acting on them._

## Positioning

The **baseline competitor**: a Terraform-literate engineer already using Claude Code / Cursor / Windsurf + the HashiCorp Terraform MCP server + a community Claude Code skill (e.g. `terrashark`, `lgbarn/devops-skills`, `jeffallan/claude-skills/terraform-engineer`) + a `CLAUDE.md` file. No dedicated product. No subscription beyond what they already pay for Claude. This is the "do I even need Assignee?" bar.

Typical setup in April 2026:

- Claude Code terminal + `CLAUDE.md` with Terraform safety rules
- HashiCorp Terraform MCP server for registry queries + workspace runs
- Checkov / Trivy / `tflint` as pre-commit hooks
- Infracost for PR cost comments
- Manual `terraform plan | apply` with the engineer reviewing HCL diff

## Scope

- Generates any provider's HCL (Terraform's 4,800+ ecosystem, not AWS-only).
- Runs the full `init → plan → apply → state` loop locally or via HCP/Spacelift.
- Relies on the engineer to read HCL diffs, catch hallucinations, and own state.
- Community Claude-Code skills (e.g. Terrashark, lgbarn/devops-skills) explicitly exist to "fix the fact that LLMs hallucinate a lot with Terraform."

## Where they win

- **Zero marginal cost** — engineer already pays for Claude; no new SaaS.
- **Full Terraform ecosystem** — every provider, every module, every Stack Overflow answer.
- **Full IDE context** — Claude Code sees the entire repo including existing modules, variables, state references.
- **Portable** — HCL is an asset the engineer keeps regardless of AI tooling evolution.
- **Community skill churn** — new Claude Code skills ship weekly; whatever breaks today gets fixed by a community PR next week.
- **Martin Koníček, Pablo Jusue et al. public posts** confirm this workflow is fully viable for production IaC as of 2026.

## Where Assignee.ai differentiates (and where it doesn't)

**Wins:**

- **No HCL to read.** The target Assignee user doesn't want to review `aws_db_instance` blocks — wants to read "RDS db.t3.medium, encrypted, $34/mo. Confirm?" HCL-fluent engineers don't need this.
- **Opinionated BP + compound patterns.** Assignee ships 185 BP rules + 9 compound patterns pre-vetted. Claude-writes-TF requires the engineer to compose Checkov/Trivy/tflint/Sentinel themselves.
- **Cost-confirm is the single gate.** Claude-writes-TF has cost via Infracost _after_ PR is opened; Assignee blocks before apply.
- **No state to own.** Claude-writes-TF inherits Terraform state backend headaches (concurrent apply, drift, "2 AM console fixes").

**Doesn't win (honest):**

- **For HCL-literate platform engineers, Claude Code + Terraform MCP is good enough.** This is the single largest segment Assignee cannot outcompete on features alone. Positioning must avoid this fight and anchor on the non-HCL audience + cost governance + AWS-only simplicity.
- **Provider coverage.** Assignee covers 23+ AWS resource types; Claude-writes-Terraform covers everything Terraform does. For non-AWS or long-tail AWS services, the baseline wins.

## Strategic implication

**This is the hardest competitor, not Pulumi Neo.** Pulumi Neo has a $40/mo+ price tag and a Pulumi Cloud lock-in; Claude-writes-Terraform has neither. Any feature Assignee ships gets asked "why not just add a Claude Code skill for this?" within 30 days. Differentiation survives only on (a) the non-Terraform audience, (b) the atomic cost + HITL + BP auto-fix pre-apply bundle, and (c) zero-setup first-run UX.

## Source URLs

- https://www.martinkonicek.eu/posts/claude-code-iac/
- https://medium.com/@pablojusue/harnessing-claude-code-and-terraform-mcp-servers-for-smarter-infrastructure-as-code-6e67f91884f1
- https://github.com/LukasNiessen/terrashark
- https://github.com/lgbarn/devops-skills
- https://medium.com/@balwant.matharu/how-claude-code-supercharged-my-terraform-workflow-0e0a53349251
- https://jeffallan.github.io/claude-skills/skills/infrastructure/terraform-engineer/

## Related

- `competitors/terraform-ai.md` — productized versions of this baseline
- `competitors/cdk-ai.md` — AWS-native equivalent via Amazon Q
- `competitors/pulumi-ai.md` — the commercial counter-bet
