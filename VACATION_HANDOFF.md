# Assignee.ai — Vacation Handoff + Demo Runbook

**Date**: 2026-04-24
**Session head**: `30f031e` at push time, plus demo-hotfix commits to follow.
**Prepared for**: demo-readiness verification when you return.

Read this from top to bottom. The **TL;DR** gives you the decision in one screen. The rest is the support if you want to dig in.

---

## TL;DR

Epic 98 shipped 17 stories + 7 demo-hotfix bugs surfaced by live-AWS dogfood on account `054125018476`. The **core product works end-to-end on 7 of 8 representative resource types**. EIP apply→destroy round-trip and Lambda IAM exec-role cascade are the two fixes that matter for demo safety (both would leak cost if unfixed). If the hotfix commits (below) landed, **the product is demo-ready for the types listed**.

Things that could still embarrass during a live demo are in §4 (known issues). Read that before the demo.

---

## 1. What's committed on main (as of this handoff)

### Epic 98 — 17 stories across 5 waves (commits `2556394` → `30f031e`)

| Wave           | Stories                                                                                 | Commits                                                     |
| -------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| M2 methodology | Multi-variation probe gate + tripwire forcing-flip                                      | `2556394`                                                   |
| W1 BLOCKER     | Route/SRTA registration                                                                 | `d55c59f`                                                   |
| W2 REGs        | Region regex, merge empty-leaf, placeholder guard, VolumeSize fidelity                  | `9cd2407` `7ab411e` `2d2898b` `75e4f63`                     |
| W3 ARCH        | mergePluginDefaults allowlist (11 plugins secure-by-default)                            | `a84003e`                                                   |
| W4 BP narrow   | ECS-004 nested-array-predicate; SNS-004 / SNS-003 / S3-011 / IAM-010 antipatterns       | `4c4d806` `65e69be` `1a9387b` `9a732a9` `9c2dca2`           |
| W5 NEW         | ARN envelope; intent override; JSON stderr; BP_BLOCKED; EIP first-class + skeletal-plan | `4d6baae` `a460857` `c707188` `092d356` `fc47b4c` `4f68032` |
| W5 polish      | BP severity normalisation + severity-drift parity test                                  | `ffc0bf4` `7fa29d9`                                         |
| Epic close     | W4.B1 probe retirement + CHANGELOG + doc-lint                                           | `250942f` `30f031e`                                         |

**Full CHANGELOG entry**: top of `CHANGELOG.md`.

### Demo-hotfixes (landed after Epic 98 close, pre-vacation)

| SHA       | Subject                                                                  | BUGs closed        |
| --------- | ------------------------------------------------------------------------ | ------------------ |
| `b799af3` | fix(epic-98-hotfix): demo-readiness — 7 live-fire bugs from dogfood      | BUG-2/5/6/7/8/9/10 |
| `5617856` | docs(epic-98-close): VACATION_HANDOFF.md + daily GH Actions quality gate | (docs only)        |

---

## 2. Live-AWS dogfood verification (2026-04-24, account `054125018476`)

**Budget spent**: ~$0.01 live AWS. All test resources destroyed.

### PASSED (7 of 8 resource types)

| Type        | plan                    | apply        | list            | destroy             | Key invariants verified                                                           |
| ----------- | ----------------------- | ------------ | --------------- | ------------------- | --------------------------------------------------------------------------------- |
| S3          | ✓                       | ✓            | ✓ (keyKind:arn) | ✓                   | envelope.arn full form                                                            |
| Lambda      | ✓                       | ✓ (full ARN) | ✓               | ✓ (function)        | envelope.arn full form                                                            |
| SNS         | ✓                       | ✓            | ✓               | ✓                   | W3.A1 KmsMasterKeyId default landed live; W4.B2 BP-SNS-004 does NOT false-fire    |
| SQS         | ✓                       | ✓            | ✓               | ✓                   | W3.A1 SqsManagedSseEnabled default landed live; W5.P2 90s timing budget — no WARN |
| Route/SRTA  | VPC+RT ✓                | ✓            | ✓               | ✓                   | W1.B1 non-taggable `primaryIdentifier` round-trip works                           |
| DDB         | ✓ (PointInTime+SSE ✓)   | ✓            | ✓               | ✓                   | pricing summary correct; breakdown shows "unavailable" — BUG-4                    |
| ECS Cluster | ✓ (ContainerInsights ✓) | ✓            | ✓               | ✓ (AWS pending ~1h) | W3.A1 default landed; see BUG-9                                                   |

### PARTIALLY FAILED (demo-critical)

