# Audit Trail Threat Model

**Last updated**: 2026-04-29

This document describes what the Assignee.ai HMAC-chained audit log **does**
and **does not** defend against. It is the authoritative source for the
scoped tamper-evidence claim used in `audit-log.ts` and `audit-verifier.ts`.

---

## What the audit chain IS

The audit trail is a NDJSON append-only log where each record is wrapped with:

```
{ index, timestamp, role, record, prevHmac, hmac }
```

`hmac` is computed as `HMAC-SHA-256(prevHmac + "|" + canonicalJson(record), key)`
where `key` is loaded from `~/.assignee/audit-key` (mode 0o600, owner-only)
or from the `ASSIGNEE_AUDIT_KEY` environment variable. The literal pipe (`|`)
separator between `prevHmac` and the canonical-JSON record blocks length-extension
ambiguity at GENESIS, where `prevHmac` is a fixed sentinel string —
without the separator, an attacker could forge an entry that prepends a
crafted prefix to the canonical-JSON record and the HMAC input would still
parse as `prevHmac || record` with no boundary marker. Verified at
`packages/core/src/audit/hmac-chain.ts:451`.

The chain property: every entry links to its predecessor's HMAC value
(`prevHmac`). The verifier (`audit-verifier.ts`) walks the chain from genesis
and rejects any entry whose HMAC does not verify — detecting payload mutation,
HMAC forgery, entry deletion, and index gaps.

---

## What the audit chain defends against

| Threat                                                     | Defended? | Mechanism                                                                                                                           |
| ---------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| External attacker modifying log entries                    | Yes       | HMAC mismatch detected by verifier                                                                                                  |
| Entry deletion / reordering                                | Yes       | Index gap or prevHmac linkage break detected                                                                                        |
| Accidental log rotation / truncation                       | Yes       | `guardAuditLogTruncation` enforces retention floor                                                                                  |
| Partial write / filesystem corruption                      | Yes       | Index-gap + prevHmac check catches truncated tail                                                                                   |
| Legacy-HMAC silent acceptance during chain re-verification | Yes       | `legacyVerifyChainLink` requires `ASSIGNEE_AUDIT_ALLOW_LEGACY=1` opt-in (insider with key, since legacy verify still needs the key) |

---

## What the audit chain does NOT defend against (acknowledged limitations)

### SEC-002 — Same-uid insider rollback attack

**Threat**: an insider who has **both**:

1. write access to `~/.assignee/audit/audit.log`, AND
2. read access to `~/.assignee/audit-key` (0o600, same uid)

can perform a rollback attack:

1. Read the HMAC key from `~/.assignee/audit-key`.
2. Truncate the log to entry N (which has HMAC `H_N`).
3. Compose a new entry whose `prevHmac = H_N` and whose `record` contains
   exonerating or misleading data.
4. Sign the new entry with the same key.

The verifier walks forward from genesis and **accepts** the truncated tail
because every link is internally consistent. There is no external anchor to
reveal that entries after index N were deleted.

**Current mitigation**: `guardAuditLogTruncation` detects accidental
truncation within the retention window, but does not prevent adversarial
truncation by a key-knowing insider.

**Deferred fix**: a periodic out-of-band anchor — signed digest of
`(maxIndex, maxHmac)` pushed to S3 Object Lock or a remote append-only sink
— would close this gap. Deferred to future work; out of scope for this
course-submission build.

**Until that ships**: treat the audit chain as tamper-evident against
attackers who do **not** have read access to the key file. Insider threats
in the same uid-space require the external anchor to be fully addressed.

### SEC-035 — Legacy HMAC downgrade (mitigated by opt-in gate)

**Threat**: the verifier previously accepted records whose HMAC matched the
legacy serialization (`JSON.stringify` insertion-order) unconditionally.
An insider with the key could re-sign tampered records under the legacy format
and the verifier would accept them with a warning but `ok: true`.

**Fix (SEC-035)**: the legacy fallback is now gated behind
`ASSIGNEE_AUDIT_ALLOW_LEGACY=1`. Without this flag, any entry that
fails canonical verification is rejected with
`{ ok: false, reason: "legacy-hmac-not-allowed" }`.

Set `ASSIGNEE_AUDIT_ALLOW_LEGACY=1` only during active migration
windows when pre-canonical chain segments must be re-verified before
re-signing. Expected sunset by 2027-04-29 once chain re-signing is
complete; a future CI-enforced legacy-removal probe would assert that
no chain still depends on the legacy verifier.

---

## Key file threat boundary

The key file (`~/.assignee/audit-key`) is the root of trust for the audit
chain. Its security properties:

- Mode 0o600 — only the owning user can read or write it.
- Loaded once per process and cached (cleared on SIGHUP or `rotateAuditKey()`).
- No KMS backing yet — key management is deferred to future productisation
  work, out of scope for this course-submission build.

**Consequence**: if the key file is compromised, the entire audit chain's
tamper-evidence guarantee is void. Protect `~/.assignee/` with filesystem-
level access controls appropriate to your deployment environment.

---

## Future work

These items are deferred to future productisation work; they are out of
scope for this course-submission build.

- KMS-backed key management (key never touches disk in plaintext).
- Periodic out-of-band anchor: signed digest of `(maxIndex, maxHmac)` pushed
  to an S3 Object-Lock bucket or remote append-only sink at intervals.
- Verifier reads the anchor and rejects any chain whose high-water mark
  (`maxIndex`, `maxHmac`) is lower than the anchor, making rollback visible
  even to a key-knowing insider.

---

## References

- `packages/core/src/audit/audit-verifier.ts` — chain verifier implementation
- `packages/core/src/audit/audit-log.ts` — write path and retention guard
- `packages/core/src/audit/hmac-chain.ts` — HMAC computation and key management
- Security audit findings SEC-002 (Critical) and SEC-035 (High/Medium) are
  recorded in workspace-internal review notes outside this repo.
