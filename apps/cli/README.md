# assignee (CLI)

The `assignee` binary — an AI-native cloud operator that plans and applies AWS infrastructure from natural-language intent.

## What this package is

This is the user-facing CLI of Assignee.ai. It wires a [LangGraph](https://github.com/langchain-ai/langgraphjs) pipeline to AWS SDK clients and to the [Assignee MCP server](../mcp-server/README.md), exposing the result as the `assignee` command.

## Architectural role

`apps/cli` is the composition root for the product:

- It owns user interaction (prompts, output rendering, exit codes).
- It depends on [`@assignee/core`](../../packages/core/README.md) for shared schemas, ports, and resource plugins, and on [`@assignee/best-practices`](../../packages/best-practices/README.md) for the BP rules library.
- It launches sub-MCP servers (Pricing, Documentation, IAM, Well-Architected Security, Cost Management) and translates their responses into provisioning plans. CloudFormation schemas are fetched directly via `@aws-sdk/client-cloudformation`.
- All business logic that needs to be shared with the MCP server lives in `@assignee/core` — never in this package.

## Commands

Registered in `src/index.ts` and implemented under `src/commands/`:

| Command                    | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `assignee init`            | First-run setup: config, credentials, auto-fix mode               |
| `assignee setup`           | Provision Assignee IAM users and policies in your AWS account     |
| `assignee plan`            | Plan resources from natural-language intent (writes a checkpoint) |
| `assignee apply`           | Apply a previously-planned checkpoint                             |
| `assignee destroy`         | Tear down resources created by Assignee                           |
| `assignee drift`           | Detect drift between checkpoint and live AWS state                |
| `assignee reconcile`       | Reconcile checkpoint after out-of-band changes                    |
| `assignee list` / `status` | Inspect tracked resources and recent runs                         |
| `assignee clean` / `cache` | Manage local state under `~/.assignee/`                           |
| `assignee completions`     | Print shell completion scripts (bash/zsh/fish)                    |
| `assignee version`         | Print version, Node version, and platform                         |

## Developing

From the repo root:

```bash
pnpm install
pnpm --filter assignee build      # tsc + generate completions
pnpm --filter assignee test       # vitest
pnpm --filter assignee test:e2e   # RUN_E2E=1 vitest src/e2e/e2e-plan.test.ts
```

The full CI gate is `pnpm build && pnpm test` from the repo root.

To run the locally-built binary:

```bash
node ./dist/index.js plan "an EC2 web server"
# or, after `pnpm link --global`
assignee plan "an EC2 web server"
```

## Where to read more

- [docs/quickstart.md](../../docs/quickstart.md) — install and first plan/apply
- [docs/commands.md](../../docs/commands.md) — full command reference
- [docs/configuration.md](../../docs/configuration.md) — `~/.assignee/config.yaml` schema and precedence
- [docs/architecture.md](../../docs/architecture.md) — pipeline, nodes, and node graph
- [docs/aws-bootstrap.md](../../docs/aws-bootstrap.md) — IAM setup performed by `assignee setup`
- [docs/best-practices.md](../../docs/best-practices.md) — how BP rules are evaluated against plans
- [docs/drift-detection.md](../../docs/drift-detection.md) — drift command internals
