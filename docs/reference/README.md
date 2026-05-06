# Reference

Information-oriented, precise, exhaustive. No narrative; no hand-holding.

Reference docs describe **what** the system does — every command, every
flag, every exit code, every config option — without explaining why or
how-to-use. A senior developer scanning for a flag name should find it
here in 30 seconds or less.

---

## What lives where

The auto-generated **per-resource pages** live here in `docs/reference/`
— one page per supported AWS resource type, regenerated from the
resource-type registry by `scripts/generate-reference-pages.ts`. Open
this directory's `*.md` files for the type-specific entry; see
[`../resource-types.md`](../resource-types.md) for the cross-type catalog.

The **canonical reference docs** live one level up at `docs/`:

- [`../commands.md`](../commands.md) — CLI command reference: every
  flag, option, and exit code.
- [`../configuration.md`](../configuration.md) — Environment variables,
  config files, `ASSIGNEE_*` namespace, and the precedence chain.
- [`../resource-types.md`](../resource-types.md) — Supported AWS
  resource types, non-taggable list, compound architecture patterns,
  and the CloudControl API fallback set.
- [`../mcp-servers.md`](../mcp-servers.md) — AWS MCP servers consumed
  by the pipeline (Pricing, Documentation, IAM, Security, Billing):
  endpoint pins, available tools, and configuration.
- [`../troubleshooting.md`](../troubleshooting.md) — Exit codes and
  error-class playbook.
- [`../best-practices.md`](../best-practices.md) — Best-practice rule
  engine and shipped rules.

These canonical docs deliberately stay at `docs/` root rather than
moving into `docs/reference/` so existing inbound links from external
sources remain stable.

The **architecture reference** at
[`../integration-architecture.md`](../integration-architecture.md)
documents how CLI, MCP server, and `@assignee/core` fit together. It
sits at `docs/` root for the same inbound-link reason.

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
