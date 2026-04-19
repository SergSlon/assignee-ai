# Assignee.ai — Documentation

Docs organized by the [Diátaxis](https://diataxis.fr/) framework. Pick the
quadrant that matches what you want to do.

> Note on the two MCP docs: `mcp-server.md` covers how to **expose** the
> assignee CLI as an MCP server for IDEs (Cursor, Claude Code, Windsurf).
> `mcp-servers.md` is a **reference** for the AWS MCP servers that assignee
> itself consumes internally (Pricing, Documentation, IAM, Security, Billing).
> Different topics — both are canonical.

---

## Tutorials — learning-oriented

Step-by-step lessons to get you from zero to a working setup. Read these first
if you are new to assignee.ai.

| Doc                                  | What you'll learn                                                  |
| ------------------------------------ | ------------------------------------------------------------------ |
| [quickstart.md](quickstart.md)       | Install the CLI, bootstrap AWS, plan and apply your first resource |
| [aws-bootstrap.md](aws-bootstrap.md) | Set up an AWS account and IAM users end-to-end for assignee.ai     |

## How-to guides — task-oriented

Recipes for accomplishing specific goals. Assume you already know the basics.

| Doc                                                    | Goal                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| [drift-detection.md](drift-detection.md)               | Detect and reconcile config drift between desired and live state |
| [how-to/read-a-plan-box.md](how-to/read-a-plan-box.md) | Decode every section of the `assignee plan` plan box             |
| [mcp-server.md](mcp-server.md)                         | Expose assignee.ai as an MCP server to your IDE                  |
| [testing-guide.md](testing-guide.md)                   | Run the project's test suite and add new tests                   |

## Reference — information-oriented

Dry, precise, lookup-style information. Skim the tables; search for specifics.

| Doc                                      | What it catalogs                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [commands.md](commands.md)               | Every CLI command, flag, and exit code (lookup-style reference)                                    |
| [resource-types.md](resource-types.md)   | Every supported AWS resource type and its plugin                                                   |
| [configuration.md](configuration.md)     | Full config precedence chain, env vars, and file formats                                           |
| [mcp-servers.md](mcp-servers.md)         | AWS MCP servers consumed by the pipeline (pins + tools)                                            |
| [best-practices.md](best-practices.md)   | Best-practice rule engine and the 185 shipped rules                                                |
| [troubleshooting.md](troubleshooting.md) | Exit codes and error-class playbook (Bedrock region, CCAPI NotFound, throttling, expired creds, …) |

## Explanation — understanding-oriented

Background, design rationale, and the "why" behind the system. Read these
when you want to understand how assignee.ai thinks.

| Doc                                                                            | Topic                                                                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                                             | Monorepo layout, 13-node LangGraph pipeline, hexagonal ports                                                                             |
| [architecture-flows.md](architecture-flows.md)                                 | End-to-end flow diagrams for plan / apply / destroy / drift                                                                              |
| [integration-architecture.md](integration-architecture.md)                     | How CLI, MCP server, and `@assignee/core` fit together                                                                                   |
| [explanation/invariants.md](explanation/invariants.md)                         | Load-bearing rules (partition-aware ARN, CCAPI NotFound short-circuit, safety allowlist, …) — read before touching ARN/destroy/cred code |
| [explanation/oss-vs-saas.md](explanation/oss-vs-saas.md)                       | What stays OSS and what monetizes — the trust-credential argument for the split                                                          |
| [explanation/telemetry-design.md](explanation/telemetry-design.md)             | Opt-in telemetry design + privacy model (no code yet; design doc gating future PRs)                                                      |
| [explanation/run-ledger-design.md](explanation/run-ledger-design.md)           | Run-ID-based workflow stickiness via tags; why there is no state file                                                                    |
| [explanation/contributing-a-bp-rule.md](explanation/contributing-a-bp-rule.md) | Worked example walkthrough for contributing a new best-practice rule                                                                     |

---

## Key metrics (as of 2026-04-19)

| Metric                         | Count                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported AWS resource types   | 37 (35 with dedicated plugins + 2 compound-only that fall through to the generic plugin: `EC2::VPCGatewayAttachment`, `EC2::SubnetRouteTableAssociation`) |
| Compound architecture patterns | 10 first-class                                                                                                                                            |
| LangGraph pipeline nodes       | 13                                                                                                                                                        |
| CLI commands                   | 13                                                                                                                                                        |
| MCP server tools               | 5                                                                                                                                                         |
| Resource plugins               | 37 registered (35 type-specific + generic fallback; 2 compound-only types share the generic)                                                              |
| Best practice YAML rules       | 185 (count matches `packages/best-practices/manifest.json`)                                                                                               |
| Pricing strategies             | 23                                                                                                                                                        |
| Pricing decomposers            | 23                                                                                                                                                        |
| Config precedence levels       | 6                                                                                                                                                         |
| LLM providers supported        | 5                                                                                                                                                         |
| IAM credential users           | 3                                                                                                                                                         |
| Test files                     | 307 across 4 packages (72 CLI + 24 MCP + 200 core + 11 BP) — run `pnpm test` for the live pass count                                                      |
| RUN_E2E compound coverage      | 9/10 first-class compounds (vpc-public-only not yet exercised)                                                                                            |
