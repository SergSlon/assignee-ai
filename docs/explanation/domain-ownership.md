# Domain Ownership and MX Verification

<!-- W9-03 (P060 → L1-F37 + L2-F18 + L4-S24) -->

This document describes the domain ownership and mail-exchange verification
process for `assignee.ai` and `app.assignee.ai`. These verifications are
pre-signing acquirer tasks — run them before transfer documents are signed to
confirm the domain is under the expected team's control and that
`security@assignee.ai` is reachable.

## Domains in scope

| Domain                 | Purpose                                    |
| ---------------------- | ------------------------------------------ |
| `assignee.ai`          | Primary product domain                     |
| `app.assignee.ai`      | SaaS application entry point (future)      |
| `security@assignee.ai` | Security contact for vulnerability reports |

## Verification scripts

Two re-runnable scripts live in `scripts/`:

```sh
# MX verification — confirms the domain can receive email
npx tsx scripts/verify-domain-mx.ts --domain assignee.ai
npx tsx scripts/verify-domain-mx.ts --email security@assignee.ai
npx tsx scripts/verify-domain-mx.ts --domain app.assignee.ai

# Ownership proof — confirms a TXT record matches the expected token
npx tsx scripts/verify-domain-ownership.ts \
  --domain assignee.ai \
  --proof "assignee-verification=<token>"
```

Both scripts emit structured JSON to `stdout` and a human-readable status
line to `stderr`. Exit 0 on success; non-zero with actionable message on
failure.

## Ownership proof string

The ownership proof is a TXT record placed in DNS by the current domain
owner. The format is:

```
assignee-verification=<opaque-token>
```

The `<opaque-token>` is a secret string generated at registration time and
stored in the 1Password vault entry `assignee.ai DNS verification`. The
acquirer team lead receives access to this vault entry as part of the KT
(knowledge transfer) process.

### Where the TXT record lives

The TXT record must be present at the apex of the domain being verified
(i.e., `assignee.ai`, not `_assignee.assignee.ai`). Check using:

```sh
dig TXT assignee.ai +short
# or
nslookup -type=TXT assignee.ai
```

## Step-by-step verification flow

1. **Obtain the proof token.** The current owner provides the opaque token
   from the `assignee.ai DNS verification` 1Password entry.

2. **Verify MX records** (confirms email is operational):

   ```sh
   npx tsx scripts/verify-domain-mx.ts --domain assignee.ai
   ```

   Expected output: `ok: true` with at least one exchange record.

3. **Verify security email** (confirms security@ is reachable):

   ```sh
   npx tsx scripts/verify-domain-mx.ts --email security@assignee.ai
   ```

   This resolves MX for `assignee.ai` (the domain part of the address).

4. **Verify domain ownership**:

   ```sh
   npx tsx scripts/verify-domain-ownership.ts \
     --domain assignee.ai \
     --proof "assignee-verification=<token>"
   ```

   Expected output: `ok: true` with `found: true`.

5. **Verify app subdomain MX** (if the app subdomain uses its own mail
   configuration):
   ```sh
   npx tsx scripts/verify-domain-mx.ts --domain app.assignee.ai
   ```
   This may resolve to the parent domain's MX records depending on DNS
   configuration.

## Remediation on failure

### MX verification fails

```
verify-domain-mx: FAIL — no MX records for assignee.ai
```

Steps:

1. Log in to the DNS provider (currently Cloudflare — credentials in 1Password).
2. Confirm the MX records are present under the `assignee.ai` zone.
3. Standard Cloudflare settings: `assignee.ai MX 10 mx1.example.com`
4. Wait for DNS propagation (up to 48 hours for global propagation; usually
   minutes within the same region).
5. Re-run the script.

### Ownership proof not found

```
verify-domain-ownership: FAIL — proof string "assignee-verification=..." not found
```

Steps:

1. Log in to the DNS provider.
2. Add a TXT record at the apex: `assignee.ai TXT "assignee-verification=<token>"`
3. Wait for propagation.
4. Re-run the script.

### DNS error (ENOTFOUND / ESERVFAIL)

This indicates a network issue or the domain does not resolve at all.

1. Confirm the domain is registered and not expired:
   ```sh
   whois assignee.ai | grep -i expir
   ```
2. Confirm your nameservers are correctly configured:
   ```sh
   dig NS assignee.ai +short
   ```
3. If the domain is expired, renew immediately through the registrar.

## Running in CI

These scripts are intended as manual acquirer-run verification tools, not as
automated CI checks. They make real DNS calls which are non-deterministic and
slow — they would be flaky in CI.

For unit tests, the scripts export their core logic (`extractDomain`,
`resolveMxRecords`, `verifyOwnership`) with injectable resolver dependencies
so tests can mock DNS calls. See:

- `scripts/verify-domain-mx.test.ts`
- `scripts/verify-domain-ownership.test.ts`
