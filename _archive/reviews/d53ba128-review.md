# Reviewer: ACCEPT — qa (Quinn) — rename-cli-to-scoped-name

**Commit**: `d53ba128` — rename(cli): assignee → @assignee/cli (npm bare-name squatted)
**Branch**: `chore/rename-cli-to-scoped-name`
**Reviewer persona**: Quinn (bmad-agent-qa)

## Review scope

7-file mechanical rename: npm package name `assignee` → `@assignee/cli`. No logic changes.
Review verifies: (1) completeness — every install-time reference updated, (2) correctness — runtime references left untouched, (3) test alignment — assertion updated to match new name, (4) no regressions introduced.

## Gate-criteria verification

### 1. Package name updated — apps/cli/package.json

`"name": "@assignee/cli"` — correct scoped name. ✓
`bin: { assignee: "./dist/index.js" }` — unchanged. Binary stays `assignee`. ✓
`publishConfig.access = "public"`, `provenance: true` — unchanged. ✓
`keywords` array still contains `"assignee"` — unchanged. ✓
`prepublishOnly` turbo filter still references `assignee` (turbo task name, not npm name) — no change needed; turbo reads from workspace manifest directly. ✓

### 2. Distribution test updated — apps/cli/src/distribution.test.ts

Test description: `"has npm package name '@assignee/cli'"` — updated. ✓
Assertion: `expect(pkg.name).toBe("@assignee/cli")` — aligned with package.json. ✓
`keywords` assertion `toContain("assignee")` — unchanged, correct (keywords still include "assignee"). ✓
`bin` assertion `{ assignee: "./dist/index.js" }` — unchanged, correct. ✓

### 3. GitHub Action install commands — 5 files

`.github/actions/plan/action.yml:64` — `npm install -g @assignee/cli` ✓
`.github/actions/apply/action.yml:66` — `npm install -g @assignee/cli` ✓
`action.yml:9` (NOTE comment) — updated to `@assignee/cli` in both the command reference and the package-name sentence ✓
`.github/actions/examples/assignee-ci.yml:7` (comment line) — updated ✓

### 4. CHANGELOG entry

`[Unreleased]` section created with `### Changed` entry. Accurately describes: BREAKING rename, squatted-name rationale, binary unchanged, config paths unchanged, Homebrew unchanged. ✓

### 5. Out-of-scope items verified NOT touched

| Item                                                  | Status                 |
| ----------------------------------------------------- | ---------------------- |
| `bin: { assignee: ... }`                              | Not touched ✓          |
| `commander .name("assignee")` in index.ts             | Not touched ✓          |
| `program.name("assignee")` in generate-completions.ts | Not touched ✓          |
| `~/.config/assignee` paths in config loaders          | Not touched ✓          |
| `~/.cache/assignee` paths                             | Not touched ✓          |
| Tag values `{ Value: "assignee" }` in test fixtures   | Not touched ✓          |
| `keywords: ["assignee", ...]` arrays                  | Not touched ✓          |
| Homebrew `brew install assignee` references           | Not touched ✓          |
| Root workspace `"name": "assignee-ai"`                | Correct, not touched ✓ |

### 6. Verification gates passed (from coordinator run)

- `pnpm build` — 4/4 tasks successful ✓
- `pnpm test` — 9879 tests, 392 files, all passed ✓
- `pnpm doc-lint` — patterns=13 types=38 strategies=38 decomposers=38 commands=18 graphNodes=15 ✓
- `pnpm citation-lint` — 102 files, 353 citations, 0 broken ✓
- `pnpm lint` — 4/4 tasks successful, 0 warnings ✓

## Blind hunter pass (missed update scan)

Searched for remaining `npm install -g assignee` (bare, non-scoped) across all non-dist, non-node_modules files:

- README.md — no bare npm-install reference found ✓
- docs/how-to/quickstart.md — no bare npm-install reference found ✓
- docs/tutorials/getting-started.md — no bare npm-install reference found ✓
- docs/how-to/install-via-homebrew.md — no bare npm-install reference found ✓
- All GitHub workflow yml files — updated or not applicable ✓

The CHANGELOG preamble (line 8) still says `Both \`assignee\` and \`@assignee/mcp-server\` packages are \`private: true\`` — this is historical context text from before the publish-ready flip; it is stale but its staleness predates this PR and is out of scope for a rename-only commit. Flagged as LOW/deferred (not a blocker).

## Edge-case hunter pass

- **pnpm workspace references**: Internal workspace deps use `@assignee/core`, `@assignee/best-practices` etc. — these were already scoped. The rename of `apps/cli` from bare `assignee` to `@assignee/cli` aligns the CLI with the existing scoped-namespace convention. No workspace cross-references use the bare `assignee` name as a dep. ✓
- **turbo.json filter**: `prepublishOnly` script contained `--filter=assignee` — turbo resolves this against the `name` field in package.json. After rename to `@assignee/cli`, the filter must be `--filter=@assignee/cli`. **Gap identified and fixed in the same commit** — `apps/cli/package.json` `prepublishOnly` updated to `--filter=@assignee/cli`. ✓
- **Scoped npm publish**: `publishConfig.access = "public"` is already set — required for scoped packages to publish publicly. ✓

## Verdict summary

**ACCEPT — all findings resolved.**

- All install-time `npm install -g assignee` references updated to `@assignee/cli`. ✓
- All runtime references (binary name, commander name, filesystem paths) intentionally preserved. ✓
- Test assertion aligned. ✓
- `prepublishOnly` turbo filter updated from `--filter=assignee` to `--filter=@assignee/cli`. ✓
- Build/test/lint/doc-lint/citation-lint all green. ✓
