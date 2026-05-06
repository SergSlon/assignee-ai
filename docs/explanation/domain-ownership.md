# Domain Ownership and MX Verification — design reference

> **Status for this build.** This document describes a verification pattern
> for future productisation. It is **not active for this course-submission
> build** — the `assignee.ai` and `app.assignee.ai` domains are not
> registered, no DNS records exist, no `security@assignee.ai` mailbox is
> reachable, and no domain-transfer process is in flight. The verification
> scripts and step-by-step flow below are kept as a design reference for
> the day a real domain is registered; treat the prose as a sketch, not as
> live operations documentation.

This document describes a domain ownership and mail-exchange verification
pattern for `assignee.ai` and `app.assignee.ai`. If the project later
registers those domains, these scripts would be re-runnable to confirm
the domain is under the expected team's control and that
`security@assignee.ai` is reachable.

## Domains in scope (hypothetical)

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

> The scripts are wired up but produce `ENOTFOUND`/`ESERVFAIL` against the
> unregistered `assignee.ai` domain today. They are documented here as
> design reference, not as live operational tooling.

## Ownership proof string

The ownership proof would be a TXT record placed in DNS by the current
domain owner. The format is:

```
assignee-verification=<opaque-token>
```

The `<opaque-token>` is a secret string generated at registration time and
held by the current maintainer. There is no shared credential vault for
this course-submission build.

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
   from a secure store (the specifics depend on the owning team's tooling).

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

1. Log in to the DNS provider used by the domain.
2. Confirm the MX records are present under the `assignee.ai` zone.
3. Wait for DNS propagation (up to 48 hours for global propagation; usually
   minutes within the same region).
4. Re-run the script.

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

This is the expected response in the current build because the domain is
not registered. If the project later registers the domain and a real
verification still returns this error, it indicates a network issue or a
genuinely missing DNS record:

1. Confirm the domain is registered and not expired:
   ```sh
   whois assignee.ai | grep -i expir
   ```
2. Confirm your nameservers are correctly configured:
   ```sh
   dig NS assignee.ai +short
   ```
3. If the domain is expired, renew through the registrar.

## Running in CI

These scripts are intended as manual verification tools, not as automated
CI checks. They make real DNS calls which are non-deterministic and slow —
they would be flaky in CI.

For unit tests, the scripts export their core logic (`extractDomain`,
`resolveMxRecords`, `verifyOwnership`) with injectable resolver dependencies
so tests can mock DNS calls. See:

- `scripts/verify-domain-mx.test.ts`
- `scripts/verify-domain-ownership.test.ts`
