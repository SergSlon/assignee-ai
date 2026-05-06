# Assignee.ai — Documentation

Docs organized by the [Diátaxis](https://diataxis.fr/) framework — four
quadrants: **Tutorials**, **How-to**, **Reference**, **Explanation**.
Pick the quadrant that matches what you want to do.

> Note on the two MCP docs: `mcp-server.md` covers how to **expose** the
> assignee CLI as an MCP server for IDEs (Cursor, Claude Code, Windsurf).
> `mcp-servers.md` is a **reference** for the AWS MCP servers that assignee
> itself consumes internally (Pricing, Documentation, IAM, Security, Billing).
> Different topics — both are canonical.

---

## [Tutorials](tutorials/) — learning-oriented

Step-by-step narrative lessons to get you from zero to a working setup.
Read these first if you are new to assignee.ai. See
[`tutorials/README.md`](tutorials/README.md) for the quadrant overview
and contribution guide.

| Doc                                                          | What you'll learn                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [tutorials/getting-started.md](tutorials/getting-started.md) | Your first ten minutes with assignee — install, init, plan, apply, verify, destroy |

## [How-to guides](how-to/) — task-oriented

Recipes for accomplishing specific goals. Assume you already know the basics.
See [`how-to/README.md`](how-to/README.md) for the full guide list and
the backlog of pending how-tos.

**In `how-to/` subdirectory:**

| Doc                                                              | Goal                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| [how-to/quickstart.md](how-to/quickstart.md)                     | Install the CLI, bootstrap AWS, plan and apply your first resource |
| [how-to/read-a-plan-box.md](how-to/read-a-plan-box.md)           | Decode every section of the `assignee plan` plan box               |
| [how-to/sso-authentication.md](how-to/sso-authentication.md)     | Authenticate with AWS SSO / Identity Center profiles               |
| [how-to/install-via-homebrew.md](how-to/install-via-homebrew.md) | Install the CLI via the Homebrew tap                               |
| [how-to/release-process.md](how-to/release-process.md)           | Run or observe the CLI release pipeline                            |

**Canonical root how-tos** (how-to quadrant, no subdirectory counterpart):

| Doc                                      | Goal                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| [aws-bootstrap.md](aws-bootstrap.md)     | Set up an AWS account and IAM users end-to-end for assignee.ai   |
| [drift-detection.md](drift-detection.md) | Detect and reconcile config drift between desired and live state |
| [mcp-server.md](mcp-server.md)           | Expose assignee.ai as an MCP server to your IDE                  |
| [testing-guide.md](testing-guide.md)     | Run the project's test suite and add new tests                   |

### Operator how-tos (subset) — `runbooks/`

`runbooks/` is **not** a fifth Diátaxis quadrant; it is a how-to
sub-folder reserved for on-call operator playbooks (incident triage,
rollback, post-mortem). All runbook entries are how-to guides — they
just live one directory deeper so on-call rotations can bookmark a
single index. See [`runbooks/README.md`](runbooks/README.md).

| Doc                                                            | Goal                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [runbooks/incident-response.md](runbooks/incident-response.md) | Incident classification, triage checklist, playbooks, rollback, post-mortem |

## [Reference](reference/) — information-oriented

Dry, precise, lookup-style information. Skim the tables; search for specifics.
See [`reference/README.md`](reference/README.md) for the quadrant overview.

**In `reference/` subdirectory:**

| Doc                                        | What it catalogs                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [reference/README.md](reference/README.md) | Index of auto-generated per-type reference pages (one page per supported AWS resource type — see the resource-type registry at `packages/core/src/config/resource-types/supported.ts` for the canonical count) |

**Canonical root references** (reference quadrant, no subdirectory counterpart):

| Doc                                      | What it catalogs                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [commands.md](commands.md)               | Every CLI command, flag, and exit code (lookup-style reference)                                                 |
| [resource-types.md](resource-types.md)   | Every supported AWS resource type and its plugin (see `help-hints.ts` for the runtime count)                    |
| [configuration.md](configuration.md)     | Full config precedence chain, env vars, and file formats                                                        |
| [mcp-servers.md](mcp-servers.md)         | AWS MCP servers consumed by the pipeline (pins + tools)                                                         |
| [best-practices.md](best-practices.md)   | Best-practice rule engine and shipped rules (see `packages/best-practices/manifest.json` for the runtime count) |
| [troubleshooting.md](troubleshooting.md) | Exit codes and error-class playbook (Bedrock region, CCAPI NotFound, throttling, expired creds, …)              |

## [Explanation](explanation/) — understanding-oriented

Background, design rationale, and the "why" behind the system. Read these
when you want to understand how assignee.ai thinks. See
[`explanation/README.md`](explanation/README.md) for the full topic index.

**In `explanation/` subdirectory:**

| Doc                                                                                                | Topic                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [explanation/ai-architecture.md](explanation/ai-architecture.md)                                   | **What the AI parts actually do** — LLM callsites, MCP servers, BP engine, HITL interrupt, with code-cited accuracy + a real captured run |
| [explanation/invariants.md](explanation/invariants.md)                                             | Load-bearing rules (partition-aware ARN, CCAPI NotFound short-circuit, safety allowlist, …) — read before touching ARN/destroy/cred code  |
| [explanation/oss-vs-saas.md](explanation/oss-vs-saas.md)                                           | What stays OSS and what monetizes — the trust-credential argument for the split                                                           |
| [explanation/telemetry-design.md](explanation/telemetry-design.md)                                 | Opt-in telemetry design and privacy model — design doc gating future PRs (no code yet)                                                    |
| [explanation/run-ledger-design.md](explanation/run-ledger-design.md)                               | Run-ID-based workflow stickiness via tags; why there is no state file                                                                     |
| [explanation/contributing-a-bp-rule.md](explanation/contributing-a-bp-rule.md)                     | Worked example walkthrough for contributing a new best-practice rule                                                                      |
| [explanation/flake-policy.md](explanation/flake-policy.md)                                         | Retry-once discipline, flake-rate SLO, and quarantine process for unreliable tests                                                        |
| [explanation/ci-gates.md](explanation/ci-gates.md)                                                 | Every CI gate, what it checks, and when it fires                                                                                          |
| [explanation/codeowners-and-branch-protection.md](explanation/codeowners-and-branch-protection.md) | CODEOWNERS structure and branch-protection rules                                                                                          |
| [explanation/domain-ownership.md](explanation/domain-ownership.md)                                 | How code ownership is sliced across the monorepo                                                                                          |
| [explanation/sbom.md](explanation/sbom.md)                                                         | Software Bill of Materials — generation, format, and published artifact location                                                          |
| [explanation/supply-chain-provenance.md](explanation/supply-chain-provenance.md)                   | Artifact signing, provenance attestation, and supply-chain security model                                                                 |

**Canonical root explanations** (explanation quadrant, no subdirectory counterpart):

| Doc                                                        | Topic                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| [architecture.md](architecture.md)                         | Monorepo layout, LangGraph pipeline, hexagonal ports        |
| [architecture-flows.md](architecture-flows.md)             | End-to-end flow diagrams for plan / apply / destroy / drift |
| [integration-architecture.md](integration-architecture.md) | How CLI, MCP server, and `@assignee/core` fit together      |

---

## Key metrics — runtime SSOT pointers

Every count in this project is computed at runtime from a single source
of truth (SSOT). Do not memorise numbers from this page; query the
registry instead. The pointers below are the only canonical answer.

| Metric                         | Source of truth                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported AWS resource types   | the resource-type registry — [`packages/core/src/config/resource-types/supported.ts`](../packages/core/src/config/resource-types/supported.ts)           |
| Compound architecture patterns | the pattern-template registry — [`packages/core/src/pattern-templates/index.ts`](../packages/core/src/pattern-templates/index.ts)                        |
| LangGraph pipeline nodes       | the LangGraph builder — [`packages/core/src/graph/create-graph.ts`](../packages/core/src/graph/create-graph.ts)                                          |
| CLI commands                   | the CLI entrypoint — [`apps/cli/src/index.ts`](../apps/cli/src/index.ts)                                                                                 |
| MCP server tools               | the MCP server tool registry — [`apps/mcp-server/src/tools/`](../apps/mcp-server/src/tools/)                                                             |
| Resource plugins               | the plugin barrel — [`packages/core/src/resource-plugins/index.ts`](../packages/core/src/resource-plugins/index.ts) (type-specific + generic fallback)   |
| Best practice YAML rules       | the BP rule library — [`packages/best-practices/manifest.json`](../packages/best-practices/manifest.json) (count enforced by `pnpm doc-lint`)            |
| Pricing strategies             | the pricing strategy registry — [`packages/core/src/pricing/strategies/`](../packages/core/src/pricing/strategies/) (live count via `pnpm doc-lint`)     |
| Pricing decomposers            | the pricing decomposer registry — [`packages/core/src/pricing/decomposers/`](../packages/core/src/pricing/decomposers/) (live count via `pnpm doc-lint`) |
| Config precedence levels       | the config resolver — [`packages/core/src/config/resolve-global-config.ts`](../packages/core/src/config/resolve-global-config.ts)                        |
| LLM providers supported        | the LLM adapter — [`packages/core/src/llm/adapter.ts`](../packages/core/src/llm/adapter.ts)                                                              |
| IAM credential users           | the IAM-policies barrel — [`packages/core/src/config/iam-policies/index.ts`](../packages/core/src/config/iam-policies/index.ts)                          |
| Test counts                    | run `pnpm -r test:coverage` for live counts across all packages                                                                                          |
| E2E compound coverage          | the e2e suite — [`apps/cli/src/e2e/`](../apps/cli/src/e2e/) (compound coverage gated by `RUN_E2E=1`)                                                     |

> Full release history is in [`docs/engineering/changelog-history.md`](engineering/changelog-history.md).
