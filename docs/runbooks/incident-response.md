# Incident Response Runbook

**Audience:** On-call operators of the Assignee.ai CLI.
**Quadrant:** How-to — follow these steps in sequence; skip explanation.

---

## 1. Incident Classification Matrix

| Severity | Label               | Definition                                                                                                                                                               | Example Scenarios                                                                                                                        | Initial Response Time         | Escalation Path                                                            |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| **SEV1** | Catastrophic        | All managed infrastructure unreachable or actively being destroyed; credential leak with confirmed exfiltration; audit chain confirmed tampered                          | Operator credential key published to public repo; bulk `assignee destroy` loop running unattended; `provisions.json` deleted + no backup | **Immediate** (within 15 min) | On-call lead → security team → CTO; AWS Support case (Business/Enterprise) |
| **SEV2** | High impact         | Apply/destroy commands consistently failing; AWS throttling blocking all provisioning; `assignee doctor` hard failure on credentials; drift detected across ≥5 resources | All `assignee apply` invocations exit 1; `sts:GetCallerIdentity` failing for operator role; Bedrock endpoint returning 5xx on every call | **Within 1 hour**             | On-call lead → engineering lead                                            |
| **SEV3** | Partial degradation | Subset of commands failing; single resource stuck in drift; MCP server startup failure; Bedrock Guardrail blocking legitimate requests                                   | `assignee drift` exits 1 for one resource; `assignee doctor` exits 2 (warnings only); one MCP server fails probe                         | **Within 4 hours**            | On-call lead; engineering lead if unresolved after 2h                      |
| **SEV4** | Cosmetic            | Output formatting issues; non-blocking warnings; stale checkpoint notifications; `BASELINE_MISSING` rows in drift output                                                 | Unexpected colour rendering; `assignee doctor` cache warning; BASELINE_MISSING rows for resources provisioned before tracking began      | **Next business day**         | Ticket in backlog                                                          |

---

## 2. First-30-Minutes Triage Checklist

Run these steps in order. Stop and escalate when any step reveals a hard failure.

### Step 1 — Environment health

```bash
assignee doctor
```

- Exit 0 → credentials + Bedrock + MCP all green. Proceed to step 2.
- Exit 2 → warnings only. Note which section flagged `[!]` and continue.
- Exit 1 → hard failure. See the failing section's output and consult [`docs/troubleshooting.md`](../troubleshooting.md) for the matching exit-code playbook.

```bash
# Machine-readable form — useful for scripted triage:
assignee doctor --json | jq '.checks[] | select(.status == "fail")'
```

### Step 2 — Audit-log chain integrity

```bash
assignee audit-verify
```

- Exit 0 → chain intact from the first record.
- Exit 1 → chain broken. The output names the first corrupt index. Treat as SEV1/SEV2: preserve artefacts before any remediation (see §3).
- Exit 2 → `ASSIGNEE_AUDIT_KEY` not set persistently; chain cannot be verified across restarts. Set the key and re-verify.

> **Background:** Every audit event is HMAC-signed. `assignee audit-verify` re-derives the chain from record 0 and halts at the first mismatch. Implemented in Story `100-W3-01-audit-log-hmac-chain.md` (Wave W3). See [`packages/core/src/audit/audit-verifier.ts`](../../packages/core/src/audit/audit-verifier.ts).

### Step 3 — Managed-resource inventory

```bash
assignee list --json | jq 'length'
```

Compare the count against the last-known baseline. Unexpected drops (resources missing) → SEV1/SEV2. An increase when no apply was intended → investigate who ran it.

### Step 4 — Drift detection

```bash
assignee drift --json
```

- Exit 0 → all resources in sync.
- Exit 1 → at least one resource drifted. Parse the JSON output to identify which resources and proceed to §4 playbooks.

```bash
# Surface only drifted resources:
assignee drift --json | jq '.[] | select(.status == "DRIFTED")'
```

### Step 5 — Log inspection

```bash
# Error and warning events:
grep -E '"level":"(error|warn)"' ~/.assignee/logs/cli-$(date +%Y-%m-%d).jsonl | tail -50
# All log files in date order:
ls -lt ~/.assignee/logs/
```

Events at `error` level indicate hard failures. Events at `warn` level indicate recoverable conditions (throttling, stale checkpoints). Capture the full file before any remediation.

