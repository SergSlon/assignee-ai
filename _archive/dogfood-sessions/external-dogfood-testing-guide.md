# External Dogfood Testing Guide (RR-10)

**Audience**: an external tester (not the project owner) running
their first end-to-end Assignee.ai session against their own AWS
account.

**Time**: ~30 minutes, including AWS resource teardown.
**AWS cost**: < $5 if you stick to the documented patterns. Most
test resources cost cents; the only thing that can accidentally cost
real money is a NAT Gateway, which the CLI flags loudly in the cost
preflight before you approve apply.

---

## 0. Before you start

You need:

- An **AWS test account** you own (NOT a production account). The
  CLI creates IAM users + provisions real resources.
- **AWS CLI** v2 installed locally with credentials configured
  (`aws configure` or SSO).
- **Node.js** v20.11 or higher (`node --version`).
- **pnpm** v10.x (`pnpm --version`) or **npm** v10.x (if the package
  ships to npm; otherwise you'll be running from the cloned repo).
- ~30 minutes of focused time.

You'll need to fill out a sign-off template at the end —
`external-dogfood-template.md` — so keep it open.

If you hit any blocker, **stop and ping the project owner directly**.
The session is not graded on flawless completion; it's graded on
honest first-run UX signal.

---

## 1. Clone + install

```bash
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install
pnpm build
```

Note your wall-clock time to first successful `pnpm build`. The
sign-off asks for "time to first plan" — that count starts here.

## 2. Setup IAM users in your AWS account

```bash
./apps/cli/dist/index.js dev setup
```

(If npm-installed: `assignee dev setup`.)

This command creates 3 IAM users in your AWS account:

- **AssigneeOperator** (write permissions for the 38 supported
  resource types)
- **AssigneeReader** (read permissions for the same surface)
- **AssigneeAuditor** (CloudTrail + audit-log permissions)

It prints 3 pairs of access keys + secret keys. Save them to a
local `.env` file at the repo root or export them to your shell:

```
ASSIGNEE_OPERATOR_ACCESS_KEY_ID=AKIA...
ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=...
ASSIGNEE_READER_ACCESS_KEY_ID=AKIA...
ASSIGNEE_READER_SECRET_ACCESS_KEY=...
ASSIGNEE_AUDITOR_ACCESS_KEY_ID=AKIA...
ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1   # or wherever your test account is
```

**SSO alternative**: if you use AWS SSO, you can skip the 3-user
setup and use `AWS_PROFILE=<your-sso-profile>` instead. The CLI
falls through to the default AWS credential chain.

## 3. Health check

```bash
./apps/cli/dist/index.js admin doctor
```

Should print 9 green checks. If any fail, screenshot + ping the
project owner. The most common first-time miss: forgot to set
`AWS_REGION`.

## 4. Run your first plan

Pick ONE of these intents (or write your own — anything in the 38
supported types):

| Difficulty | Intent                                                                                            | Expected resources                                                     |
| ---------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Easy       | `"Create an S3 bucket called my-test-bucket-1 with versioning"`                                   | 1 S3 bucket                                                            |
| Easy       | `"Create an SNS topic for email notifications"`                                                   | 1 SNS topic + 1 subscription                                           |
| Medium     | `"Create a Lambda function that returns hello world, runtime nodejs20.x"`                         | 1 Lambda + 1 IAM role                                                  |
| Medium     | `"Create a 3-tier web app with S3 static hosting, Lambda backend, and CloudFront distribution"`   | ~6-8 resources                                                         |
| Hard       | `"Create a VPC with 2 public subnets, 2 private subnets, an internet gateway, and a NAT gateway"` | ~10 resources including the NAT (~$30/month if you forget to destroy!) |

Run:

```bash
./apps/cli/dist/index.js infra plan "<your intent>"
```

The plan box should appear within ~15 seconds. **Read the
estimated-monthly-cost line BEFORE doing anything else** — this is
where the CLI's value proposition lives.

Take note of:

- How long did the plan take?
- Did the cost number make sense to you?
- Was anything confusing in the plan box?
- Did any best-practice advisories surface that you'd actually want
  to act on?

## 5. (Optional) Apply

If the plan looks sensible:

```bash
./apps/cli/dist/index.js infra apply
```

This walks you through any wizard prompts + actually provisions
the resources. You can decline by hitting Ctrl-C at any prompt.

If you applied, take note of:

- How long did apply take?
- Did the order of operations make sense?
- Did the post-apply summary tell you what you needed to know to
  start using the resource?

## 6. (Mandatory) Cleanup

Before signing off, run:

```bash
./apps/cli/dist/index.js infra destroy --all
```

This sweeps every resource the session created (matched via tags +
the in-session run-ID). Confirm at the prompt. **Do NOT pass
`--yes --no-confirm`** for the dogfood session — we want to see
that the confirmation gate works.

If destroy leaves anything behind:

- Run `./apps/cli/dist/index.js admin list` to see what's still
  there.
- Manually delete in the AWS Console.
- **Note this in the sign-off** — it's exactly the kind of feedback
  that's most valuable to me.

## 7. Sign-off

Copy `external-dogfood-template.md` to a new file (use your handle

- today's date in the filename) and fill in every field:

* **Date**: today
* **Tester handle**: your GitHub username or a pseudonym you're OK
  with appearing in the v1.0 CHANGELOG
* **Setup environment**: macOS / Linux / WSL + node + pnpm versions
* **Intent tested**: the exact string you ran
* **Output observed**: paste the plan box + any apply output.
  **Redact any real AWS account IDs to `112233445566`** — the
  project repo has a pre-commit hook that rejects real account IDs.
* **First-run UX rating** (1–5): honest. 1 = "I gave up", 5 =
  "shipped this already, what's next".
* **Blockers encountered**: anything that stopped you, ANY error
  message that wasn't self-explanatory, anywhere you had to consult
  docs to recover.
* **Recommended next test**: a follow-on intent that builds on yours.
* **Tester acknowledgment**: a one-line quote confirming you ran the
  command end-to-end and the output was usable.

Send the filled-in file back to the project owner. They'll commit it
to `_archive/dogfood-sessions/` + flip RR-10 in the release checklist.

## Questions / live help

The project owner is available for live questions during your
session. Direct contact: <fill in before sending>.

If you hit a real blocker that you can't recover from, that's
**valuable signal** — write it up honestly. Don't grind through
something the CLI should have made easy.

## What we're optimising for

The dogfood session's goal isn't "successful plan + apply." It's
**honest first-run UX feedback** from someone who hasn't built this
tool. The most valuable sign-offs are the ones that surface friction
the project owner is too close to see anymore.

Thanks for taking the time. <name in v1.0 CHANGELOG> 🚀