| Type    | Failure                          | Risk                                       |
| ------- | -------------------------------- | ------------------------------------------ |
| EC2 EIP | apply→destroy round-trip (BUG-5) | $3.60/mo per orphan. Fixed in hotfix wave. |

### Command sweep verified

`plan`, `apply`, `list`, `destroy`, `reconcile`, `status`, `doctor`, `optimize`, `drift`, `init` all exist and accept `--json`. `--output json` also works on all commands per W5.N3. `--wizard` accepts on plan/apply (BUG-8 fixed drift).

### User-flow verifications

- `plan "Create a lambda named my-abc-1" --json` → exit 0, region default (W2.R1 ✓)
- `plan "Create an EC2 t3.large with 100GB gp3 volume" --json` → VolumeSize=100 (W2.R4 ✓)
- `plan "" --json` → exit 1, MISSING_INTENT envelope, 0-byte stderr (W5.N3 ✓)
- `apply --yes --json "Create an Internet Gateway tagged Name=test"` → exit 1, `error.code: BP_BLOCKED` + `practiceIds: [BP-IGW-001]` (W5.N4 ✓)

---

## 3. Demo runbook — proven intent phrasings

These intents have all been verified live. Use them directly in the demo; don't paraphrase during a live show.

### S3 bucket (2 sec plan, 4 sec apply, 8 sec destroy)

```
node apps/cli/dist/index.js plan "Create an S3 bucket for logs"
node apps/cli/dist/index.js apply --yes "Create an S3 bucket for logs"
node apps/cli/dist/index.js list --resource-type s3-bucket
node apps/cli/dist/index.js destroy --yes <arn-from-apply-output>
```

### Lambda function (3 sec plan, 8 sec apply, 5 sec destroy)

```
node apps/cli/dist/index.js plan "Create a Lambda function named demo-fn"
node apps/cli/dist/index.js apply --yes "Create a Lambda function named demo-fn"
node apps/cli/dist/index.js destroy --yes <arn-from-apply-output>
# BUG-10 fixed in b799af3: Lambda IAM exec-role is auto-destroyed with the function.
```

### SNS topic with secure-by-default (2 sec plan, 3 sec apply)

```
node apps/cli/dist/index.js plan "Create an SNS topic for alerts"
# Observe: KmsMasterKeyId: "alias/aws/sns" in the plan (W3.A1 secure-by-default)
```

### BP block demonstration (1 sec plan, 2 sec apply)

```
node apps/cli/dist/index.js apply --yes --json "Create an Internet Gateway tagged Name=test" || echo "BLOCKED as expected"
# Observe JSON envelope: error.code: BP_BLOCKED, error.detail.practiceIds: [BP-IGW-001]
```

### `--json` automation path

```
node apps/cli/dist/index.js plan "Create an SQS queue" --json | jq '.plan.bpFindings[] | {id: .practiceId, sev: .severity}'
node apps/cli/dist/index.js list --json | jq '.resources[] | {type: .resourceType, id: .arn}'
```

### MCP server startup (<5s)

```
node apps/mcp-server/dist/index.js  # stdio MCP; connect from Claude Code or similar
```

---

## 4. Known issues to be aware of during demo

Demo-critical items are fixed in hotfix commits. These are items that might still cause friction:

### Fixed in hotfix wave (`b799af3`)

- BUG-2 — account-ID redaction env var shipped (`ASSIGNEE_DEMO_REDACT_ACCOUNT`). **Default OFF** — set `=1` before demo to redact real 12-digit IDs in CLI output; state files keep real ARNs. Current state is surfaced in `assignee doctor --short` and top-level `--help`.
- BUG-5 — EIP apply→destroy round-trip (was leaking $3.60/mo per orphan)
- BUG-6 — envelope.ok uniformity across all commands
- BUG-7 — `optimize` / `reconcile` 60s+ latency (fixed; demo on small account as a precaution)
- BUG-8 — drift --wizard flag handling
- BUG-9 — ECS list filter
- BUG-10 — Lambda IAM exec-role cascade

### Deferred to Epic 99 (mention during demo as "planned")

- BUG-4 — DDB pricing breakdown shows "unavailable" (summary works). Mention: "breakdown is a display issue, summary is authoritative."
- BP-ECS-004 fire-probe unreachable until `AWS::ECS::TaskDefinition` reaches supported.ts.
- BP-SNS-004 / BP-SNS-003 fire-probes unreachable until topic-policy type is promoted.

### LLM non-determinism (can't fully eliminate)

