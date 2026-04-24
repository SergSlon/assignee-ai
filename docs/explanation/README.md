# Explanation

Understanding-oriented background. Explains the **why** and **how** behind
Assignee.ai's design decisions, architecture, and constraints.

Explanation docs are the most **discursive** of the four
[Diátaxis](https://diataxis.fr/) quadrants. They do not teach you to do
something (that is a tutorial), nor do they give you a recipe (how-to),
nor do they list facts (reference). They illuminate the thinking behind
the system so you can reason about edge cases, contribute confidently,
and understand the trade-offs.

---

## Current explanation docs

| Doc                                                      | Topic                                                                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ai-architecture.md`](ai-architecture.md)               | LLM callsites, MCP servers, BP engine, HITL interrupt — what the AI parts actually do, with code-cited accuracy                                                                  |
| [`invariants.md`](invariants.md)                         | Load-bearing rules: partition-aware ARN matching, CCAPI NotFound short-circuit, safety allowlist, placeholder preflight guard — read before touching ARN/destroy/credential code |
| [`oss-vs-saas.md`](oss-vs-saas.md)                       | What stays open-source and what monetizes — the trust-credential argument for the OSS/SaaS split                                                                                 |
| [`run-ledger-design.md`](run-ledger-design.md)           | Run-ID-based workflow stickiness via resource tags; why there is no state file                                                                                                   |
| [`contributing-a-bp-rule.md`](contributing-a-bp-rule.md) | Worked example walkthrough for contributing a new best-practice rule to the BP engine                                                                                            |
| [`flake-policy.md`](flake-policy.md)                     | Retry-once discipline, flake-rate SLO, and the quarantine process for unreliable tests                                                                                           |
| [`telemetry-design.md`](telemetry-design.md)             | Opt-in telemetry design and privacy model (design doc; implementation pending)                                                                                                   |

Also relevant at `docs/` root (pending migration to this directory):

- [`../architecture.md`](../architecture.md) — Monorepo layout, 14-node LangGraph pipeline, hexagonal ports
- [`../architecture-flows.md`](../architecture-flows.md) — End-to-end flow diagrams for plan / apply / destroy / drift
- [`../integration-architecture.md`](../integration-architecture.md) — How CLI, MCP server, and `@assignee/core` fit together

---

## When to write explanation (vs. how-to or reference)

| Situation                              | Quadrant        |
| -------------------------------------- | --------------- |
| "Why does the system work this way?"   | **Explanation** |
| "What is the complete list of X?"      | **Reference**   |
| "How do I accomplish task Y?"          | **How-to**      |
| "Walk me through from zero to working" | **Tutorial**    |

Explanation docs are allowed to be opinionated and to present
alternatives that were considered but rejected. A good explanation doc
helps a reader who disagrees understand the trade-off, not just accept
the conclusion.

---

## Further reading

| Quadrant  | Directory                        | Purpose                            |
| --------- | -------------------------------- | ---------------------------------- |
| Tutorials | [`../tutorials/`](../tutorials/) | Learning-oriented walk-throughs    |
| How-to    | [`../how-to/`](../how-to/)       | Task recipes for experienced users |
| Reference | [`../reference/`](../reference/) | Every command, flag, config option |
| Docs root | [`../index.md`](../index.md)     | Full documentation map             |
