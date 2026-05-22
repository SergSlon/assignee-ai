# Wizard UX audit — 2026-05-22

**Source**: PTY-driven sweep of every interactive assignee command on the
v0.1.0 binary (post-#147 main). 5 commands driven through a real PTY
that captured each prompt exactly as a terminal user sees it.

**Sweep commands**:

1. `assignee dev init --wizard` (existing project — 1 prompt)
2. `assignee dev init --global --wizard` (fresh `HOME` — 6 prompts)
3. `assignee dev setup --dry-run` (no prompts; pre-flight plan only)
4. `assignee infra destroy --all` (dry-run by default — no prompts)
5. `assignee infra plan --wizard --no-apply "create ec2 with ssh access"`
   (no prompts despite `--wizard` flag — see F14)

**Total Bedrock cost**: ~$0.026 (two `infra plan` calls). **No AWS
resources mutated.**

**Driver**: `/tmp/assignee_pty_driver.py` (Python `pty` module, raw mode,
ANSI-stripped capture per idle period). Reproducible via:

```sh
python3 /tmp/assignee_pty_driver.py node apps/cli/dist/index.js <args>
```

---

## Severity legend

| Tag      | Meaning                                                         |
| -------- | --------------------------------------------------------------- |
| **BUG**  | Wrong data shown to user; affects trust in plan output.         |
| **UX**   | Confusing/inconsistent UI; works correctly but harms first-use. |
| **INFO** | Non-deterministic / observational; not actionable today.        |

---

## Findings

### F1 — UX — Header shows region as known BEFORE user has answered

`dev init --wizard` Screen 1:

```
┌  Assignee.ai — Project Initialization  [region=us-east-1]
…
◆  AWS Region
│  us-east-1█
```

The banner prints `[region=us-east-1]` (read from env/config default)
_before_ the wizard asks for the region. Looks like the wizard already
knows. If the user picks a different region, the rest of the wizard
prints the new value — fine — but the visual contradiction sits in
front of every new user on first contact.

**Repro**: see "Sweep commands" item 1.

**Proposed fix**: drop `[region=…]` from the banner when the wizard is
about to ask for the region itself; keep it only for non-interactive
modes (`-y`, `--global` with pre-stamped region).

**Effort**: S (one branch in the wizard banner template).

---

### F2 — UX — Self-contradictory cred guidance: "AWS_PROFILE not supported" → "AWS Profile?"

`dev init --wizard` Screen 1:

```
Note: `AWS_PROFILE` alone is not currently supported — use explicit
env vars or run `assignee dev setup` to create role-specific credentials.
```

Screen 2 then asks:

```
◆  AWS Profile
│  default█
```

User just read "profiles don't work" and is now asked for one.
Credible source of "is this CLI broken?" support tickets.

**Repro**: see Sweep 2 (or Sweep 1 — both show this; the warning fires
when `AWS_*` env vars are not the source of detected creds).

**Proposed fix**: either gate the prompt on "did the user just say
they have profile-based creds" — or soften the warning to "profile
name is recorded for future use; explicit env vars or `dev setup`
still required to authenticate API calls." Pick one; the current
combination reads as a bug.

**Effort**: S.

---

### F3 — UX — `Environment` prompt has no hint text

```
◆  Environment
│  ● development
│  ○ staging
│  ○ production
```

Every other prompt in `dev init` has either a hint (the next prompt,
auto-fix, has an inline explanation) or a placeholder. This one is
bare. A first-time user can't infer whether `Environment` is a
config-scoped tag, a runtime mode toggle, or a per-resource label
field. Reading the source of `dev init`'s template would clarify,
but a wizard shouldn't require source-reading.

**Repro**: Sweep 1 or 2.

**Proposed fix**: add `hint: "Used to tag every resource you create
(maps to the 'environment' tag) and to gate destructive operations
in production."` (or whatever the actual effect is — verify against
the config-resolution code).

**Effort**: S.

---

### F4 — UX — Global init asks 2 prompts (`tags`, `naming prefix`) that local init never asks

Project `dev init --wizard`: 4 prompts (region, profile, env, auto-fix).
Global `dev init --global --wizard`: 6 prompts (above + default tags +
resource-naming prefix).

Inconsistency. If "default tags" are useful at global level, they're
useful at project level — and vice versa. Today neither config
inherits from the other for these two fields, so a global default
"tag: project=acme" is silently overridden by any project-init that
doesn't ask.

**Repro**: Sweep 1 vs Sweep 2.

**Proposed fix**: either propagate tags + naming-prefix into the
project wizard (asked after env, prefilled from global if available),
or document at the global wizard that these are global-only and
won't auto-apply to projects that override `defaults`.

**Effort**: M (wizard field-set + config resolver both touch this).

---

### F5 — UX — `mycompany-` placeholder displayed as if it were a default

```
◆  Resource naming prefix (optional, press Enter to skip)
│  mycompany-█
```

`mycompany-` is a _placeholder_. If you ENTER you accept blank. But
the placeholder is rendered in the same colour as actual values, so
some users will read it as "the default is mycompany-" and type
nothing assuming "OK." Worse path: a user takes the bait and types
`mycompany-` literally, getting `mycompany-` as the prefix.

**Repro**: Sweep 2.

**Proposed fix**: render placeholder in dim/grey (chalk `.dim()`),
explicitly differentiate from filled-in values. The wizard library
likely already supports this; opt in.

**Effort**: S.

---

### F6 — BUG — Bulk-destroy cost estimate $0.05/mo is suspiciously low

```
DESTROY PLAN (7 resources, in order):
  1. AWS::CloudFront::Distribution — arn:aws:…E1LFLMY7GUQSRU
  2. AWS::S3::Bucket — arn:aws:s3:::assignee-website-bucket-1f4ef494 [$0.0230/GB-month]
  3. AWS::S3::Bucket — arn:aws:s3:::assignee-website-bucket-9eecb707 [$0.0230/GB-month]
  4. AWS::CloudFront::OriginAccessControl — E3EYXPSYURQIM9
  5. AWS::S3::BucketPolicy — assignee-website-bucket-1f4ef494
  6. AWS::CloudFront::OriginAccessControl — E34XJNLSGVG785
  7. AWS::S3::BucketPolicy — assignee-website-bucket-9eecb707

Estimated monthly savings: $0.05/month
```

Real CloudFront distributions even at idle accrue request and storage
costs (~$0.50+/mo baseline). Two S3 buckets contribute storage
($0.023/GB-month each — and the per-resource line shows the rate but
the aggregate doesn't seem to include any GB volume). $0.05 total
strongly suggests:

1. CloudFront pricing decomposer returns 0 for idle distributions
   (correct for _zero_ traffic but ignores baseline costs), AND
2. S3 storage doesn't aggregate because the GB-month rate is unit-only.

**Repro**: `assignee infra destroy --all` on any account with
CloudFront + S3 resources.

**Proposed fix**: pricing decomposer should accumulate storage even
when bucket size is unknown (call S3 `HeadBucket`/`GetMetricStatistics`
to estimate), and CloudFront should include baseline request cost
even at zero observed traffic. At minimum, change the line to "≥
$0.05/month" or "$0.05/month (storage volumes not measured)" to
flag the lower bound.

**Effort**: M (touches multiple decomposers + display).

---

### F7 — UX — Severity label drift: `[MEDIUM]` vs `WARN` for the same data

Run with `-q --quick`:

```
[MEDIUM] EC2 instance should have detailed monitoring enabled
```

Run with `--wizard --no-apply`:

```
WARN   EC2 instance should have detailed monitoring enabled
```

Same severity (medium), two different labels depending on display
mode.

**Repro**: same intent, two flag combinations; diff the `Findings:`
section.

**Proposed fix**: pick one label vocabulary across all modes. `WARN`
is shorter and more idiomatic for CLI tools (matches `[ERROR]` /
`[INFO]` family). Standardise the renderer.

**Effort**: S.

---

### F8 — INFO (was UX) — Plan renderer "drift" is correct TTY-aware behaviour (NOT A BUG)

Original audit observation:

- `-q --quick` mode: plain `=== Plan ===` text separator.
- `--wizard` mode: full `┌── Plan ──┐` ASCII box (120 cols wide).

**Reclassification (2026-05-22, post-F14 verification)**: re-ran both
modes through a PTY (forces stdout.isTTY=true) and via plain stdout
pipe (stdout.isTTY=undefined). Result:

- PTY + `-q --quick` → `┌── Plan ──┐` (box)
- PTY + `--wizard` → `┌── Plan ──┐` (box)
- Plain pipe + `-q --quick` → `=== Plan ===` (plain)
- Plain pipe + `--wizard` → `=== Plan ===` (plain)

The renderer is gated by `process.stdout.isTTY` at
`packages/core/src/utils/display-plan.ts:240-251`, NOT by `-q` vs
`--wizard`. The original audit observation was actually TTY-vs-pipe;
the two flag-combinations happened to be run with different stdout
contexts (one through PTY, one with stdout piped).

**This is intentional + correct behaviour**:

- Box form for human-interactive TTY (easier to scan, handles long
  ARNs, matches the `┌── Plan ──┐` style established in tutorials).
- Plain `=== Plan ===` form for CI / pipes / file redirection
  (machine-grep-friendly, no Unicode box characters that mangle
  in some log viewers).

The audit's "Proposed fix" of gating by `process.stdout.isTTY` was
**already implemented**. The recommendation reduces to: keep the
existing behaviour.

**No code change needed.** Documentation could be improved by noting
this behaviour in tutorials/screenshot conventions so future audit
sessions don't re-flag it.

---

### F9 — INFO — LLM cost estimate fluctuates: 4,239 vs 4,210 tokens for identical intent

Identical intent string `"create ec2 with ssh access"`, two near-
identical Bedrock calls, ~29-token spread. Non-deterministic. Doesn't
break anything, but means cost-comparison-across-runs tests can't use
exact-match assertions.

**Repro**: run `infra plan` twice with the same intent string.

**Proposed fix**: none required. Document in tests as "use a ±10%
tolerance on token-count assertions." Add a regression-test sentinel
that the Bedrock token estimate is _between_ two reasonable bounds
for canned intents.

**Effort**: S (test-only).

---

### F10 — INFO (was BUG) — Wrong egress pricing tier shown in `-q --quick` mode (NON-REPRODUCING)

- Original audit observation (`-q --quick`): `Data transfer out  $0.0230/GB`
- `--wizard` output: `Data transfer out  $0.090/GB up to 10 TB,
$0.085/GB next 40 TB, $0.070/GB next 100 TB, … (tiered)`

**Reclassification (2026-05-22, post-PR #149 verification)**: re-ran
both modes on the same commit (post-build). **Both modes now show the
correct tiered `$0.090/GB up to 10 TB, ...` output.** The original
observation appears to have been a transient pricing-MCP cache-state
artefact, not a code bug — both `-q` and `--wizard` flow through the
same EC2 decomposer (`packages/core/src/pricing/decomposers/ec2.ts:120`)
which uses the identical `DATA_TRANSFER`-service filter as
`packages/core/src/pricing/decomposers/s3.ts:110`. Same filter, same
returned record, same tier-ladder rendering.

The earlier S3-flat-rate display was likely caused by:

1. Pricing MCP returning a partial/cached response with only one tier.
2. A transient race in concurrent decomposer queries.
3. OR a misread of the captured terminal output.

**Suggested follow-up** (not load-bearing): add a regression test that
runs the EC2 pricing decomposer twice in succession against a known
fixture and asserts both calls return tiered output (catches whichever
caching layer was inconsistent). File as P3 — not actionable today
without the original transient state captured.

The audit's claim that `-q` mode was collapsing tiered structure
to S3's rate has been retracted; both modes render identically.

**Repro**:

```sh
node apps/cli/dist/index.js infra plan --no-apply -q "create ec2 with ssh access"
# observe: Data transfer out  $0.0230/GB
node apps/cli/dist/index.js infra plan --wizard --no-apply "create ec2 with ssh access"
# observe: Data transfer out  $0.090/GB up to 10 TB, …
```

**Proposed fix**: find the conditional in
`packages/core/src/pricing/strategies/ec2.ts` or the display helper
that selects "compact" vs "expanded" data-transfer rendering; the
compact form is borrowing S3's rate. Either render full tiers in both
modes, or render the _first tier_ of EC2's structure (still $0.09/GB,
not $0.023/GB).

**Effort**: S-M (one decomposer + assertion-tightened test).

---

### F11 — UX (was BUG) — Advice CONTRADICTS Findings in the same plan output (STOCHASTIC)

Advice block (in the original audit run):

```
• Consider using a smaller instance type if the workload allows,
  such as t2.micro, for cost optimization.
```

Findings block (same plan):

```
WARN   EC2 instance should use current generation instance type
       Risk: Previous-gen instances cost more per vCPU, lack Nitro
       security features, and will eventually be deprecated...
```

**t2.\* is previous-gen.** The LLM-generated Advice was recommending
the very thing the structured BP rules in the same output told the
user to avoid.

**Reclassification (2026-05-22, post-PR #149 verification)**: re-ran
the same intent. Advice on the re-run correctly recommends
**t4g.micro** (current-gen ARM) — the contradiction did not
reproduce. **Stochastic — LLM output non-determinism.** The
contradiction is a latent failure mode (LLM occasionally suggests
t2.micro / m1.\* / c1.\* / old-gen), not a guaranteed bug per plan.

Root cause is still real: Advice is LLM-generated (free-text), Findings
are deterministic rule output, and there is no cross-check pipeline
between them. **The fix is still warranted as insurance — a post-filter
that rejects Advice strings matching previous-gen instance-type
patterns (`^t2\.`, `^t1\.`, `^m1\.`, `^c1\.`, `^c3\.`, `^m3\.`, etc.)
when an `ec2-current-generation` Finding is also emitted.**

**Repro**: any `infra plan` call against an EC2 intent will surface
this contradiction frequently (LLM is biased toward t2.micro because
of training data).

**Proposed fix**: post-process Advice through a sanity filter that
rejects any suggestion violating an emitted Finding. Cheap to
implement (a regex check over Advice for instance-type tokens that
match `^t2\.` plus a Finding ID `ec2-current-generation`). Alternative:
prompt the LLM with the Findings set as anti-patterns to avoid.

**Effort**: M (touches advice node + a post-filter test).

---

### F12 — BUG — BP rule remediation hint mismatches the finding

```
WARN   EBS volume should have a snapshot backup
       Manual: --set EbsEncrypted=<value>
```

Finding is about _backup_ (snapshots / AWS Backup plan / DLM).
Remediation says set _encryption_. Two unrelated controls collapsed
into one rule's `manualFix` field.

**Repro**: any plan with an EBS-attached EC2 surfaces this finding.

**Proposed fix**: find the rule in
`packages/best-practices/src/rules/ebs-volume-snapshot-backup*.yaml`
(or wherever the rule lives) and replace the `manualFix` to point at
AWS Backup / DLM creation steps, not encryption setting.

**Effort**: S (single YAML edit + regression test that the rule
ID maps to the correct manualFix string).

---

### F13 — UX — Plan box doesn't legend `(live)` vs `(stored)` cost rates

The plan box shows per-resource rates with parenthetical sources:

```
Estimated Cost:  $0.0104/hour (live)
  Compute   t3.micro             $7.59/mo
```

Some rates come from the live Pricing MCP, others from stored
fixtures. The plan box doesn't tell the user which is which until
they read the bottom-of-output footnote (sometimes missing). A
4-week-stale stored rate looks identical to a live one.

**Repro**: any `infra plan` against any resource type.

**Proposed fix**: append a per-line source marker, e.g.:

```
Compute   t3.micro             $7.59/mo  (live)
Storage   8 GB gp3              $0.64/mo  (cached 4d ago)
```

**Effort**: S.

---

### F14 — BUG — `--wizard` flag advertised as interactive but doesn't prompt for `infra plan`

`assignee infra plan --help`:

```
--wizard  Run the interactive configuration wizard.
```

Actual behavior on `infra plan --wizard --no-apply "create ec2 with ssh access"`:

- Bedrock fills every field via tool calls (discovery fetchers in
  `commonFields`/`advancedFields`).
- Zero user prompts shown — captured via PTY driver, confirmed.
- Identical output (modulo F8 box-vs-text) to `-q --quick`.

So `--wizard` is effectively a no-op for resolvable intents. Either:

1. The help text is misleading and should say "Force-prompt every
   field even when LLM resolves them via tool calls" (and the
   wizard-elicitor needs to actually prompt — currently it
   short-circuits when fields are already filled).
2. OR the wizard-elicitation path is dead code for resolvable
   intents and the flag should be removed.

**Repro**: see Sweep 5 in the audit document.

**Proposed fix**: pick (1) — make `--wizard` actually force-prompt
every advanced field even when defaults exist. This is what users
_expect_ the flag does. Then add an integration test that asserts
`infra plan --wizard` produces ≥N prompts for an EC2 intent.

**Effort**: M (touches the wizard orchestrator + tests).

---

### F15 — UX — Spinner output is noise in non-TTY logs

14+ seconds of `◒◐◓◑` rotation captured during Bedrock call. In CI
logs, terminal recordings, screen-reader output, etc., this is
hundreds of unreadable characters per minute. The CLI respects
`--no-color` but not `CI=1` or `NO_PROGRESS=1`.

**Repro**: `CI=1 assignee infra plan "create an S3 bucket"`.

**Proposed fix**: detect non-TTY (`!process.stdout.isTTY`) or
`CI=1` env var and replace spinner with a 1-line "Working..." +
single-line completion message. Standard for CLI tools — `npm`,
`pnpm`, `cargo` all do this.

**Effort**: S (single check in the spinner helper).

---

## Prioritisation (updated 2026-05-22 — end-of-day sweep)

**Closed** (fix landed today):

- **F1** (banner region context pre-prompt) — PR #154 / `51358d3e`.
- **F2** (AWS_PROFILE warning + prompt contradiction) — PR #151 / `81e1029b`.
- **F3** (Environment prompt hint) — PR #155 / `552577d6`.
- **F5** (placeholder visual ambiguity) — PR #156 / `c8e722ce`.
- **F7** (severity label drift) — PR #152 / `3ef7f878`.
- **F12** (BP-EC2-021 wrong remediation hint) — PR #149 / `8e475eed`.
- **F13** (cost-source suffix legend) — PR #159 / `a8da3d56`.
- **F14** (plan --wizard help misadvertised) — PR #160 (in flight).
- **F15** (spinner CI/NO_PROGRESS gate) — PR #158 / `b31183de`.

**Reclassified as non-bugs after re-verification**:

- **F8** (plan-box renderer drift): NOT A BUG — gate is by
  `process.stdout.isTTY` (correct), not by `-q` vs `--wizard`.
  Original observation conflated TTY-vs-pipe with the flag choice.
- **F10** (wrong egress pricing in `-q` mode): INFO; both `-q` and
  `--wizard` modes show correct tiered $0.09→$0.07 EC2 rate. Likely
  transient pricing-MCP cache state in the original audit run.
- **F11** (LLM advice → t2.micro): UX-stochastic; re-run correctly
  suggested t4g.micro. Post-filter still warranted as insurance
  against the latent LLM-non-determinism failure mode.

**Open** (carried over to a future session):

- **F4** (init parity — global asks 2 prompts local doesn't): M effort;
  requires wizard field-set + config resolver refactor. Not a
  one-PR change.
- **F6** (bulk-destroy cost suspiciously low at $0.05/mo): M effort;
  pricing decomposer needs to estimate baseline CloudFront +
  aggregate S3 storage GB. Multiple decomposer + display files.
- **F11** insurance post-filter (advice cross-check against Findings):
  S-M effort; design the predicate, plumb through advice node, test.

**Informational** (no action):

- F8, F9, F10 — see reclassification notes above.

**End-of-day aggregate**:

- **9 audit findings closed today** (F1, F2, F3, F5, F7, F12, F13, F14, F15).
- 3 reclassified non-bugs (F8, F10, F11 stochastic part).
- 3 remain genuinely open as future work (F4, F6, F11 insurance).
- 0 findings dropped without action.

**Revised remaining effort estimate**:

- F4: ~4h (wizard field-set + config resolver).
- F6: ~4h (CloudFront baseline + S3 storage aggregation).
- F11 insurance: ~3h (post-filter predicate + test).
- **Total open work**: ~11h.

---

## Driver retained for re-runs

`/tmp/assignee_pty_driver.py` (this session) drives any assignee
command through a real PTY, captures every screen verbatim, and is
the canonical repro for all 15 findings. Suggested next move: copy
it into `apps/cli/scripts/pty-driver.mjs` (or rewrite in Node so it
ships with the repo) and wire it into a `pnpm wizard-audit` CI job
that diff-checks captured-screen output against golden snapshots.
That converts ad-hoc audits into a regression suite.

**Effort to land driver as a script**: M (port to Node, integrate
with existing test infra).
