# Contributing a best-practice rule — a worked example

> Diátaxis: **explanation** (understanding-oriented). A narrative
> walkthrough of the BP-rule contribution flow, end to end. For the
> contribution reference, see the
> [`CONTRIBUTING.md § Contributing a Best-Practice Rule`](../../CONTRIBUTING.md#contributing-a-best-practice-rule)
> section.

## Why BP rules exist

Every `assignee plan` evaluates the user's desired state against the
rules shipped in [`packages/best-practices/`](../../packages/best-practices/).
A rule that fires turns into a finding in the plan box — severity-sorted,
with a remediation hint, and (when `autoFixable: true`) an auto-applied
patch before the typed-name confirm.

Rules are YAML, not code. That's deliberate: we want the rule surface
to be data that anyone can audit. The TypeScript runtime under
`packages/best-practices/src/` is the loader, validator, and evaluator —
all ~300 LOC combined. The _policy_ is in the YAML.

## Worked example: "EFS file systems must enforce KMS encryption at rest"

Imagine you just noticed that
[AWS::EFS::FileSystem](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-efs-filesystem.html)
creates an unencrypted file system by default unless you explicitly set
`KmsKeyId`. That's a security gap — you want Assignee to block it at
plan time.

### Step 1 — Verify the gap isn't already covered

```bash
ls packages/best-practices/efs/
```

At the time of writing, `efs/` contains `BP-EFS-001.yaml` through
`BP-EFS-009.yaml`. None of them checks `KmsKeyId`. Good — the rule slot
is open. Pick the next free number: `BP-EFS-010`.

### Step 2 — Write the rule

Drop a new file at `packages/best-practices/efs/BP-EFS-010.yaml`:

```yaml
id: BP-EFS-010
title: "EFS file system should enforce KMS encryption at rest"
severity: CRITICAL
resource_type: "AWS::EFS::FileSystem"
property_path: "KmsKeyId"
check_type: "exists"
expected_value: true
source: "AWS Well-Architected Security Pillar"
source_id: "SEC 8"
description: "Encrypted EFS file systems protect data at rest with a customer-managed KMS key. Without KmsKeyId the file system is unencrypted even if Encrypted=true is set — Encrypted=true alone uses the AWS-managed key, which does not meet Well-Architected SEC 8."
remediation: "Set KmsKeyId to the ARN of a customer-managed KMS key (e.g. arn:aws:kms:<region>:<account>:key/<id>) before creating the file system."
consequence: "A KMS-key-less EFS allows anyone with file-system-level access to read every stored byte in plaintext."
category: security
lastVerified: "2026-04-16"
autoFixable: false
```

Why the fields are what they are:

- **`id`** — `BP-EFS-010` matches the naming regex and continues the
  service sequence. See
  [`src/schema.ts`](../../packages/best-practices/src/schema.ts)
  for the regex.
- **`severity: CRITICAL`** — unencrypted-at-rest data is a data-breach
  precondition. Anything lower would underplay it.
- **`check_type: "exists"` + `expected_value: true`** — this is the
  idiomatic way to say "this field must be set." See
  [`packages/best-practices/src/evaluate.ts`](../../packages/best-practices/src/evaluate.ts)
  for every check type the engine recognises.
- **`lastVerified`** — the ISO date you re-read the AWS doc. Rule
  maintenance sweeps look at this field; stale rules trigger warnings
  in `assignee doctor`.
- **`autoFixable: false`** — there is no universal "correct" KMS key
  to auto-inject. The remediation depends on the customer's key
  hierarchy. Leave auto-fix off and let the user choose the key.

### Step 3 — Regenerate the manifest

```bash
pnpm --filter=@assignee/best-practices run generate-manifest
```

This updates
[`packages/best-practices/manifest.json`](../../packages/best-practices/manifest.json)
— a SHA-256 hash of every rule file, used at release time to detect
drift. If you skip this step, CI fails on `manifest-freshness.test.ts`.

### Step 4 — Validate locally

```bash
pnpm --filter=@assignee/best-practices build
npx tsx packages/best-practices/scripts/validate.ts
```

Expected output:

```
✓ BP validation passed (186 rules, manifest OK)
```

The count above (`186`) reflects the post-contribution total — i.e., the
current 185 rules plus the new `BP-EFS-010` you just added. If you add
multiple rules in one PR the count grows accordingly.

If the script finds a schema violation it prints `<file> [<rule-id>]:
<reason>` and exits 1. Common failures:

- **`Schema: id: ... BP ID must match format BP-{SERVICE}-{NNN}`** —
  your `id` has the wrong shape (lowercase, missing the service
  segment, or the number isn't 3 digits).
- **`Schema: severity: ... Invalid enum value`** — you typed
  `severity: WARNING` or similar. Only the four members of
  `BP_SEVERITY` are allowed.
- **`Manifest hash drift: …`** — you forgot step 3.

### Step 5 — Add an evaluation fixture

Rules that exist without a fixture test are easy to break silently. Add
a case to
[`packages/best-practices/__tests__/evaluate.test.ts`](../../packages/best-practices/__tests__/evaluate.test.ts)
or a new fixture file under `__tests__/fixtures/` showing:

- **Triggers on bad state** — an EFS file system with no `KmsKeyId`
  produces a finding.
- **Stays silent on good state** — the same file system with a valid
  `KmsKeyId` does not produce a finding.

Run the targeted test:

```bash
pnpm --filter=@assignee/best-practices test -- evaluate
```

### Step 6 — Run the full package suite

```bash
pnpm --filter=@assignee/best-practices test
```

Every test must pass, including:

- `validate-bp-rules.test.ts` — schema conformance + uniqueness.
- `manifest-freshness.test.ts` — on-disk manifest matches the live tree.
- `seed-rules.test.ts` / `bp-all-rules-audit.test.ts` — policy-level
  audits that also check your rule.

### Step 7 — Open the PR

Use [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)
— check the "BP rule" type-of-change box, list `BP-EFS-010` in the rule
ID section, link the Well-Architected pillar, and attach a short
`assignee plan` transcript showing the finding fire.

## What happens after merge

- CI rebuilds the manifest hash. Consumers of `@assignee/best-practices`
  pick up the rule on the next install.
- The CLI `assignee doctor` command reports the new rule count and the
  refreshed manifest hash.
- On the next `assignee plan` run, the rule evaluates automatically —
  no plumbing required. That's the design: **rules are data, not code**.

## Design rationale

The three things that make the BP-rule library extensible:

1. **Pure YAML surface.** No TypeScript boilerplate means non-TypeScript
   contributors (security engineers, compliance teams) can land rules.
2. **Validation at PR time.** `manifest-freshness.test.ts` +
   `validate-bp-rules.test.ts` run under `pnpm test` in CI — broken
   rules never reach main.
3. **SHA-256 manifest instead of signed artifacts.** [Story 50-3](../../_bmad-output/implementation-artifacts/_archive/done-stories/)
   cut GPG signing as supply-chain theatre. An in-tree SHA-256 manifest
   - git history is enough provenance for an MIT-licensed OSS rule
     library; consumers with stronger threat models can re-sign at
     package time.

See [`docs/explanation/oss-vs-saas.md`](./oss-vs-saas.md) for the
contribution-first positioning: the community BP library is the
long-term moat, not the current 185 rules.
