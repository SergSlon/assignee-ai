# Reviewer: ACCEPT — qa (Quinn) — docs-readme-2026-05-16

**Commit (pre-amend)**: `d6965cb1` — docs(readme): restructure dev-first + reconcile node count to 15
**Base**: `a6b66db4` (origin/main)
**Story**: README dev-first restructure + node-count reconciliation (per docs-audit-2026-05-16)

## Scope

- `README.md` — restructured from 286 → 303 lines with dev-first ordering: install → quick start → commands → configuration → supported resources → compound patterns → troubleshooting → docs tree → architecture, then vision/market/business/roadmap pushed to bottom. Marketing prose and TAM/SAM/SOM table removed (they belong in the pitch deck, not the README).
- `CHANGELOG.md` — Unreleased entry recording the structural change + node-count reconciliation.

## Round 1 findings (closed in round 2 — commit `a6332cfc` then `d6965cb1` after amend)

- **F1 BLOCKER** — `pnpm --filter @assignee/cli link --global` would have failed (the CLI package name in `apps/cli/package.json` is `assignee`, not `@assignee/cli`). Replaced with `pnpm link --global` per `docs/how-to/quickstart.md:24-27`.
- **F2 HIGH** — `assignee types list` references removed (Story 50-3 removed those commands; discovery moved to `assignee plan --help` per `apps/cli/src/commands/plan/discovery.ts:4-6`).
- **F3 HIGH** — `optimize` command added to commands-at-a-glance table. Cross-check of `apps/cli/src/index.ts` registrations also caught missing `version` command — added.
- **F4 MED** — `pnpm setup` global-bin bootstrap step added before `pnpm link --global` per quickstart.md line 18.
- **F5 LOW** — CHANGELOG line-count claim corrected from "~150" to "~303" (measured via `wc -l`).

## Round 2 verdict (Opus reviewer)

ACCEPT — all 5 round-1 findings closed; 17/17 commands covered in the table; no regressions; `pnpm build` PASS, `pnpm citation-lint` PASS (101 files, 348 citations, 0 broken). Scope strictly 2 files.

## Source-of-truth anchors

- Node count: `packages/core/src/graph/create-graph.ts` — 15 `addNode(` calls (verified).
- Command list: `apps/cli/src/index.ts` — 17 `.command(...)` / `.addCommand(...)` registrations (verified).
- Install sequence: `docs/how-to/quickstart.md:11-30` (verbatim match).
- Compound patterns: `packages/core/src/pattern-templates/index.ts` — 13 registered (existing table accurate).