### Step 6 — CloudFormation console check

Open the [AWS CloudFormation console](https://console.aws.amazon.com/cloudformation) for each region you operate in.

Filter stacks by status: `CREATE_FAILED`, `UPDATE_ROLLBACK_FAILED`, `DELETE_FAILED`. A stack in one of these states means a previous apply or destroy did not complete cleanly. Capture the "Events" tab output before taking action.

---

## 3. Evidence Collection

**Preserve artefacts before any remediation.** Remediation can overwrite the evidence needed for root-cause analysis.

### 3a — Audit-log files

```bash
INCIDENT_DATE=$(date +%Y%m%d-%H%M%S)
cp -r ~/.assignee/audit/ /tmp/incident-${INCIDENT_DATE}-audit/
```

These JSONL files contain the HMAC-chained record of every CLI operation. Do not modify them. If the chain is broken, the original files are the forensic artefact.

### 3b — Provision ledger

```bash
# Copy the current ledger verbatim:
cp ~/.assignee/memory/provisions.json /tmp/incident-${INCIDENT_DATE}-provisions.json

# If the ledger appears corrupt or empty, restore from the most recent backup:
ls -lt ~/.assignee/backups/provisions-*.json | head -3
# Then restore (dry-run first):
assignee restore-provisions ~/.assignee/backups/provisions-YYYY-MM-DD.json --dry-run
```

The nightly backup primitive (`pnpm backup-provisions`) rotates backups under `~/.assignee/backups/` with 7-day retention. Implemented in Story `100-W4-04-provisions-bcpdr-primitive.md` (Wave W4). See [`scripts/backup-provisions.ts`](../../scripts/backup-provisions.ts).

### 3c — Log bundle

```bash
INCIDENT_DATE=$(date +%Y%m%d-%H%M%S)
tar -czf /tmp/incident-${INCIDENT_DATE}-logs.tar.gz ~/.assignee/logs/
```

Log files are at `~/.assignee/logs/cli-YYYY-MM-DD.jsonl`. Both `warn` and `error` events are written here regardless of `--verbose` level.

### 3d — CloudFormation events

In the AWS console, navigate to each affected stack → Events tab → copy the full events table. Alternatively via CLI:

```bash
aws cloudformation describe-stack-events \
  --stack-name <stack-name> \
  --query 'StackEvents[*].{Time:Timestamp,Status:ResourceStatus,Reason:ResourceStatusReason}' \
  --output table > /tmp/incident-${INCIDENT_DATE}-cfn-events.txt
```

### 3e — Bedrock invocation logs (if Guardrail audit-mode active)

If `BEDROCK_GUARDRAIL_ID` is set and `assignee setup --enable-llm-logging` was run:

1. Open CloudWatch Logs → log group `/aws/bedrock/modelinvocations`.
2. Filter to the incident time window.
3. Export the log stream as JSON.

---

## 4. Common-Incident Playbooks

### 4a — Drift detected on a managed resource

**Symptom:** `assignee drift` exits 1 with one or more `DRIFTED` rows.

```bash
# 1. Identify the drifted resource (note its ARN):
assignee drift --json | jq '.[] | select(.status == "DRIFTED") | .resourceArn'

# 2. Preview what reconcile would do:
assignee reconcile --resource <type-filter> --dry-run

# 3. Reconcile (interactive — presents choices per resource):
assignee reconcile

# 4. Non-interactive (CI/CD mode — reconciles all drifted resources):
assignee reconcile --yes
```

After reconcile, re-run `assignee drift` to confirm exit 0.

See [`docs/drift-detection.md`](../drift-detection.md) for the full drift workflow.

---

### 4b — Stale checkpoint blocking apply

**Symptom:** `assignee apply` uses a checkpoint older than 72 hours or references a resource that no longer exists.

```bash
# 1. List checkpoints sorted by age:
ls -lt ~/.assignee/checkpoint-*.json

# 2. Inspect which checkpoint would be auto-selected:
assignee apply --dry-run   # or plan and inspect output

# 3. Restore ledger from a known-good backup date:
assignee restore-provisions ~/.assignee/backups/provisions-YYYY-MM-DD.json --dry-run
assignee restore-provisions ~/.assignee/backups/provisions-YYYY-MM-DD.json

# 4. Re-plan from scratch once checkpoint is cleared:
assignee plan "<original intent>"
```

See [`docs/commands.md`](../commands.md#restore-provisions) for `restore-provisions` options. Backup rotation is implemented in [`scripts/backup-provisions.ts`](../../scripts/backup-provisions.ts).

---

### 4c — AWS service throttling cascading

**Symptom:** `assignee apply` or `assignee drift` emits repeated `ThrottlingException` warnings; provisioning takes much longer than usual.

**Action:**

Do **not** issue manual retries — `status-poller.ts` already implements exponential backoff with jitter (Story W10-05, P042). See [`packages/core/src/graph/nodes/status-poller.ts`](../../packages/core/src/graph/nodes/status-poller.ts) lines 22–42 for the backoff constants (base: 2 s, cap: 60 s).

```bash
# 1. Confirm throttling is the cause — look for ThrottlingException in logs:
grep -i "throttl" ~/.assignee/logs/cli-$(date +%Y-%m-%d).jsonl | tail -20

# 2. If provisioning is still active, wait — the poller will retry automatically.

# 3. If it has hard-failed (exit 1), re-run the original apply command.
#    The same backoff will apply from the start of the new attempt.
```

For sustained throttling (multiple consecutive failures), open an AWS Support case to request a CloudControl API quota increase.

---

### 4d — Operator credential leak suspected

**Symptom:** Unexpected AWS activity traced to assignee-operator credentials; key appears in logs or a public repository.

```bash
# IMMEDIATE — rotate the key:
# 1. Create a new access key for assignee-operator:
aws iam create-access-key --user-name assignee-operator

# 2. Update ~/.assignee/config.yaml or .env with the new key.

# 3. Invalidate the leaked key:
aws iam delete-access-key \
  --user-name assignee-operator \
  --access-key-id AKIA<leaked-key-id>

# 4. Verify new credentials work:
assignee doctor

# 5. Review recent audit log for unexpected operations:
assignee audit-verify
grep '"level":"error"' ~/.assignee/audit/*.jsonl | tail -50

# 6. Check current security posture:
assignee status --bp-coverage

# 7. Review CloudTrail for unauthorized API calls in the incident window.
```

> **Safety:** The IAM safety allowlist (see [`docs/explanation/invariants.md`](../explanation/invariants.md)) unconditionally excludes `AssigneeOperator`, `AssigneeReader`, `AssigneeAuditor`, and `AssigneeBedrock*` roles from bulk-destroy sweeps to prevent self-lockout.

---

### 4e — Bedrock Guardrail violation in production output

**Symptom:** `assignee plan` or `assignee apply` returns an error referencing a Guardrail block; output is empty or truncated.

```bash
# 1. Identify the Guardrail in use:
echo $BEDROCK_GUARDRAIL_ID
echo $BEDROCK_GUARDRAIL_VERSION

# 2. Review invocation logs in CloudWatch if LLM logging is enabled:
#    Log group: /aws/bedrock/modelinvocations
#    Filter for the incident timestamp and GuardrailAction = "BLOCKED"

# 3. Diagnose the policy:
#    AWS Console → Amazon Bedrock → Guardrails → <BEDROCK_GUARDRAIL_ID> → Test

# 4. If the block is a false positive, adjust the Guardrail policy in the console.
#    Do NOT remove the guardrail entirely in production.

# 5. If adjustment is needed immediately, temporarily override the guardrail:
BEDROCK_GUARDRAIL_ID="" assignee plan "<intent>"

# 6. Verify the updated policy allows the intended request, then remove the override.
```

---

### 4f — Compromised MCP server (drift-poisoning attempt)

**Symptom:** Unexpected advice snippets appear in plan output; MCP server responses contain boundary tags or unusual formatting.

```bash
# 1. Check what the advice-generator received from the MCP server.
#    The sanitizer strips boundary tags before interpolation (P013/R8-02):
grep -i "mcp\|advice\|snippet\|boundary" ~/.assignee/logs/cli-$(date +%Y-%m-%d).jsonl | tail -30

# 2. Inspect advice-generator source to confirm sanitizer is active:
#    packages/core/src/graph/nodes/advice-generator.ts line 188-190
#    stripPromptBoundaryTags() runs on every MCP snippet before interpolation.

# 3. If a MCP server is suspected compromised, pin it to a known-good version:
#    Edit the pin in mcp-servers.md / package.json config, restart.

# 4. If you believe injection succeeded past the sanitizer, treat as SEV1:
#    - Preserve logs (§3c above)
#    - Do NOT run further assignee commands until the server is replaced
#    - File an incident report with the exact snippet and server version
```

See [`packages/core/src/graph/nodes/advice-generator.ts`](../../packages/core/src/graph/nodes/advice-generator.ts) and [`docs/mcp-servers.md`](../mcp-servers.md).

---

### 4g — Path-traversal attempt in `--output-file`

**Symptom:** `assignee drift --output <path>` or similar rejects the path with a "path-traversal" error; suspicious `--output-file` values appear in CLI invocation logs.

```bash
# 1. The guard rejects pre-write (CWE-22 guard in safe-output-path.ts):
#    apps/cli/src/utils/safe-output-path.ts:77
#    Any path that resolves outside the CWD is rejected with exit 10.

# 2. Review CLI invocation logs for the rejected call:
grep -i "output.*path\|traversal\|safe-output" ~/.assignee/logs/cli-$(date +%Y-%m-%d).jsonl | tail -20

# 3. If the invocation came from a script or CI pipeline, audit the script's source.

# 4. If the invocation was from an interactive session, identify which terminal
#    session produced it (audit log timestamps + tty info if available).
```

See [`apps/cli/src/utils/safe-output-path.ts`](../../apps/cli/src/utils/safe-output-path.ts).

---

## 5. Rollback Procedures

### 5a — Destroy a single resource (rollback by deletion)

```bash
# Confirmation requires typing the resource identifier — not Y/n.
assignee destroy <resource-arn>

# Non-interactive (CI/CD mode):
assignee destroy --yes <resource-arn>
```

> **Note:** Bulk destroy (`--all` / `--include-iam`) was **removed** in Story 50-3. Destroy one resource at a time. For scripted sweeps:

```bash
assignee list --json | jq -r '.[].ResourceARN' | while read arn; do
  assignee destroy --yes "$arn"
done
```

See [`docs/commands.md`](../commands.md#destroy).

### 5b — Reconcile drift back to desired state

```bash
# Dry-run first to preview changes:
assignee reconcile --dry-run

# Apply reconciliation with per-resource prompts:
assignee reconcile

# Apply all without prompting (CI/CD mode):
assignee reconcile --yes
```

Reconcile re-applies the checkpointed desired state via CloudControl `UpdateResource`. It does **not** re-run the plan pipeline. If the checkpoint is missing or stale, re-plan first.

### 5c — Restore provision ledger from backup

```bash
# List available backups (7-day retention by default):
ls -lt ~/.assignee/backups/provisions-*.json

# Dry-run to preview what would be restored:
assignee restore-provisions ~/.assignee/backups/provisions-YYYY-MM-DD.json --dry-run

# Restore from a specific date (merges by run ID, deduplicates):
assignee restore-provisions ~/.assignee/backups/provisions-YYYY-MM-DD.json

# Filter to records on or after a date:
assignee restore-provisions ~/.assignee/backups/provisions-YYYY-MM-DD.json --from 2026-01-01
```

See [`docs/commands.md`](../commands.md#restore-provisions) and the backup script at [`scripts/backup-provisions.ts`](../../scripts/backup-provisions.ts).

---

## 6. Post-Mortem Template

Copy this template into your incident tracking system. Fill in every field — leave none blank.

```markdown
## Incident Post-Mortem

**Incident ID:** INC-YYYY-MMDD-NNN
**Severity:** SEV1 / SEV2 / SEV3 / SEV4
**Date/Time (UTC):** YYYY-MM-DD HH:MM – HH:MM
**Duration:** N hours N minutes
**Reported by:** [name / alert name]
**Owner:** [name]
**Reviewers:** [names]

---

### Timeline

| Time (UTC) | Event                           |
| ---------- | ------------------------------- |
| HH:MM      | First alert / symptom observed  |
| HH:MM      | On-call engaged; triage started |
| HH:MM      | Root cause identified           |
| HH:MM      | Remediation applied             |
| HH:MM      | Service verified restored       |
| HH:MM      | Incident closed                 |

---

### Root Cause

<!-- One sentence: what failed and why. -->

---

### Contributing Factors

<!--
List every factor that made this incident possible or harder to detect.
Examples: missing credential rotation, no alert on audit-chain break,
stale backup not tested, etc.
-->

- [ ] Factor 1
- [ ] Factor 2

---

### Remediation Steps Taken

<!-- What was done to resolve the incident. Reference CLI commands run. -->

1. Step 1
2. Step 2

---

### Prevention Actions

<!-- Concrete tickets / PRs / process changes that will prevent recurrence. -->

| Action | Owner | Due date | Ticket |
| ------ | ----- | -------- | ------ |
|        |       |          |        |

---

### Artefacts Preserved

- [ ] Audit-log files copied to `/tmp/incident-<id>-audit/`
- [ ] `provisions.json` snapshot at `/tmp/incident-<id>-provisions.json`
- [ ] Log bundle at `/tmp/incident-<id>-logs.tar.gz`
- [ ] CFN events captured
- [ ] Bedrock invocation logs exported (if applicable)

---

### Detection Gap

<!-- How long between the triggering event and detection? What would have shortened it? -->

---

### Lessons Learned

<!--
Three questions:
1. What went well during the response?
2. What did not go well?
3. What surprised us?
-->
```

---

## 7. Communication Templates

### 7a — Internal stakeholder notice (initial)

```
Subject: [INCIDENT SEV<N>] <Short description> — <YYYY-MM-DD HH:MM UTC>

We are investigating an active SEV<N> incident affecting <scope>.

STATUS: Investigating
STARTED: YYYY-MM-DD HH:MM UTC
IMPACT: <What is affected and who is impacted>
NEXT UPDATE: HH:MM UTC (or sooner if status changes)

Incident lead: <name>
Tracking: <ticket/channel link>
```

### 7b — Internal stakeholder notice (resolution)

```
Subject: [RESOLVED SEV<N>] <Short description> — <YYYY-MM-DD HH:MM UTC>

The SEV<N> incident is resolved.

STATUS: Resolved
STARTED: YYYY-MM-DD HH:MM UTC
RESOLVED: YYYY-MM-DD HH:MM UTC
DURATION: N hours N minutes

ROOT CAUSE: <one sentence>
REMEDIATION: <what was done>
FOLLOW-UP: Post-mortem scheduled for <date>; ticket <ID> tracks prevention items.

Incident lead: <name>
```

### 7c — Customer-facing notice (when customer data or provisioned resources are impacted)

```
Subject: Service Notice — Assignee.ai Incident <YYYY-MM-DD>

We identified an issue affecting <scope of impact>.

What happened: <Plain-language description. No internal jargon.>

Impact: <Which resources / operations were affected. Timeframe.>

What we did: <Actions taken to resolve.>

What you should do: <Specific steps, if any, the customer needs to take.
   If no action is required, say so explicitly.>

We are conducting a post-mortem and will share a summary of our findings
and prevention measures by <date>.

If you have questions, reply to this message or contact <support channel>.

— The Assignee.ai team
```

---

## Reference Index

| Topic                                | Document                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| All CLI commands and flags           | [`docs/commands.md`](../commands.md)                                                                           |
| Drift detection workflow             | [`docs/drift-detection.md`](../drift-detection.md)                                                             |
| Exit-code playbook                   | [`docs/troubleshooting.md`](../troubleshooting.md)                                                             |
| Load-bearing invariants              | [`docs/explanation/invariants.md`](../explanation/invariants.md)                                               |
| Audit-log HMAC chain                 | [`packages/core/src/audit/audit-verifier.ts`](../../packages/core/src/audit/audit-verifier.ts)                 |
| Provisions backup script             | [`scripts/backup-provisions.ts`](../../scripts/backup-provisions.ts)                                           |
| Path-traversal guard                 | [`apps/cli/src/utils/safe-output-path.ts`](../../apps/cli/src/utils/safe-output-path.ts)                       |
| MCP server drift-poisoning sanitizer | [`packages/core/src/graph/nodes/advice-generator.ts`](../../packages/core/src/graph/nodes/advice-generator.ts) |
| Throttling backoff constants         | [`packages/core/src/graph/nodes/status-poller.ts`](../../packages/core/src/graph/nodes/status-poller.ts)       |
