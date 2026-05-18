# Audit Trail

Assignee writes a tamper-evident audit trail for every plan, apply, and
destroy operation. Each log entry is HMAC-SHA256–linked to the previous
entry so that any alteration (deletion, tampering, re-ordering) breaks the
chain and is detectable via `assignee admin audit-verify`.

---

## Chain construction

Each NDJSON record is wrapped as
`{ index, timestamp, role, record, prevHmac, hmac }`. The chain HMAC is

```
hmac = HMAC-SHA-256(prevHmac + "|" + canonicalJson(record), key)
```

`canonicalJson` produces a stable, sorted-key serialization so the HMAC
input is deterministic across runs and platforms. The literal pipe
separator between `prevHmac` and `canonicalJson(record)` defends against
length-extension ambiguity at GENESIS, where `prevHmac` is a fixed
sentinel value. See
[audit-threat-model.md](../explanation/audit-threat-model.md) for the
threat-model context. Implementation is in
`packages/core/src/audit/hmac-chain.ts`.

---

## Audit Key Management

The HMAC chain requires a stable, secret key. Assignee resolves the key
with the following priority (highest wins):

### 1. Environment variable — `ASSIGNEE_AUDIT_KEY` (production / CI)

Set `ASSIGNEE_AUDIT_KEY` to a secret string of at least 32 characters:

```bash
export ASSIGNEE_AUDIT_KEY="$(openssl rand -hex 32)"
```

When this variable is set, Assignee uses it exclusively — the key file
(see below) is **not** read or written.

Minimum length: 32 characters (any UTF-8); 64 hex chars (= 32 bytes)
recommended for production. `openssl rand -hex 32` produces the
recommended length. Verified at
`packages/core/src/audit/hmac-chain.ts:113,202-208`.

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

> **Note**: Records written with the old key will fail `assignee admin audit-verify`
> after rotation. This is intentional — the old key is required to verify
> the old chain. Keep backups of old keys if historical verification is
> needed.

A future iteration (deferred to future work; out of scope for this
course submission) could automate the rotation workflow as a guided
wizard that archives the old key and re-signs the existing log.

### Missing key file behavior

If the key file is absent and no env var is set:

- Assignee generates a new key and attempts to write it to
  `~/.assignee/audit-key`.
- On a read-only filesystem, Assignee falls back to an in-process
  ephemeral key (warning emitted to stderr) and the chain is **not**
  durable across restarts. Configure `ASSIGNEE_AUDIT_KEY` on such systems.

### Migration note

Prior to this change (pre-2026-04-29), the fallback was a
**per-process random key** that was discarded when the process exited.
Any audit records written with the old per-process key will fail
`assignee admin audit-verify` — those chains were already unverifiable across
process boundaries. No migration tooling is provided; re-run the
operations to produce a fresh, verifiable chain with the new persistent key.

---

## Hardening properties

The audit-key loader and log writer enforce several filesystem-level
defenses beyond the HMAC chain itself:

- **Symlink rejection** — if `~/.assignee/audit-key` is a symlink (or
  any non-regular file), Assignee refuses to read it and falls back to
  regenerating a fresh key. This blocks an attacker who plants a
  symlink pointing at a key file they can also read.
- **Hardlink rejection** — the loader checks the inode link count and
  refuses to read a key file with link count > 1 (hardlink fan-out).
  The same regenerate-fresh fallback applies.
- **Parent-directory mode warning** — if `~/.assignee/` itself has
  permissions broader than `0700`, the loader emits a warning to
  stderr so the operator notices a misconfigured directory before a
  same-uid neighbour exfiltrates the key.
- **5-minute in-process cache + SIGHUP rotation** — once loaded, the
  key is cached in process memory for at most 5 minutes; sending
  `SIGHUP` to the CLI clears the cache immediately so a rotated key
  on disk is picked up without restarting long-lived processes.
  Calling `rotateAuditKey()` from inside the process clears the
  cache as well.

These properties are unit-tested in
`packages/core/src/audit/hmac-chain.test.ts`.

---

## Verifying the audit log

```bash
assignee admin audit-verify
```

Reads `~/.assignee/audit/audit.log` (default location) and re-computes every
HMAC in the chain. Reports the first broken link if any tampering is
detected.

The available flags are `--json`, `--from <date>`, `--to <date>`, and
`--log-file <path>`. Set `ASSIGNEE_AUDIT_KEY` to supply the key used when
the records were written if it differs from the on-disk key file.

`audit-verify` also prints a `Chain mode: <canonical|legacy|mixed>` line
indicating which HMAC serialization variants were observed. When the
mode is anything other than `canonical`, the verifier emits a migration
warning to stderr pointing to
`scripts/audit-migrate-legacy-chain.ts --input <logfile>` (see
`apps/cli/src/commands/audit-verify.ts:127-145`).

> **Scaffold flags.** The `--from` / `--to` flags are present but are
> not yet wired to filtering — supplying them today emits a stderr
> warning and verifies the full chain regardless. Range filtering is
> planned for a future release; the chain HMAC verification itself
> always covers every record from genesis to tail.
