# Reference

Information-oriented, precise, exhaustive. No narrative; no hand-holding.

Reference docs describe **what** the system does — every command, every
flag, every exit code, every config option — without explaining why or
how-to-use. A senior developer scanning for a flag name should find it
here in 30 seconds or less.

---

## Current reference docs

This quadrant is scaffolded as of Epic 99 Wave 3. The docs listed below
currently live at `docs/` root; they will be migrated here in a dedicated
Epic 100+ subwave with per-move citation-lint gates to avoid breaking
inbound links.

### Commands (pending move from `docs/` root)

- [`../commands.md`](../commands.md) — CLI command reference: `plan`,
  `apply`, `destroy`, `list`, `status`, `drift`, `reconcile`, `init`,
  `doctor`, `optimize`, `setup`, `completions`, `version`. Covers every
  flag, option, and exit code.

### Configuration (pending move from `docs/` root)

- [`../configuration.md`](../configuration.md) — Environment variables,
  config files, `ASSIGNEE_*` namespace, and the 6-level precedence chain.

### Resource types (pending move from `docs/` root)

- [`../resource-types.md`](../resource-types.md) — 38 first-class AWS
  resource types, non-taggable list, compound architecture patterns, and
  the CloudControl API fallback set.

### Architecture reference (pending move from `docs/` root)

- [`../integration-architecture.md`](../integration-architecture.md) —
  How CLI, MCP server, and `@assignee/core` fit together; doc-lint-guarded
  live counts.

### MCP servers (pending move from `docs/` root)

- [`../mcp-servers.md`](../mcp-servers.md) — AWS MCP servers consumed by
  the pipeline (Pricing, Documentation, IAM, Security, Billing): endpoint
  pins, available tools, and configuration.

### Exit codes / error envelopes (pending extraction)

_(Extract from `commands.md` §Exit codes into a dedicated file once
`commands.md` has moved here.)_

---

## When to write reference (vs. how-to or explanation)

| Situation                                            | Quadrant        |
| ---------------------------------------------------- | --------------- |
| Authoritative list of facts, no narrative            | **Reference**   |
| Recipe for a specific task, prescriptive progression | **How-to**      |
| WHY / architecture / design rationale                | **Explanation** |
| First-time walk-through, the learning is the goal    | **Tutorial**    |

Reference docs intentionally omit "you usually want to …" phrasing. If
a statement requires judgement or context, it belongs in explanation.

---

## Accuracy guarantees

Every claim in reference docs must be verifiable against the source:

- **Live counts** (types, rules, strategies) — drift-guarded by `pnpm doc-lint`.
- **File:line anchors** — checked by `pnpm citation-lint`.
- **Error-code shapes** — pinned by test assertions in
  `packages/core/src/errors/`.

A reference doc that silently drifts from the implementation is worse
than no doc. If you update behavior, update the reference doc in the
same commit.

---

## Further reading

| Quadrant    | Directory                            | Purpose                            |
| ----------- | ------------------------------------ | ---------------------------------- |
| Tutorials   | [`../tutorials/`](../tutorials/)     | Learning-oriented walk-throughs    |
| How-to      | [`../how-to/`](../how-to/)           | Task recipes for experienced users |
| Explanation | [`../explanation/`](../explanation/) | Architecture and design rationale  |
| Docs root   | [`../index.md`](../index.md)         | Full documentation map             |
