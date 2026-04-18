# Assignee.ai — agent entry point

TypeScript monorepo — AI-powered AWS infrastructure CLI. This file is a
signpost only; the canonical agent rulesets live elsewhere and must not
be duplicated here (they rot fast).

## Canonical rulesets

- `../CLAUDE.md` — detailed behavioral rules: BMAD workflow, parallel
  subagent rules (file ownership, e2e gating), verification rules.
- `../AGENTS.md` — workspace-level operating knowledge (wiki, skills,
  memory layout, directory conventions).
- `./docs/explanation/invariants.md` — non-obvious domain rules with
  file:line citations (partition-aware ARN handling, CCAPI NotFound
  short-circuit, IAM-role RGTA gap, safety allowlist, S3 state guard,
  pattern-registry case-folding, filter-dispatched pricing mocks).

## Full build

`pnpm build && pnpm test`

## Do not

- Do not flip `"private": true` → `false` on any package.
- Do not commit unless the operator explicitly asks.
- Do not lower any coverage floor without a documented mechanical
  baseline reason.

## When BMAD applies

See `../CLAUDE.md` § "BMAD Workflow Rules" for the development cycle,
sprint-management, research, and review skills. Do not re-list skills
here.