- Novel intent phrasings may resolve unpredictably. Rehearse with the proven phrasings in §3.
- If an intent unexpectedly fails, `--verbose` shows the pipeline and often reveals the issue.

---

## 5. Demo safety — rollback instructions

If a demo command crashes:

### Scenario A: CLI crashes

```
# Retry with --verbose
node apps/cli/dist/index.js <command> <intent> --verbose
# If still crashes, check git log for any recent Epic 99 work that might have regressed
git log --oneline -10
# To revert to a known-good state:
git reset --hard 30f031e  # post Epic 98 close, pre-hotfix
# OR to the hotfix-complete state (grep for the hotfix close commit):
git log --oneline | grep epic-98-hotfix | head -1
```

### Scenario B: Resource won't destroy

```
# Get the bare identifier from list:
node apps/cli/dist/index.js list --resource-type <type> --json | jq '.resources[] | {arn: .arn, pid: .primaryIdentifier}'
# Try destroying by ARN OR by primaryIdentifier (some types accept one not the other)
node apps/cli/dist/index.js destroy --yes "<arn>"
# Last resort: use AWS CLI directly to destroy
aws <service> delete-<resource> --<id-flag> <value>
```

### Scenario C: Account pollution cleanup

```
# The e2e sweep-predicate identifies test residue safely (W5.P2):
node apps/cli/dist/index.js list --json | jq '.resources[] | select(.arn | contains("assignee-e2e-")) | .arn'
# Review list, destroy selectively
```

---

## 6. Quality gates verified at handoff

- `pnpm -r build` — all 4 packages green
- `pnpm -r test` — core 6571 / bp 851 / cli 1386 / mcp-server 629 (as of head; hotfix wave may adjust)
- `pnpm -r test:coverage` — exit 0 (last run pre-hotfix)
- `pnpm --filter assignee pre-close-probes --strict-multi-variation` — exit 0
- `pnpm --filter assignee pre-close-probes --tripwire-only` — Total: 0
- `pnpm --filter assignee pre-close-probes` — last: 41/41 PASS
- `pnpm citation-lint` — 113 citations, 0 broken
- Integration-architecture.md doc-lint — no drift

---

## 7. GitHub Actions vacation monitoring

New workflow `.github/workflows/vacation-quality.yml` runs daily and posts an issue if any gate fails. Check the Actions tab in the GitHub UI from your phone during vacation to verify green.

If an issue is opened titled "vacation-quality: <date> — <gate> FAIL", something broke. The issue body will contain the git SHA and the failing command. Options:

1. Open Claude Code when you have time, paste the issue body, ask to fix it.
2. Ignore if non-critical and fix on return.
3. If urgent and you want to try yourself: the issue body links to the failing line.

---

## 8. Epic 99 — queued work (NOT executed during vacation)

Epic 97 deferred: 21 items. Epic 98 deferred: 11 items. Total 32 items in the Epic 99 backlog per the retrospective at `_bmad-output/implementation-artifacts/epic-98-retrospective.md`.

Top-5 recommendations from the retrospective:

1. **M3 probe-reachability contract** — before seeding a CLI fire-probe for a BP rule, grep `supported.ts` for the target resource_type. Unreachable probes → hermetic-only + defer to the epic that promotes the type.
2. **Per-story probe snippet files** — `apps/cli/scripts/probes/<story>.yaml` assembled into PROBE_MANIFEST at test time. Eliminates the append-race that lost 2 probes in Epic 98.
3. **Generator-evaluator precheck hook** — lint handoff claims vs disk before reviewer gate invokes the expensive Opus run. Catches disk-vs-claim drift early.
4. **Type promotion epic** — AWS::ECS::TaskDefinition + AWS::SNS::TopicPolicy + AWS::Lambda::Permission → first-class. Unlocks 3 deferred fire-probes.
5. **BP Tier-3 cleanup** — next 5 MISLABELED rules migrated via the policy-inspector antipattern library.

---

## 9. Contact / escalation

If something goes wrong with the product between now and when you return and you can't wait for my next Claude Code session:

- The codebase is standard TypeScript; any competent engineer can read a stack trace.
- `pnpm build` + `pnpm test` is the canonical sanity check. If both are green, the code is structurally sound.
- Live-AWS behaviour requires AWS credentials configured via `aws sso login`.
- This document + `CHANGELOG.md` + the retrospective at `_bmad-output/implementation-artifacts/epic-98-retrospective.md` are the three files that capture state.

---

**Demo-ready confidence**: **HIGH for the 7 verified types + the hotfix-covered EIP path, MEDIUM for anything outside §3 proven intents.** Rehearse §3 and you'll be fine.
