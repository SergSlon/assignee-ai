# OSS vs SaaS — what stays free forever, what earns money later

> Diátaxis: **explanation** (understanding-oriented). The monetisation
> split is a design choice, not a tactic. This document explains the
> trust-credential argument behind it and draws the line between the
> OSS boundary and the (eventual) SaaS tier. No SaaS product exists
> today — this is the forward-looking contract with contributors and
> early users.

## The short version

- **OSS, MIT, forever:** the `assignee` CLI, the LangGraph
  pipeline, the MCP server, the 185 BP rules + 9 compound patterns,
  cost preflight, mandatory tagging, the Bedrock adapter (BYOK), and
  the single-user run-ledger. (License chosen for maximum downstream
  reuse — see [LICENSE](../../LICENSE); earlier drafts floated
  Apache-2.0 but MIT ships the same permissive contract with lower
  compliance overhead for Mara's-scale users.)
- **Future SaaS tier (post-traction, no commitment date):** multi-user
  org + RBAC + SSO, signed-intent audit trail (KMS ECDSA), org-wide
  policy-as-code, anonymised provisioning telemetry, drift detection +
  continuous reconciliation, and private BP-rule packs for compliance
  regimes (SOC 2 / PCI / HIPAA).

## Why this split

Security teams won't install a black-box CLI that touches AWS
credentials — period. Every other infrastructure-facing product that
crossed this chasm (Terraform, Pulumi, Infracost, OpenTofu) did it by
making the credential-holding code 100 % open-source and inspectable,
and monetising the _coordination layer_ that lives above it. The
pattern holds because the coordination layer (multi-user identity, org
policy, drift) has genuine willingness-to-pay from enterprise buyers
and genuinely cannot be shipped as a CLI.

OSS is the trust credential. SaaS is where the revenue is. Splitting
them up front, publicly, forces design discipline: every feature on the
OSS side of the line is answerable to "would a security team audit
this?" and every feature on the SaaS side is answerable to "does an
enterprise with > 50 engineers pay for this?" A feature that doesn't
answer either question gets cut.

## What stays OSS

### The CLI and its dependencies

The `assignee` CLI binary, the 13-node LangGraph pipeline, the hexagonal
ports / adapters under `@assignee/core`, the MCP adapters, and the MCP
server (`@assignee/mcp-server`) are all MIT-licensed, forever. That
includes:

- **Every AWS credential path.** `operatorCredentials()`,
  `readerCredentials()`, `auditorCredentials()` — every function that
  reads `~/.aws/credentials` or an env var is open. We want security
  auditors to trace the credential flow in a hour, not a week.
- **Every provisioning call.** The CloudControl dispatcher, the
  fallback path, the error hint registry, the run-ledger writer.
- **Every BP evaluator code path.** The YAML loader, the Zod schema,
  the trigger language, the auto-fix patch application, the interactive
  fix UX.

### The 185 BP rules + 9 compound patterns

The rule library at [`packages/best-practices/`](../../packages/best-practices)
is MIT-licensed. Community contributions are welcome (see
[`CONTRIBUTING.md § Contributing a Best-Practice Rule`](../../CONTRIBUTING.md#contributing-a-best-practice-rule))
— the network-effect bet is that a community-contributed rule library
compounds over time and a competitor's proprietary rule set doesn't.

The nine canonical compound patterns (`s3-static-site`, `efs-with-vpc`,
`rds-with-vpc`, etc.) stay OSS for the same reason: they're a reusable
knowledge artifact, not a monetisation surface.

### Cost preflight and mandatory tagging

The `@aws-pricing` MCP integration, the pricing strategies, the free-tier
detection, the budget-guard pre-confirm check — all OSS. The
mandatory-tag injector (`managed-by` + `assignee-run-id` + `environment`)
is OSS. These are the features most users identify with Assignee's
opinion, and opinion is a product quality, not a monetisation surface.

### Bedrock adapter (BYOK)

Users bring their own AWS account and their own Bedrock model access.
There is no Assignee-operated LLM endpoint and no plan to build one on
the OSS side. The [`LlmAdapter`](../../packages/core/src/llm/adapter.ts)
wraps the Bedrock SDK with region / availability error hints and
token-cost telemetry — all open.

### Single-user run-ledger

The local run-ledger (tags + memory records + checkpoint files) stays
OSS. See [`run-ledger-design.md`](./run-ledger-design.md) for the
current capabilities and the deferred `destroy --run-id <uuid>` work.

The key OSS property: **no Assignee-operated server is in the loop**.
Every bit of state lives in the user's AWS account (resource tags) or
the user's local filesystem (`~/.assignee/memory/`).

## What the SaaS tier will monetise (post-traction)

None of these features exist today. They are the forward-looking
commitment: when Assignee ships a SaaS product, these are the features
that will live behind the paywall.

### Multi-user org + RBAC + SSO

A single-user CLI is great for founders and small teams. A 50-engineer
platform team needs role-based access control, SSO (Okta, Azure AD),
and per-environment approval policies. That layer is server-side
infrastructure — it has no OSS analogue and it has clear willingness to
pay from enterprise buyers.

### Signed-intent audit trail (KMS ECDSA)

Every approved plan gets signed with a customer-managed KMS ECDSA key
at apply time. The signature + the plan JSON + the runId are stored in
a tamper-evident log (S3 with Object Lock + CloudTrail). Auditors can
verify "who approved what, when, and against which rule set" years
later. This is compliance-grade provenance; consumers who need it
(financial services, healthcare, regulated SaaS) pay for it.

### Org-wide policy-as-code

BP rules are already data today — the SaaS extension is a central
policy store that every CLI instance in the org pulls from. Team-wide
deny rules ("no public S3 buckets in any account", "no unencrypted
RDS") enforced from a central control plane instead of per-workstation
config. Re-uses the OSS rule format; adds the distribution layer.

### Anonymised provisioning telemetry → cost-optimisation recommendations

This is the data-moat bet. With 10 000 installs × provisioning patterns,
Assignee can surface recommendations no incumbent has — "87 % of teams
pick `t3.medium` but `t4g.medium` saves 20 % for your workload shape."
The OSS side ships the telemetry opt-in design
([`telemetry-design.md`](./telemetry-design.md)) on day 1; the SaaS
side operates the receive-endpoint and the analytics pipeline.

Opt-in is mandatory. There is no telemetry path that fires without
explicit user consent, ever, on the OSS _or_ the SaaS side.

### Drift detection + continuous reconciliation

The OSS run-ledger is a snapshot — the resource tags + provision
records at the moment of apply. Drift is what happens after: someone
edits the S3 bucket policy in the AWS console, or a Terraform import
re-tags a resource, or IAM permissions get rotated. Drift detection
(compare live state against the desired-state hash in the provision
record) + continuous reconciliation (auto-revert or alert) is a
per-resource-hour billable service. It's also the primary answer to
kagent's day-2 operational story (see the
[L10 review § Kagent delta](../../../_bmad-output/planning-artifacts/_archive/research/epic-50/L10-moat.md)).

### Private BP-rule libraries

SOC 2, PCI-DSS, HIPAA, FedRAMP — each compliance regime wants a
curated, maintained, legally-defensible rule set. Those rule sets take
full-time security engineers to maintain; they're not a community
project. `assignee bp install @owner/soc2-pack` becomes a subscription
SKU, with provenance (who maintains the pack, when was it last
audited, which controls it covers) as the premium.

## Explicit non-goals

Things we will **not** monetise, to keep the OSS side whole:

- **Access to the 185 rules.** The shipped rules stay free.
- **Access to the compound patterns.** The nine shipped patterns stay
  free.
- **Cost preflight.** The pre-confirm cost estimate stays free.
- **A "pro" version of the CLI.** The binary is one build, OSS,
  forever. No feature flags gated on a license server.
- **Plan generation throttling.** No rate limit on `assignee plan`.

If we ever cross one of these lines, that's a signal we lost the trust
credential — and probably the product with it.

## Why we're publishing this before shipping the SaaS

Two reasons:

1. **Contributor clarity.** Anyone contributing a BP rule should know
   their rule stays MIT-licensed, forever, no matter how big Assignee
   gets. The pledge has to be on paper before the first community
   rule lands.
2. **Forcing function.** Every SaaS feature listed above has to hold up
   under "would a paying enterprise buyer actually pay for this on top
   of the free CLI?" If the answer is no, the feature is on the wrong
   side of the line. Publishing the split surfaces that question early.

## Related reading

- [`run-ledger-design.md`](./run-ledger-design.md) — single-user ledger
  (OSS) and multi-resource destroy (deferred).
- [`telemetry-design.md`](./telemetry-design.md) — the opt-in design
  that unlocks the data-moat SaaS bet.
- [`contributing-a-bp-rule.md`](./contributing-a-bp-rule.md) — the
  contribution on-ramp that community-rule network effects depend on.
- [Epic 50 L10 review](../../../_bmad-output/planning-artifacts/_archive/research/epic-50/L10-moat.md)
  — the strategic analysis this split implements.
