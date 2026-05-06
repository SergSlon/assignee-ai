# Log retention policy

This document explains _why_ Assignee enforces minimum log-retention floors,
what the floors are, and what the design decisions behind them are.
For operational instructions (how to configure, how to run `assignee doctor`)
see the [how-to guides](../how-to/).

---

## Why retention floors exist

Assignee produces two distinct log streams:

**General operational logs** (`~/.assignee/logs/cli-YYYY-MM-DD.jsonl`)
capture structured JSON events for every CLI invocation: plan/apply/destroy
results, LLM token usage, errors, and warnings. These logs exist primarily
for operators — to diagnose a failing automation run, correlate a cost spike
with a specific deployment, or audit what a pipeline actually did. Without a
minimum retention window, a cron job or a misconfigured rotation tool could
delete these files hours after they are written, leaving nothing to inspect
when a production incident occurs.

**Audit logs** (`~/.assignee/audit/audit.log`) are a tamper-evident HMAC
chain of every security-relevant event (who provisioned what, under which
IAM role, at what time). These logs exist for the operator's audit-trail
needs, not just day-to-day debugging. The 90-day floor below is an
**industry-aligned floor for future productisation** — it matches the
shortest quarter used in compliance calendars and is a defensible minimum
for a credential-holding cloud-IaC tool. This is design intent; this
course-submission build does not claim certification against any specific
compliance regime.

---

## The floors

| Log type            | Minimum floor | Env var to extend               | Cannot go below | Floor-violation behaviour                                                                     |
| ------------------- | ------------- | ------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| General operational | 30 days       | `ASSIGNEE_LOG_RETENTION_DAYS`   | 30 days         | Silent clamp — `resolveLogRetentionDays()` rounds any sub-floor value up to 30 with no error  |
| Audit (HMAC chain)  | 90 days       | `ASSIGNEE_AUDIT_RETENTION_DAYS` | 90 days         | Hard error — the audit-log retention resolver throws so misconfiguration fails fast on stderr |

The word "extend" above is deliberate: the env vars allow operators to
_increase_ the window beyond the default, not reduce it below the floor.
An operator who needs 365-day audit retention for a stricter compliance
regime sets `ASSIGNEE_AUDIT_RETENTION_DAYS=365` and the system honours it.
An operator who sets `ASSIGNEE_AUDIT_RETENTION_DAYS=30` receives a clear
error on stderr and the 90-day floor is applied regardless.

---

## Design decisions

### Why 30 days for general logs?

The old default was 14 days — sufficient for routine debugging but too short
for incident response patterns that span multiple weeks (change-freeze periods,
delayed incident reports, on-call rotations that hand off mid-investigation).
Thirty days covers a calendar month, which is the smallest cycle that aligns
with typical sprint reviews and cost-reporting periods.

Operational logs are rotated by filename date (one file per day, plus numbered
overflow suffixes). The `pruneOldLogs` function removes files whose filename
date is strictly older than the effective retention window. The floor is
enforced by `resolveLogRetentionDays()` which silently clamps any value below
30 up to 30 — no crash, no data loss, just a safe minimum.

### Why 90 days for audit logs?

Ninety days matches the shortest quarter used in compliance calendars and is
the conventional minimum cited for audit retention on operational systems.
It is also a workable minimum for any future audit window covering the
previous quarter.

The 90-day floor is _hard_ — intentionally not overridable downward. The
reasoning: a floor that operators can circumvent is not a floor, it
is a suggestion. If an operator must retain logs for a _shorter_ period for
data-minimisation reasons, the right mechanism is a data-retention policy that
covers the full data lifecycle (not just the Assignee audit log), not an
env-var setting in a CLI tool.

### Why is the floor enforced at the tool layer, not the OS layer?

Assignee cannot control what `logrotate`, `cron`, or an operator script does
to the files after they are written. What Assignee _can_ do is:

1. Guard its own write-path functions (`guardAuditLogTruncation`) so that any
   code path inside Assignee that would truncate or delete audit records
   first checks whether the records are within the retention floor.
2. Surface violations in `assignee doctor` (the "Log retention" section) so
   operators notice immediately when the on-disk state deviates from the
   policy — whether caused by Assignee itself, a system tool, or a manual
   deletion.

The doctor check is a _diagnostic_, not an enforcer: it does not recreate
deleted files or block the CLI from running. Its purpose is visibility:
operators and security teams running `assignee doctor` should see clearly
whether the retention policy is being honoured.

---

## What `assignee doctor` checks

The "Log retention" section runs four sub-checks:

1. **General log retention** — reads `ASSIGNEE_LOG_RETENTION_DAYS` (or the
   default 30) and confirms it is at or above the 30-day floor.
2. **Audit log retention** — reads `ASSIGNEE_AUDIT_RETENTION_DAYS` (or the
   default 90) and confirms it is at or above the 90-day floor. Marked
   `[HIGH]` if misconfigured.
3. **General logs directory** — confirms `~/.assignee/logs/` exists and that
   the oldest log file's mtime is at least as old as the floor. If the
   oldest mtime is younger than the floor, it may indicate that files were
   rotated or deleted below the minimum.
4. **Audit logs directory** — same check for `~/.assignee/audit/`. A warning
   here is a potential compliance violation and should be investigated.

All four sub-checks are read-only. `assignee doctor` never deletes,
modifies, or recreates files.

---

## Relationship to other data-retention controls

The log-retention floor does not replace:

- **OS-level rotation** (`logrotate`, systemd-journal, etc.) — these operate
  independently. If they are configured to delete files earlier than the
  Assignee floor, `assignee doctor` will surface the discrepancy.
- **Remote audit sink** (KMS-signed S3 Object Lock) — hypothetical future
  productisation feature, out of scope for this course-submission build.
  If a remote sink were enabled in the future, the local audit log would
  become a local cache and the S3 Object Lock policy would become the
  authoritative retention control.
- **Backup and disaster recovery** — out of scope for this policy. Log
  retention is about minimum availability for operational and compliance
  purposes, not about backup guarantees.
