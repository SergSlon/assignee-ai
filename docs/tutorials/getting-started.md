---
kind: tutorial
---

# Getting started with assignee

Welcome. In the next ten minutes you'll create your first AWS resource
with assignee — a single S3 bucket — verify it exists, and then destroy
it cleanly so nothing lingers in your account.

This is a **tutorial**, not a reference: every step is a real command
you'll type, and the goal is for you to feel "I made that thing happen"
by the end. We'll point at the deeper docs as we go.

---

## What you'll build

A single Amazon S3 bucket created from a one-sentence English
description, applied against your AWS account, then destroyed. By the
end you'll know the rhythm of every assignee session: **plan → apply →
destroy**.

You will:

1. Initialize a new assignee project.
2. Plan an S3 bucket from natural language.
3. Apply the plan to your AWS account.
4. Verify the bucket with the AWS CLI.
5. Destroy the bucket.

---

## Prerequisites

You need:

- An **AWS account**. If you don't have one, start at
  [aws.amazon.com](https://aws.amazon.com/free/) — the free tier covers
  this tutorial at zero cost.
- **AWS credentials configured** so the AWS CLI works. If you've never
  done this before, follow [`../aws-bootstrap.md`](../aws-bootstrap.md)
  first; it sets up the IAM users assignee uses. You can also use
  `aws configure` with an admin profile.
- **Node.js 20.11 or later** and **pnpm 9 or later**. Check with
  `node --version` and `pnpm --version`.
- A working terminal you can paste commands into.

---

## Step 1 — Install assignee

assignee.ai is a course-submission project (no npm publication; workspace
packages are `"private": true`), so you'll build it from source:

```bash
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install
pnpm build
pnpm link --global
```

Verify the binary is on your `PATH`:

```bash
assignee version
```

You should see a version banner. If `assignee` isn't found, see the
linking notes in [`../how-to/quickstart.md`](../how-to/quickstart.md).

Confirm assignee can talk to AWS and Bedrock:

```bash
assignee doctor --short
```

A green check means you're ready. Red lines tell you exactly what to
fix (missing region, missing Bedrock access, expired credentials).

---

## Step 2 — Initialize a project

Make a fresh working directory and run `init`:

```bash
mkdir my-first-assignee && cd my-first-assignee
assignee init
```

The wizard asks a few questions (region, default tags, auto-fix mode)
and writes `.assignee/config.yaml`. Accept the defaults — you can
change them later. This file scopes all subsequent commands to this
project.

---

## Step 3 — Plan your first resource

Pick a unique bucket name. S3 bucket names are **globally unique**
across all of AWS, so add a random suffix:

```bash
assignee plan "create an S3 bucket called my-tutorial-bucket-$RANDOM"
```

assignee will:

- Parse your sentence into a resource type (`AWS::S3::Bucket`) and a
  bucket name.
- Fetch the CloudFormation schema for S3 buckets.
- Generate a desired-state JSON with safe defaults.
- Run the full best-practice rule set — encryption, public-access blocking,
  versioning — and auto-fix the fixable ones. (Exact rule count is a
  runtime SSOT — see `packages/best-practices/manifest.json`.)
- Estimate the monthly cost from real-time AWS pricing.
- Print a **plan box** showing every field, every finding, and the
  estimated cost. A checkpoint is saved under `~/.assignee/checkpoint-<runId>.json`.

Read the plan box. If a field looks wrong, you can re-run with
`--set key=value` to override, or pass `--quick` to accept all defaults.

---

## Step 4 — Apply the plan

When the plan looks right, apply it:

```bash
assignee apply
```

With no arguments, `apply` picks up the latest checkpoint, asks you to
confirm, and then provisions through AWS CloudControl API. You'll see:

- The plan box again.
- A `yes / no` confirmation prompt — type `yes`.
- Live status lines as CloudControl creates the bucket.
- A success summary with the resource ARN, tags, and a cost figure.

Behind the scenes, assignee polls the CloudControl API with exponential
backoff (starting at two seconds, capped at 60, with jitter) until the
resource reports `SUCCESS` or `FAILED`. The whole flow usually finishes
in under a minute for an S3 bucket.

---

## Step 5 — Verify the bucket exists

Confirm with the AWS CLI directly:

```bash
aws s3 ls
```

Your `my-tutorial-bucket-NNNN` shows up in the list. Congratulations —
you just provisioned AWS infrastructure from a sentence in English.

---

## Step 6 — Destroy the bucket

Tutorials shouldn't leave resources behind, and assignee makes cleanup
easy. Pass the resource ARN (the most reliable identifier) to `destroy`:

```bash
assignee destroy arn:aws:s3:::my-tutorial-bucket-NNNN
```

Replace `NNNN` with whatever suffix you picked. (Bare-name resolution
works for some resource types but not all; ARN form is the safe path.)
assignee prints a destroy box, asks you to confirm by typing the
resource name back, and then deletes the bucket via CloudControl.

Verify it's gone:

```bash
aws s3 ls
```

The bucket should no longer appear.

---

## What you learned

You now know the full assignee loop:

- **Plan** a resource from a one-sentence English intent.
- **Apply** the plan to AWS with one command.
- **Destroy** it just as cleanly when you're done.

That same loop scales from one S3 bucket to a full VPC with public and
private subnets — the only thing that changes is the sentence you
write.

### Next steps

- Try a **compound pattern**: `assignee plan "create a VPC with public
and private subnets"` provisions an entire networking stack in
  dependency order.
- Browse the [How-to guides](../how-to/) for task-specific recipes
  (SSO authentication, drift reconciliation, plan-box decoding).
- Skim the [Reference](../reference/) for every command flag, every
  supported resource type, and every config option.
- Read [Explanation](../explanation/) to understand the **why** —
  the LangGraph pipeline, the run-ledger design, the OSS/SaaS split.
- Curious about the architecture? [`../explanation/ai-architecture.md`](../explanation/ai-architecture.md)
  walks through what each LLM call does.
