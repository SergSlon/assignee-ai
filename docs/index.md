# Assignee.ai -- Documentation Index

## Reverse-Engineered Documentation (Deep Scan, April 2026)

These documents were generated from a deep scan of the source code to provide a comprehensive understanding of what the codebase actually implements.

| Document                                                   | Description                                                                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [project-overview.md](project-overview.md)                 | Comprehensive overview: features, commands, pipeline, resource types, patterns, pricing, config, memory                                                        |
| [architecture.md](architecture.md)                         | Technical architecture: monorepo structure, LangGraph graph, plugin system, hexagonal ports/adapters, AWS SDK, MCP, error handling                             |
| [source-tree-analysis.md](source-tree-analysis.md)         | Annotated directory tree showing what every critical file and directory does                                                                                   |
| [component-inventory.md](component-inventory.md)           | Complete inventory of all plugins (24), nodes (12), services (28), utilities (30+), pricing strategies (23), decomposers (23), best practices (136 YAML rules) |
| [integration-architecture.md](integration-architecture.md) | How CLI, MCP server, and core package integrate; shared vs. unique code; external service dependencies                                                         |

## Existing Documentation

These documents were already present in the `docs/` directory:

| Document                                       | Description                         |
| ---------------------------------------------- | ----------------------------------- |
| [architecture-flows.md](architecture-flows.md) | Architecture flow diagrams          |
| [aws-bootstrap.md](aws-bootstrap.md)           | AWS account bootstrapping guide     |
| [best-practices.md](best-practices.md)         | Best practices engine documentation |
| [commands.md](commands.md)                     | CLI command reference               |
| [configuration.md](configuration.md)           | Configuration system documentation  |
| [drift-detection.md](drift-detection.md)       | Drift detection and reconciliation  |
| [mcp-server.md](mcp-server.md)                 | MCP server documentation            |
| [quickstart.md](quickstart.md)                 | Quick start guide                   |
| [resource-types.md](resource-types.md)         | Supported resource types            |
| [testing-guide.md](testing-guide.md)           | Testing guide                       |

## Key Metrics (from code scan)

| Metric                         | Count             |
| ------------------------------ | ----------------- |
| Supported AWS resource types   | 23                |
| Compound architecture patterns | 7                 |
| LangGraph pipeline nodes       | 12                |
| CLI commands                   | 12                |
| MCP server tools               | 5                 |
| Resource plugins               | 24 (23 + generic) |
| Best practice YAML rules       | 136               |
| Pricing strategies             | 23                |
| Pricing decomposers            | 23                |
| Config precedence levels       | 6                 |
| LLM providers supported        | 5                 |
| IAM credential users           | 3                 |
| Business logic services        | 28                |
| Utility modules                | 30+               |
