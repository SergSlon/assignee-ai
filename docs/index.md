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

## [Runbooks](runbooks/) — operator how-tos

Step-by-step operational guides for on-call engineers. See
[`runbooks/README.md`](runbooks/README.md) for the full index.

| Doc                                                            | Goal                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [runbooks/incident-response.md](runbooks/incident-response.md) | Incident classification, triage checklist, playbooks, rollback, post-mortem |

## [Reference](reference/) — information-oriented

Dry, precise, lookup-style information. Skim the tables; search for specifics.
See [`reference/README.md`](reference/README.md) for the migration roadmap
(root-level reference docs move to `reference/` in a future subwave).

**In `reference/` subdirectory:**

| Doc                      | What it catalogs                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [reference/](reference/) | Auto-generated per-type reference pages (one page per supported AWS resource type — see `help-hints.ts` for the runtime count) |

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
| [explanation/telemetry-design.md](explanation/telemetry-design.md)                                 | Opt-in telemetry design + privacy model (no code yet; design doc gating future PRs)                                                       |
| [explanation/run-ledger-design.md](explanation/run-ledger-design.md)                               | Run-ID-based workflow stickiness via tags; why there is no state file                                                                     |
| [explanation/contributing-a-bp-rule.md](explanation/contributing-a-bp-rule.md)                     | Worked example walkthrough for contributing a new best-practice rule                                                                      |
| [explanation/flake-policy.md](explanation/flake-policy.md)                                         | Retry-once discipline, flake-rate SLO, and quarantine process for unreliable tests                                                        |
| [explanation/ci-gates.md](explanation/ci-gates.md)                                                 | Every CI gate, what it checks, and when it fires                                                                                          |
| [explanation/codeowners-and-branch-protection.md](explanation/codeowners-and-branch-protection.md) | CODEOWNERS structure and branch-protection rules                                                                                          |
| [explanation/domain-ownership.md](explanation/domain-ownership.md)                                 | How code ownership is sliced across the monorepo                                                                                          |
| [explanation/sbom.md](explanation/sbom.md)                                                         | Software Bill of Materials — generation, format, and published artifact location                                                          |
| [explanation/supply-chain-provenance.md](explanation/supply-chain-provenance.md)                   | Artifact signing, provenance attestation, and supply-chain security model                                                                 |

**Canonical root explanations** (explanation quadrant, no subdirectory counterpart):

| Doc                                                        | Topic                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| [architecture.md](architecture.md)                         | Monorepo layout, 14-node LangGraph pipeline, hexagonal ports |
| [architecture-flows.md](architecture-flows.md)             | End-to-end flow diagrams for plan / apply / destroy / drift  |
| [integration-architecture.md](integration-architecture.md) | How CLI, MCP server, and `@assignee/core` fit together       |

---

## Key metrics

> **Note:** Counts for resource types, compound patterns, BP rules, pricing
> strategies, and decomposers are the runtime SSOT — see
> `packages/core/src/config/help-hints.ts` and run `pnpm doc-lint` /
> `pnpm -r test:coverage` for live values. Numbers in this table are
> illustrative; trust the registry, not this doc.

| Metric                         | Count / Source                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Supported AWS resource types   | see `help-hints.ts` (36 with dedicated plugins + 2 compound-only: `EC2::VPCGatewayAttachment`, `EC2::SubnetRouteTableAssociation`)  |
| Compound architecture patterns | see `help-hints.ts` (first-class compounds)                                                                                         |
| LangGraph pipeline nodes       | 14                                                                                                                                  |
| CLI commands                   | 15                                                                                                                                  |
| MCP server tools               | 5                                                                                                                                   |
| Resource plugins               | see `help-hints.ts` (type-specific + generic fallback; compound-only types share the generic)                                       |
| Best practice YAML rules       | see `packages/best-practices/manifest.json` (count enforced by `pnpm doc-lint`)                                                     |
| Pricing strategies             | see `pnpm doc-lint` for live count                                                                                                  |
| Pricing decomposers            | see `pnpm doc-lint` for live count                                                                                                  |
| Config precedence levels       | 6                                                                                                                                   |
| LLM providers supported        | 5                                                                                                                                   |
| IAM credential users           | 3                                                                                                                                   |
| Test files                     | across 4 packages (cli + mcp-server + core + best-practices) — run `pnpm -r test:coverage` for live counts                          |
| RUN_E2E compound coverage      | full registry exercised E2E — see `apps/cli/src/e2e/e2e-plan-compounds-{container,lambda,storage,three-tier,web}.test.ts` (5 files) |

> Full release history is in [`docs/engineering/changelog-history.md`](engineering/changelog-history.md).
