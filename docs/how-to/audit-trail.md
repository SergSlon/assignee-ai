# Audit Trail

Assignee writes a tamper-evident audit trail for every plan, apply, and
destroy operation. Each log entry is HMAC-SHA256–linked to the previous
entry so that any alteration (deletion, tampering, re-ordering) breaks the
chain and is detectable via `assignee audit-verify`.

---

## Audit Key Management

The HMAC chain requires a stable, secret key. Assignee resolves the key
with the following priority (highest wins):

### 1. Environment variable — `ASSIGNEE_AUDIT_KEY` (production / CI)

Set `ASSIGNEE_AUDIT_KEY` to a secret hex string of at least 32 characters:

```bash
export ASSIGNEE_AUDIT_KEY="$(openssl rand -hex 32)"
```

When this variable is set, Assignee uses it exclusively — the key file
(see below) is **not** read or written.

Minimum length: 32 characters. A 64-character random hex string
(`openssl rand -hex 32`) is recommended for production.

### 2. Persistent key file — `~/.assignee/audit-key` (default / dev)

When `ASSIGNEE_AUDIT_KEY` is absent, Assignee reads the key from
`~/.assignee/audit-key` (mode `0600`, owner read+write only).

**First use**: if the file does not exist, Assignee generates a
cryptographically-random 32-byte key, writes it to `~/.assignee/audit-key`
with mode `0600`, and returns it. Subsequent CLI invocations — in any
process — read the same key from disk, so HMAC chains survive process
restarts.

**Mode check**: if the file exists but has permissions other than `0600`,
Assignee emits a warning. Fix with:

```bash
chmod 600 ~/.assignee/audit-key
```

### Key rotation

To rotate the audit key:

1. **Back up the current key** (required to verify old records later):

   ```bash
   cp ~/.assignee/audit-key ~/.assignee/audit-key.$(date +%Y%m%d)
   ```

2. **Delete the key file** (or unset `ASSIGNEE_AUDIT_KEY`):

   ```bash
   rm ~/.assignee/audit-key
   ```

3. **Let Assignee generate a new key** on the next run, or set the env var:
   ```bash
   export ASSIGNEE_AUDIT_KEY="$(openssl rand -hex 32)"
   ```

> **Note**: Records written with the old key will fail `assignee audit-verify`
> after rotation. This is intentional — the old key is required to verify
> the old chain. Keep backups of old keys if historical verification is
> needed.

In a future release (`assignee setup --rotate-audit-key`, Epic 101
identity-squad), the rotation workflow will be automated with a guided
wizard that archives the old key and re-signs the existing log.

### Missing key file behavior

If the key file is absent and no env var is set:

- Assignee generates a new key and attempts to write it to
  `~/.assignee/audit-key`.
- On a read-only filesystem, Assignee falls back to an in-process
  ephemeral key (warning emitted to stderr) and the chain is **not**
  durable across restarts. Configure `ASSIGNEE_AUDIT_KEY` on such systems.

### Migration note (W14-S3)

Prior to this change (v0.x, pre-2026-04-29), the fallback was a
**per-process random key** that was discarded when the process exited.
Any audit records written with the old per-process key will fail
`assignee audit-verify` — those chains were already unverifiable across
process boundaries. No migration tooling is provided; re-run the
operations to produce a fresh, verifiable chain with the new persistent key.

---

## Verifying the audit log

```bash
assignee audit-verify
```

Reads `~/.assignee/audit.log` (default location) and re-computes every
HMAC in the chain. Reports the first broken link if any tampering is
detected.

Use `--key-file <path>` or set `ASSIGNEE_AUDIT_KEY` to supply the key
used when the records were written.
