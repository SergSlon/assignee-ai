<!--
Thanks for opening a PR. Fill in the relevant sections and delete the
ones that don't apply. Linked docs:
- Contribution conventions: CONTRIBUTING.md
- Security disclosure policy: SECURITY.md
- Repo rules for AI agents: CLAUDE.md
-->

## Type of change

<!-- Keep the ones that apply, delete the rest. -->

- [ ] Feature (new capability — user-visible)
- [ ] Fix (bug repair — user-visible)
- [ ] Refactor (internals only, no behaviour change)
- [ ] Docs (CONTRIBUTING / docs / inline)
- [ ] BP rule (new or modified rule under `packages/best-practices/`)
- [ ] Test (new or strengthened tests only)
- [ ] Chore (CI / lint / tooling)
- [ ] Breaking change (API / CLI flag / config shape)

## Summary

<!--
1-2 sentences: what changed and WHY. Link the driving story or issue
when available (e.g. "Story 50-10 — wires BP-validation into pnpm test").
-->

## Rule ID (BP-rule PRs only)

<!--
If this PR adds or modifies a best-practice rule, list the rule IDs and
point at the governing source (FSBP control, Well-Architected pillar,
internal runbook, …). Delete this section otherwise.

Example:
  - BP-EFS-010 — KMS at rest on AWS::EFS::FileSystem.
    Source: AWS Well-Architected Security Pillar § SEC 8.
-->

## Tests added

<!--
- Name the test file(s) you added or changed.
- Explain what edge cases / branches each test covers.
- If no tests were added, state why (docs-only, config, etc.).
-->

## Manual test steps

<!--
Exact commands a reviewer can run to verify the change locally.
Prefer the form:

1. `pnpm install`
2. `pnpm build`
3. `pnpm --filter @assignee/<pkg> test -- <selector>`
4. Observe: …

For user-facing CLI changes, include a terminal transcript showing
the before / after behaviour.
-->

## Cross-package impact

<!--
Assignee.ai ships two apps (CLI + MCP server) over two shared packages
(core + best-practices). A fix in one place often needs mirroring in
the other. Name every package you touched AND every package that
consumes the changed surface.

Example:
  - Edited: apps/cli/src/commands/destroy/action.ts
  - Mirrored in: apps/mcp-server/src/tools/destroy-resource.ts
  - Reviewed for drift: apps/cli/src/services/list-resources.ts
-->

## Breaking change

<!--
If "Breaking change" is checked above, describe:
- What breaks
- Who is affected
- Required migration / new invocation form

Delete this section otherwise.
-->

## Checklist

- [ ] `pnpm build` — exit 0
- [ ] `pnpm test` — exit 0 (full suite, not just selectors)
- [ ] `pnpm -r test:coverage` — exit 0 (CI parity gate)
- [ ] Docs updated (`docs/` + `CONTRIBUTING.md` where relevant)
- [ ] Manifest regenerated (BP-rule PRs only —
      `pnpm --filter=@assignee/best-practices run generate-manifest`)
- [ ] No secrets in the diff (check `.env`, credential blobs, ARNs with
      account IDs)
- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `docs:`, …)
