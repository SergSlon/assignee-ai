# Owner dogfood notes — Session N+1, 2026-04-10

> Stopwatch-timed `init → plan → apply → destroy` against live AWS
> (account 054125018476, us-east-1). Two passes: single-resource
> (S3 bucket) and compound (lambda-with-exec-role). Non-TTY mode
> (`--yes`, `--no-advice` flags) to simulate CI-adjacent usage.
>
> This is the Item 2a artifact from the session brief.

## Environment

- **CLI version**: 0.1.0 (HEAD `534f0c2`)
- **Node**: v22.13.0
- **Bedrock model**: us.amazon.nova-lite-v1:0
- **Test dir**: `/tmp/assignee-dogfood-1775812046` (fresh `.assignee/config.yaml`)
- **Credentials**: ASSIGNEE*OPERATOR*\* env vars (dedicated IAM user)

## Pass 1: Single-resource S3 bucket

| Step    | Duration | Outcome             | Notes                                                                                                                                      |
| ------- | -------: | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| init    |      n/a | Simulated (non-TTY) | Config created manually; init is TTY-only — see observation #1                                                                             |
| plan    | 10,138ms | SUCCESS             | 2 auto-fixes applied (BP-S3-008 OwnershipControls, BP-S3-009 EventBridge). 3 HIGH + 5 MEDIUM findings displayed. Plan saved to checkpoint. |
| apply   | 24,432ms | SUCCESS             | `arn:aws:s3:::dogfood-test-1775812144` created via CCAPI                                                                                   |
| destroy |  4,643ms | SUCCESS             | Savings estimate shown: `$0.0230/GB-mo saved`                                                                                              |

**Total single-resource cycle: ~39s wall time.**

## Pass 2: Compound lambda-with-exec-role

| Step          | Duration | Outcome | Notes                                                                                           |
| ------------- | -------: | ------- | ----------------------------------------------------------------------------------------------- |
| apply         | 30,466ms | SUCCESS | 2 resources: IAM Role + Lambda Function. Compound ordering correct (role first, then function). |
| destroy --all | 19,691ms | SUCCESS | 2 destroyed, 0 failed. Lambda deleted before IAM role (tier ordering respected).                |
| list (leak)   |      ~3s | CLEAN   | Only 4 protected infra resources remain. Zero orphans.                                          |

**Total compound cycle: ~50s wall time.**

## Observations

### 1. `init` is TTY-only — non-TTY first-run experience is a gap

`assignee init` uses clack interactive prompts that don't work when
stdin is piped. A CI-first or docker-first user who runs `assignee init`
in a non-TTY context gets a clack error, not a helpful message.

**Severity**: LOW for now (the config file is YAML and can be created
manually), but worth a `--non-interactive` flag or a
`assignee init --region us-east-1 --auto-fix apply` one-liner in
a future sprint.

**Filed as**: observation, not blocker. Does NOT block beta.

### 2. Plan duration (~10s) exceeds the NFR-05 budget headline

The NFR-05 "plan within 3s" refers to the CLI cold-start overhead,
not the end-to-end wall time including Bedrock inference + MCP server
spawn. The ~10s includes:

- MCP server cold start (3 uvx processes): ~4s
- Bedrock inference (nova-lite): ~3s
- Schema fetch + BP evaluation: ~1s
- Checkpoint write: ~0.5s

The `time-budget.ts` instrumentation correctly breaks this into
phases and only fires a WARNING when the pre-inference overhead
exceeds budget. No false WARNING was observed during this run.

**Verdict**: working as designed.

### 3. BP auto-fix transparency worked as intended (Item 4a)

The plan output showed:

```
Auto-fixed:      2 fixes applied
  ✓ OwnershipControls.Rules: unset → [...] (BP-S3-008: ...)
  ✓ NotificationConfiguration...: unset → enabled (BP-S3-009: ...)
```

The BP rule ID + field path are visible per Item 4a. A user who
wanted to understand _why_ the plan has OwnershipControls set to
BucketOwnerEnforced can grep for BP-S3-008 in the docs.

**Hint helped?** YES — the rule-ID-in-output is the right level
of detail for a non-beginner user. A true beginner might want a
"learn more" URL, but that's deferred scope.

### 4. Destroy cost-savings estimate is a nice touch

`Estimated savings: $0.0230/GB-mo saved` after destroy is a
positive UX signal. Users know the cleanup had financial impact.

### 5. Compound apply progress is clear

```
Provisioning resource 1 of 2 (Lambda Execution Role)......
Provisioning resource 2 of 2 (Lambda Function)......
```

The N-of-M progress + human-readable display name is exactly right
for a 2-resource compound. For the 17-resource VPC compound, the
progress would be longer but still linear and predictable.

### 6. Zero orphan bugs found

The leak-check `assignee list` after bulk destroy showed only the
4 protected infra resources. No stranded dogfood resources.

**NFR impact on Quinn's falsification clause**: zero orphan bugs
found in practice → the cleanup matrix expansion to the remaining
7 compounds can stay deferred per the falsification clause. The
VPC reference matrix + this clean dogfood run together satisfy
the "demonstrated" evidence threshold for S-3.4.

### 7. BP unsigned manifest warning is noisy

```
⚠  BP manifest is unsigned — accepting on trust.
Set ASSIGNEE_BP_REQUIRE_SIGNATURE=1 to require a valid GPG signature.
```

This appears on every plan/apply. For a pre-release tool without
a signing key, it's expected but noisy. Should be silenced in dev
mode or downgraded to `--verbose`-only once signing is set up for
release.

**Severity**: LOW cosmetic. Not a blocker.

## Summary

| Metric                       | Value                                           |
| ---------------------------- | ----------------------------------------------- |
| Total commands tested        | 5 (init\*, plan, apply, destroy, destroy --all) |
| Errors or surprises          | 0                                               |
| Orphaned resources           | 0                                               |
| BP auto-fix transparency     | Working                                         |
| Compound ordering            | Correct                                         |
| Hint/error rewrite (Item 4b) | Not exercised in happy-path (no errors hit)     |
| First-run-experience gaps    | init TTY-only (#1), BP unsigned warning (#7)    |

\*init was simulated (config created manually) because clack prompts
require TTY stdin.

**Verdict**: happy-path is clean. No blockers found. The tool is
ready for owner daily-driver use. Private beta deferred per owner
decision (Item 0 answered as N for this sprint).
