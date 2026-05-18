---
diataxis: reference
canonical: true
---

> **Diátaxis: Reference** — This is the canonical root page for this topic. Exit codes and error-class playbook for diagnosing and fixing assignee.ai failures.

# Troubleshooting

How to read assignee.ai failures and fix them fast. Organized by exit
code, then by error class. If your symptom is here, the cited fix is
the canonical one — the CLI's `howToFix` hint mirrors this page.

## Contents

Jump to the section for the failure mode you're seeing.

- [Exit codes](#exit-codes) — the contract
- [Exit 12 — not implemented](#exit-12--not-implemented)
- [Exit 1 — generic failure (and the drift exception)](#exit-1--generic-failure-and-the-drift-exception)
- [Exit 10 — policy / safety aborts](#exit-10--policy--safety-aborts)
- [AWS / CloudControl error classes](#aws--cloudcontrol-error-classes) — covers throttling, expired credentials, IAM-list gap (these surface as exit 1)
- [Bedrock / LLM error classes](#bedrock--llm-error-classes) — region availability, model EOL (typically exit 1)
- [MCP server error classes](#mcp-server-error-classes) — exit 11 startup failures, CFN MCP unavailability
- [Checkpoint error classes](#checkpoint-error-classes) — checkpoint not found / expired (exit 1)
- [Audit log error classes](#audit-log-error-classes) — chain broken, append failures, CI lint
- [Destroy registry recovery](#destroy-registry-recovery) — restore-provisions
- [Getting more detail](#getting-more-detail) — debug flags and bug-report blob

---

## Exit codes

The CLI follows a stable exit-code contract — scripts can branch on it.

| Code  | Meaning                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Success — plan/apply/destroy completed; drift reported no changes                                                                                                                           |
| `1`   | Generic failure — unclassified error; rerun with `ASSIGNEE_LOG_LEVEL=debug`                                                                                                                 |
| `2`   | `assignee admin doctor` warnings-only — no hard failures, but at least one check returned `!` (e.g. optional role credentials not set, stale checkpoints); non-blocking but worth reviewing |
| `10`  | Policy / safety abort — state guard, preflight rejection, typed-confirm mismatch, IAM safety allowlist, drift threshold, best-practice block                                                |
| `11`  | MCP server startup failure — the spawned MCP server (cfn-mcp, aws-pricing, etc.) failed to start; check pin freshness and Python/uv install                                                 |
| `12`  | Not implemented — feature is recognised but not yet wired (e.g. `--target-account` cross-account provisioning); upgrade to a newer release or omit the flag                                 |
| `73`  | Usage error — invalid CLI flags / arguments (e.g. unrecognised option, mutually exclusive flags). Surfaces as `USAGE_ERROR` from `packages/core/src/constants/errors.ts:27`                 |
| `130` | Interrupted via `SIGINT` (Ctrl-C)                                                                                                                                                           |
| `143` | Terminated via `SIGTERM`                                                                                                                                                                    |

Any other non-zero code is a Node-level crash — capture the stderr JSON
log lines (`error` / `warn` events persist under `~/.assignee/logs/`)
when filing a bug.

---

## Exit 12 — not implemented

**Symptom.** `assignee infra plan --target-account <ID>` (or `apply` / `destroy`
with the same flag) exits immediately with code 12 and prints to stderr:

```
[plan] cross-account assume-role not yet implemented for <ID>
```

(Replace `[plan]` with `[apply]` or `[destroy]` for those commands.)

**Cause.** The `--target-account` flag is accepted by the CLI to reserve
the interface, but the cross-account assume-role wiring is not yet
implemented.

**Fix.** Omit `--target-account` and ensure your operator credentials
already target the intended account. Track the issue in the project
backlog for a status update on cross-account support.

---

## Exit 1 — generic failure (and the drift exception)

### Symptom: `assignee infra drift` exits 1

**Cause.** This is **not a bug.** `assignee infra drift` returns exit 1 when
it finds at least one managed resource whose live state has diverged
from the Assignee-managed state — i.e. drift was **detected**. Finding
drift is the designed outcome of the command, not an error. The
exit-code contract reuses `1` for this signal rather than introducing a
new code, so that scripts can keep the existing `0 = clean / 1 =
attention-needed` pattern.

**How to branch in CI/CD.** Treat drift as a first-class signal, not a
failure:

```bash
assignee infra drift
case $? in
  0)  echo "clean — no drift" ;;
  1)  echo "drift detected — review the drift table and decide" ;;
  10) echo "policy/safety abort — see exit 10 section below" ;;
  *)  echo "genuine failure — capture logs and file a bug" ;;
esac
```

If you only want the "something actually broke" codes, branch on
`>= 2 && != 1` — or prefer `assignee infra drift --json` and parse the
structured output for a deterministic view of which resources drifted.

**Fix.** Inspect the drift report (`--detailed` shows all fields, not
just diverging ones), then either (a) `assignee infra apply` to reconcile
live → desired, (b) update your intent so desired matches the new
reality, or (c) mark the drift as accepted in state. Exit 1 from
`drift` will persist until the divergence is resolved.

---

## Exit 10 — policy / safety aborts

### Symptom: `Type '<name>' to confirm destruction` → exit 10

**Cause.** Single-resource `destroy` requires the operator to re-type the
target's identifier (the short name, not "yes"). If the typed token does
not match — case-insensitively, after trimming whitespace and trailing
slashes — the command aborts without touching AWS.

**Fix.** Paste the exact identifier from the preview box. Copy-pasting
with trailing newline is fine; internal spaces are preserved.

### Symptom: `Placeholder ARN rejected by preflight`

**Cause.** Assignee's preflight guard rejects ARNs that look like LLM
hallucinations — the canonical pattern is `arn:aws:iam::123456789012:…`
(twelve "123…012" digits). This is not a real account; the LLM produced
it instead of asking the operator.

**Fix.** Edit your intent to pass a concrete ARN (run `assignee admin doctor --short`
for your real account ID) or let the wizard prompt for it. See
[invariants.md](explanation/invariants.md#placeholder-arn-preflight)
for the enforcing code path.

### Symptom: `State guard: resource already exists` on apply

**Cause.** CloudControl `GetResource` reports the target identifier
already exists in your account. Assignee refuses to overwrite it
rather than silently drift.

**Fix.** Pick a different identifier in your intent, import the
existing resource (`assignee infra drift <arn> --baseline`), or delete the
conflict first. S3 buckets are exempt from this guard because
`GetResource` returns false positives on globally unique names — see
[invariants.md](explanation/invariants.md#s3-state-guard).

---

## AWS / CloudControl error classes

### CCAPI `NotFound` during destroy

**Symptom.** `DeleteResource` responds with `ResourceNotFoundException`
or the status poll returns `FAILED` + `ErrorCode=NotFound`.

**Cause.** The resource was already deleted (e.g. out-of-band, or a
previous partial destroy succeeded). AWS also caches tag-API responses
for roughly one hour after a delete, so follow-up listings may still
see the ghost.

**Fix.** Assignee treats both forms of `NotFound` as destroy success
and continues. If you want confirmation, run `aws cloudcontrol
get-resource --type-name <T> --identifier <id>` — it should 404 too.

### Tag-API cache (stale entries up to ~1h)

**Symptom.** `assignee admin list` keeps showing a resource you just
destroyed. `assignee infra destroy <id>` reports NotFound immediately.

**Cause.** AWS Resource Groups Tagging API caches delete-visibility for
up to an hour. This is a documented AWS behavior, not a bug in
assignee.

**Fix.** Wait, or verify directly via the native service API
(`aws s3 ls`, `aws ec2 describe-instances`, etc.). Assignee logs a
`list_stale_entry` warning when it detects this.

### IAM roles missing from `list`

**Symptom.** Operator-created IAM roles with the `ManagedBy:assignee`
tag do not appear in `assignee admin list`.

**Cause.** AWS Resource Groups Tagging API does **not** return IAM
roles — the service is silently excluded. Assignee works around this
by enumerating roles via `iam:ListRoles` + `iam:ListRoleTags` on a
parallel listing path.

**Fix.** Grant the operator role `iam:ListRoles` and
`iam:ListRoleTags`. If permissions are correct, roles will appear.
See [invariants.md](explanation/invariants.md#iam-role-rgta-gap).

### `AccessDenied` / `UnauthorizedOperation`

**Symptom.** A plan succeeds but apply emits
`User: arn:aws:iam::…:user/AssigneeOperator is not authorized to
perform: <action>`.

**Cause.** The operator IAM policy is out of date relative to the
resource types in your plan.

**Fix.** Run `assignee dev setup --profile admin` to refresh the three
managed operator policies (they are versioned — setup is idempotent).
If you use a custom operator role, widen its policy to include the
action named in the error.

### Expired / invalid credentials

**Symptom.** `ExpiredToken`, `InvalidClientTokenId`, or
`SignatureDoesNotMatch` during plan or apply.

**Cause.** SSO session expired, access key rotated, or system clock
skew.

**Fix.** For SSO, `aws sso login --profile <p>` then retry. For static
keys, rotate via `assignee dev setup --profile admin`. For clock skew,
sync your system clock.

### `STALE_SESSION_TOKEN` — expired or mismatched session token

**Symptom.** Any AWS call fails with `The security token included in the
request is invalid`, `InvalidClientTokenId`, or `ExpiredToken`, and
`ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY`
are present in the environment. The error code surfaced by the CLI hint
registry is `STALE_SESSION_TOKEN` (defined in
`packages/core/src/constants/errors.ts`).

**Cause.** The operator credentials are not missing — they are stale.
The paired `ASSIGNEE_OPERATOR_SESSION_TOKEN` was issued in a previous
SSO or STS session and has since expired, or it belongs to a different
AKID than the one currently set. AWS rejects the request because the
AKID + SECRET + SESSION_TOKEN tuple does not form a valid session.

**Fix (pick one):**

1. **Re-run `assignee dev setup`** — rotates the long-lived IAM access key
   and drops any stale `*_SESSION_TOKEN` from your `.env` (behavior
   added per the env-writer fix on 2026-05-05).
2. **SSO session**: `aws sso login --profile <name>` then re-export
   credentials with `aws configure export-credentials`.
3. **Manual**: delete `ASSIGNEE_OPERATOR_SESSION_TOKEN` (and the
   `READER` / `AUDITOR` variants) from your `.env` if you are using
   long-lived IAM keys without STS. Session tokens are only needed with
   `sts:GetSessionToken` temporary credentials.

This is distinct from `InvalidSessionTokenError` (below), which is
triggered by a token that is syntactically too short (< 100 characters)
rather than an expired-but-valid-length token.

### `InvalidSessionTokenError` — malformed session token

**Symptom.** `session token expired or invalid; run \`aws sso login\` if
using SSO` at startup, before any AWS call.

**Cause.** `ASSIGNEE_OPERATOR_SESSION_TOKEN` is set but has fewer than
100 characters — this is the minimum length validation that catches
truncated or placeholder values.

**Fix.** Either clear `ASSIGNEE_OPERATOR_SESSION_TOKEN` (if you are not
using temporary STS credentials) or re-export the full token value from
`aws sts get-session-token` / `aws sso login --profile <name>`.

### SSO session expired mid-run

**Symptom.** `Session expired. Run: aws sso login --profile <name>`
appears mid-plan or mid-apply, replacing an opaque `AccessDenied` stack
trace.

**Cause.** The SSO token cached on disk expired. The CLI detects the
Cognito expiry signal and surfaces an actionable message with the profile
name rather than a raw API error.

**Fix.** Run `aws sso login --profile <name>` (the profile name is
printed in the error message), then retry the failed command. If you are
not using named profiles, `aws sso login` without `--profile` refreshes
the default profile.

### Throttling / `RequestLimitExceeded` / 503 errors

**Symptom.** Random `RateExceeded`, `ThrottlingException`, or HTTP 503
responses mid-apply or during status polling.

**Cause.** Account-level CCAPI request quota or transient service
unavailability.

**Fix.** Assignee's status poller uses exponential backoff with jitter
(up to 5 retries, capped at 60 s per attempt) — a single 503 will not
cause a hard failure. If throttling is chronic or retries exhaust,
request a CloudControl quota increase in the Service Quotas console.

---

## Bedrock / LLM error classes

### Bedrock region error hints

**Symptom.** `Bedrock is not available in region <R>` or
`ValidationException: model <M> not enabled`.

**Cause.** The Bedrock control plane is region-scoped AND model access
is opt-in per region. Your `AWS_REGION` likely has no enabled models.

**Fix.** `LlmAdapter` wraps these with an actionable hint naming the
current `AWS_REGION` and suggesting a region where Bedrock is available.
Either switch regions (`export AWS_REGION=us-east-1`) or enable the
model in the AWS console > Bedrock > Model access.

Known regions with Bedrock availability include `us-east-1`, `us-west-2`,
`eu-west-1`, `eu-west-2`, `eu-north-1`, `ap-northeast-1`, and others.
EU operators: `eu-west-2` (London) and `eu-north-1` (Stockholm) were
added to the supported list — verify your region is in
`KNOWN_BEDROCK_REGIONS` if the hint does not name it.

### Bedrock model end-of-life

**Symptom.** `assignee admin doctor` Bedrock section shows:
`[!] Model <id> is in LEGACY lifecycle status` with an optional
end-of-life date.

**Cause.** The configured Bedrock model (`ASSIGNEE_LLM_DEFAULT`) has
entered AWS `LEGACY` lifecycle status. Models in LEGACY status continue
to work until the end-of-life date, but AWS recommends migrating before
that deadline to avoid a hard failure on EOL day.

**Fix.** Update `ASSIGNEE_LLM_DEFAULT` to an active successor model:

```
export ASSIGNEE_LLM_DEFAULT=bedrock/amazon.nova-lite-v1:0
```

Confirm the new model is ACTIVE by re-running `assignee admin doctor` — the
`Model lifecycle` sub-check should show `ok (ACTIVE)`.

**Detection.** `assignee admin doctor` calls `bedrock:GetFoundationModel` on
startup and surfaces the lifecycle warning proactively, before the model
actually stops responding. If the SDK call fails (permissions, region,
etc.) the sub-check is silently skipped — it will not surface a false
failure.

### LLM returned invalid JSON

**Symptom.** `Plan generator returned invalid JSON` once, disappears
on retry.

**Cause.** Transient model glitch — assignee filters these out of the
user-facing failure surface by design, but a hard failure gets
through if retries exhaust.

**Fix.** Retry once. If it persists on the same intent, rephrase the
intent (usually means the intent is ambiguous, not that Bedrock is
broken).

---

## MCP server error classes

### MCP server failed to start

**Symptom.** `MCP_STARTUP_FAILED: aws-pricing` or similar.

**Cause.** The pinned MCP server binary could not be spawned. Usually
missing `uvx` / `npx` / the process ran out of memory.

**Fix.** `assignee admin doctor --skip-bedrock` to isolate; install the
missing runtime; check `~/.assignee/logs/` for the child stderr.

### `CloudFormation DescribeType failed`

**Symptom.** `CFN_MCP_UNAVAILABLE` at plan time.

**Cause.** The operator credentials lack
`cloudformation:DescribeType`, or the region has no CFN endpoint.

**Fix.** Add `cloudformation:DescribeType` to the operator policy. The
action is free and idempotent. See `setup.ts` for the canonical policy
template.

### `DESTROY_TOCTOU_TAG_MISSING` security warning

**Symptom.** The `destroy_resource` MCP tool returned an error with
`code: "DESTROY_TOCTOU_TAG_MISSING"` and an accompanying stderr line
of the form:

```
[destroy_resource][SECURITY] toctou-tag-missing arn=<arn> firstVerify=managed secondVerify=unmanaged accountMatch=<bool> elapsedMs=<n>
```

**Cause.** The `managed-by=assignee-ai` tag was present when the
resource was resolved but **gone** by the time the pre-delete
re-verify ran. An external principal holding `tag:UntagResources` (but
not `cloudcontrol:DeleteResource`) stripped the tag mid-flight to
trick the operator into deleting an unmanaged resource. The delete
was **refused** — the resource was NOT deleted. See
[invariants.md `Destroy TOCTOU window`](explanation/invariants.md#destroy-toctou-window)
for the enforcement detail.

**Fix (operator action).** Investigate immediately. The SOC should:

1. Grep MCP server logs for `[SECURITY] toctou-tag-missing` to recover
   the affected ARN and the `elapsedMs` window.
2. Run the following CloudTrail Lake query (or the Athena equivalent
   against the CUR-partitioned CloudTrail export) against the tight
   time window `[eventTime - elapsedMs - 60s, eventTime]`:

   ```sql
   SELECT eventTime, userIdentity.arn, requestParameters
   FROM cloudtrail_logs
   WHERE eventName IN ('UntagResources', 'RemoveTagsFromResource', 'UntagRole', 'UntagUser', 'DeleteTags')
     AND eventTime BETWEEN <T_minus_5min> AND <T_now>
     AND requestParameters LIKE '%managed-by%assignee-ai%'
     AND recipientAccountId = '<operator-account>'
   ORDER BY eventTime DESC;
   ```

   Join the returned `userIdentity.arn` values against MCP server logs
   grepped for `[SECURITY] toctou-tag-missing` to identify the
   attacking principal.

3. Audit IAM policies for any principal granted
   `tag:UntagResources` / `iam:UntagRole` / `iam:UntagUser` on
   resources tagged `managed-by=assignee-ai`. Revoke or scope down.
4. No action is needed on the resource itself — the destroy was
   refused and the resource (including its original tags if the tag
   was re-applied) is intact.

---

## Checkpoint error classes

### `Checkpoint not found` / `Checkpoint expired`

**Symptom.** `assignee infra apply --checkpoint …` errors before any AWS
call.

**Cause.** Checkpoints have a TTL so apply can't ship a stale plan
from last week. Expired checkpoints are rejected at load time.

**Fix.** Re-run `assignee infra plan` to mint a fresh checkpoint, then
apply. Checkpoints live under `.assignee/checkpoint-<runId>.json`.

---

## Audit log error classes

### Audit log chain broken

**Symptom.** `assignee admin audit-verify` reports:
`Chain broken at index <N>: <reason>` — records around that index are
suspect.

**Cause.** The append-only audit log stores a hash chain across records.
A broken chain means at least one record was altered, deleted, or the
log file was truncated after the fact. This is a security-relevant
signal.

**Fix.** Examine the records around the reported index in
`~/.assignee/audit/audit.log` (single canonical file — no `.jsonl` glob,
no rotation suffix). Determine whether the break was caused by a crash
(partial write) or by external modification. If external, treat as a
potential security incident and review CloudTrail for activity in the
corresponding time window.

### `audit-no-suppress` CI lint failure

**Symptom.** CI fails with:
`audit-no-suppress: '|| true' masking found on assignee invocation line`
in `.github/actions/*/action.yml`.

**Cause.** A `|| true` suffix on an `assignee` CLI invocation silently
swallows non-zero exit codes, defeating the audit trail. This is a CI
blocker enforced by the lint rule.

**Fix.** Remove `|| true` from the offending line. If the command is
expected to fail under some conditions, branch explicitly on the exit
code (see the drift exit-code example in the "Exit 1" section above).

### MCP audit log append failure

**Symptom.** MCP server logs contain lines of the form:
`{"action":"append-failed","source":"audit-log",...}` (emitted via
`mcpLogError`).

**Cause.** The MCP server could not append to the audit log — typically
a permissions issue or a full disk on `~/.assignee/audit/`.

**Fix.** Check disk space (`df -h ~/.assignee`) and permissions
(`ls -la ~/.assignee/audit/`). The audit log lives in a single file at
`~/.assignee/audit/audit.log`. The MCP server continues operating after
an append failure, but the affected operation will not appear in
`assignee admin audit-verify` output.

---

## Destroy registry recovery

### Restoring from local backup

If the provision registry (`~/.assignee/memory/provisions.json`) is
corrupted or accidentally deleted, restore it from the last snapshot
under `~/.assignee/backups/`:

```bash
# Restore from the most recent backup file in ~/.assignee/backups/
assignee infra restore-provisions

# Restore from a specific dated backup (e.g. ~/.assignee/backups/provisions-2026-04-01.json)
assignee infra restore-provisions --from 2026-04-01
```

The command uses overwrite-with-safety-copy semantics: the existing
`~/.assignee/memory/provisions.json` is moved aside as
`provisions.json.bak-<timestamp>` before the chosen backup file
replaces it. After restoration, run `assignee infra drift` to verify the
restored baseline is consistent with live state.

---

## Getting more detail

- `ASSIGNEE_LOG_LEVEL=debug` — verbose JSON logs to stderr.
- `~/.assignee/logs/cli-YYYY-MM-DD.jsonl` — persistent warn/error log,
  retained for `ASSIGNEE_LOG_RETENTION_DAYS` (default 14).
- `assignee dev version --json` — compact self-describe blob (CLI version,
  Node version, platform, arch, AWS region, audit-key source) — paste
  this into any bug report to provide full environment context.
- `assignee admin doctor --json` — structured snapshot suitable for bug
  reports.
- `assignee admin doctor --short` — resolved account/region/profile before any
  mutation.

If the failure is not covered above, file an issue at
https://github.com/SergSlon/assignee-ai/issues with the relevant
`~/.assignee/logs/…jsonl` excerpt redacted of account IDs.
