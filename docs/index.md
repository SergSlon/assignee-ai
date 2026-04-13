# Assignee.ai -- Documentation Index

## Reverse-Engineered Documentation (Deep Scan, April 2026)

These documents were generated from a deep scan of the source code to provide a comprehensive understanding of what the codebase actually implements.

| Document                                                   | Description                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                         | Technical architecture: monorepo structure, LangGraph graph, plugin system, hexagonal ports/adapters, AWS SDK, MCP, error handling |
| [integration-architecture.md](integration-architecture.md) | How CLI, MCP server, and core package integrate; shared vs. unique code; external service dependencies                             |

## Existing Documentation

These documents were already present in the `docs/` directory:

| Document                                               | Description                         |
| ------------------------------------------------------ | ----------------------------------- |
| [architecture-flows.md](architecture-flows.md)         | Architecture flow diagrams          |
| [aws-bootstrap.md](aws-bootstrap.md)                   | AWS account bootstrapping guide     |
| [best-practices.md](best-practices.md)                 | Best practices engine documentation |
| [commands.md](commands.md)                             | CLI command reference               |
| [configuration.md](configuration.md)                   | Configuration system documentation  |
| [drift-detection.md](drift-detection.md)               | Drift detection and reconciliation  |
| [mcp-server.md](mcp-server.md)                         | MCP server documentation            |
| [quickstart.md](quickstart.md)                         | Quick start guide                   |
| [resource-types.md](resource-types.md)                 | Supported resource types            |
| [testing-guide.md](testing-guide.md)                   | Testing guide                       |
| [mcp-intelligence-audit.md](mcp-intelligence-audit.md) | MCP intelligence audit              |
| [mcp-servers.md](mcp-servers.md)                       | MCP servers overview                |

## Key Metrics (as of 2026-04-10)

| Metric                         | Count                                    |
| ------------------------------ | ---------------------------------------- |
| Supported AWS resource types   | 36                                       |
| Compound architecture patterns | 9 first-class + 1 variant                |
| LangGraph pipeline nodes       | 13                                       |
| CLI commands                   | 12                                       |
| MCP server tools               | 5                                        |
| Resource plugins               | 36 (35 + generic)                        |
| Best practice YAML rules       | 185                                      |
| Pricing strategies             | 23                                       |
| Pricing decomposers            | 23                                       |
| Config precedence levels       | 6                                        |
| LLM providers supported        | 5                                        |
| IAM credential users           | 3                                        |
| Test cases (passing)           | 6,367                                    |
| Test files                     | 256 (129 CLI + 94 core + 11 BP + 22 MCP) |
| RUN_E2E compound coverage      | 9/9 first-class compounds                |
