# 5-minute live demo — Assignee.ai

> Capstone project for the _Generative AI for Developers_ course (April 2026)
> Author: **Serhii Liamin**

## Demo arc — what the audience sees

In five minutes the audience watches Mara (the target user) describe AWS infrastructure in plain English and get a real, tagged, cost-estimated AWS resource — with a human approval gate between every plan and every apply. The demo touches **9 of the deck's headline features** in this order:

1. Setup verification (`assignee doctor`)
2. Plain-English plan generation (LLM intent parsing → wizard → schema fetch)
3. Live cost preflight via AWS Pricing MCP
4. Best-practice rule findings + auto-fix
5. Human-in-the-loop approval gate
6. Real AWS Cloud Control provisioning (with `managed-by=assignee` tagging)
7. Local memory of provisioned resources (`assignee list`)
8. The compound-pattern expansion (multi-resource intent)
9. Safe destroy with typed confirmation

The static-website deploy of this very deck runs **before the demo** because CloudFront takes 5–10 minutes to fully provision; the deployed URL is shown live as proof that the same tool was used to ship the slide deck the audience is watching.

---

## Pre-demo setup (one-time, before the audience arrives)

### One-time alias

Put this in your shell profile so the live demo reads naturally:

```bash
alias assignee='node /Users/serhii_l/code/GenAi/assignee.ai/apps/cli/dist/index.js'
```

(Or run `pnpm setup && pnpm link --global` from inside `assignee.ai/` once and `assignee` lands on `$PATH`.)

### 1. Build the project

```bash
cd /Users/serhii_l/code/GenAi/assignee.ai
pnpm install
pnpm build       # compiles all 4 packages — ~30s on a fresh checkout, ~3s warm
```

### 2. Authenticate with AWS

Pick **one** of the two pathways. Most modern AWS Organizations use SSO:

**Option A — AWS SSO / Identity Center (recommended for orgs):**

```bash
aws sso login --profile assignee-admin
export AWS_PROFILE=assignee-admin
aws sts get-caller-identity   # sanity check — should return your admin ARN
```

**Option B — Long-term IAM keys (simplest for solo dev):**

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
aws sts get-caller-identity
```

### 3. Bootstrap the three IAM users (idempotent, ~30 seconds)

`assignee setup` creates the operator / reader / auditor IAM users in your AWS account, attaches least-privilege managed policies, and writes `.env` with the access keys. Re-runs are safe.

```bash
cd /Users/serhii_l/code/GenAi/assignee.ai
assignee setup --profile assignee-admin --yes
# OR if you are already in the right AWS profile / env:
# assignee setup --yes
```

After this, `.env` in the repo root contains:

```env
ASSIGNEE_OPERATOR_ACCESS_KEY_ID=AKIA...
ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=...
ASSIGNEE_READER_ACCESS_KEY_ID=AKIA...
ASSIGNEE_READER_SECRET_ACCESS_KEY=...
ASSIGNEE_AUDITOR_ACCESS_KEY_ID=AKIA...
ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY=...
```

`assignee` will read this file automatically.

### 4. Initialise the project config

```bash
cd /Users/serhii_l/code/GenAi/assignee.ai
assignee init --yes --region us-east-1 --auto-fix ask
```

This creates `.assignee/config.yaml`. Edit it to set the budget panic limit shown in slide 9 of the deck:

```yaml
# .assignee/config.yaml
defaults:
  region: us-east-1
preferences:
  auto_fix: ask
budget:
  monthly_limit_usd: 100 # demo 2 in the deck shows this gate firing
  warn_only: false
```

### 5. Verify the local environment

```bash
assignee doctor --short
```

Expected output:

```
Account:  ************
User ARN: arn:aws:iam::************:user/assignee-operator
Region:   us-east-1
Role:     operator (ASSIGNEE_OPERATOR_ACCESS_KEY_ID)
Config:   ./.assignee/config.yaml (loaded)
```

If any line is missing or red, fix it before the demo.

### 6. Deploy the slide deck as a static website (15-minute pre-demo step)

The compound `static-website` pattern provisions S3 + CloudFront + Origin Access Control + uploads the source directory in dependency order. CloudFront distribution propagation is the long part.

```bash
cd /Users/serhii_l/code/GenAi/assignee.ai

assignee apply \
  --source /Users/serhii_l/code/GenAi/presentation \
  --yes \
  "Create a static website for the GenAI capstone presentation"
```

Wait for the apply to finish (~10 minutes). The final line prints the CloudFront URL — copy it. During the live demo you will switch to the browser and load that URL. **Save it somewhere you can paste it from quickly.**

> **Why pre-deploy?** CloudFront's edge propagation can take 5–10 minutes, longer than the entire demo budget. Showing the already-deployed URL during the demo proves the tool works end-to-end without burning live time on edge propagation.

---

## Live demo — 5-minute script

| Time     | Command / action                                                                                   | What the audience sees                                                                                                                                                                                               |
| :------- | :------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0:00** | `assignee doctor --short`                                                                          | The 3-user IAM separation (operator role active), region, config file loaded — proves the cage is real.                                                                                                              |
| **0:30** | `assignee plan "Create an S3 bucket named genai-demo-logs-$(date +%s)"`                            | Intent parser classifies → CFN schema fetched → wizard prompts (defaults), accept all → BP rule findings shown with auto-fix offer → AWS Pricing MCP cost line → plan box rendered.                                  |
| **1:30** | Type `y` at the HITL gate                                                                          | Cloud Control API `createResource` runs; status poller renders the wait; success line includes ARN + `managed-by=assignee` tag.                                                                                      |
| **2:00** | `assignee list --json \| jq '.count, .resources[].arn'`                                            | Memory shows the bucket we just provisioned — proves `~/.assignee/memory/provisions.json` is real and queryable.                                                                                                     |
| **2:20** | `assignee plan --no-apply --quick "Create a static website for the demo deck"`                     | The compound dispatcher expands one intent into the multi-resource plan — S3 bucket + CloudFront distribution + Origin Access Control + S3 object uploads — without applying. Audience sees the expansion structure. |
| **3:30** | Switch to browser → paste the **pre-deployed** CloudFront URL                                      | The deck loads live from the URL. "This page was provisioned by the same compound pattern you just saw expanded."                                                                                                    |
| **4:00** | (Optional) Switch to Claude Code → ask "create an SQS queue for failed-message retries"            | Claude Code calls `plan_resource` via the local MCP server → operator sees the plan box → types `y` → bucket created. The MCP surface routes through the identical 14-step pipeline as the CLI.                      |
| **4:30** | `assignee destroy arn:aws:s3:::genai-demo-logs-...`                                                | Typed-name confirmation prompt → operator types the bucket name → real `deleteResource` call → bucket removed. `assignee list` afterwards shows it gone.                                                             |
| **5:00** | "Three takeaways: plain English in, real AWS resource out, with a human approval gate every time." | Closing slide with `Questions?` shown.                                                                                                                                                                               |

---

## Backup plans (if AWS or the network misbehaves)

### Backup A — Plan-only run (zero AWS cost, zero network risk)

If AWS is rate-limiting or your network is flaky, the entire demo arc can be shown with `--no-apply` plan boxes only. Nothing is provisioned. Replace step 0:30 with:

```bash
assignee plan --no-apply "Create an S3 bucket named genai-demo-logs"
assignee plan --no-apply "Create a static website for the demo deck"
```

The plan box still renders with BP findings, cost preflight, and the HITL prompt — which then aborts at "no" instead of applying. The audience still sees the constrained-agency pipeline.

### Backup B — MCP demo as the primary spine

If the CLI happens to fail spectacularly, the MCP demo from Claude Code is a strong fallback. The same `createGraph()` runs there. Make sure your Claude Code config has the MCP server wired up before the demo:

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json   (or your Claude Code MCP config)
{
  "mcpServers": {
    "assignee": {
      "command": "node",
      "args": [
        "/Users/serhii_l/code/GenAi/assignee.ai/apps/mcp-server/dist/index.js",
      ],
    },
  },
}
```

Restart Claude Code after editing.

### Backup C — Pre-recorded screencast

If both A and B fail, fall back to a screencast of the demo recorded the day before. Saving an `asciinema` recording during the dry run gives you an exact-replay backup:

```bash
asciinema rec demo-rehearsal.cast
# … run the demo arc …
# Ctrl-D to stop
asciinema play demo-rehearsal.cast    # replay during defence if live fails
```

---

## Cleanup (after the demo)

Tear down everything you provisioned, in reverse order:

```bash
# Single-resource cleanup — repeat for each ARN that appears in `assignee list`
assignee list --json | jq -r '.resources[].arn' | while read arn; do
  echo "destroy: $arn"
  assignee destroy "$arn" --yes
done

# CloudFront-fronted static website (pre-deployed):
# Run the following two-step destroy in order — CloudFront first (slow),
# then S3 origin bucket. `assignee destroy` handles the disable-then-delete
# choreography for CloudFront automatically.
assignee destroy arn:aws:cloudfront::*:distribution/<DIST-ID> --yes
assignee destroy arn:aws:s3:::<origin-bucket-name>            --yes

# Verify clean account
assignee list --region us-east-1
# Expected: "No managed resources found in us-east-1."
```

If any resources slip the cleanup, the audit log is the receipt:

```bash
assignee audit-verify --json | jq '.records[].record'
```

---

## Static website hosting — alternative paths

The recommended path is the Assignee.ai compound pattern (above). For reference, here are two simpler options if you only need to host this one HTML file:

### Option 1 — Plain S3 website (no CloudFront, ~30 seconds)

S3 website hosting requires public bucket access, so this is only suitable for ephemeral demo hosting.

```bash
BUCKET="genai-demo-deck-$(date +%s)"
aws s3 mb "s3://${BUCKET}" --region us-east-1
aws s3 website "s3://${BUCKET}/" --index-document index.html
aws s3api put-public-access-block \
  --bucket "${BUCKET}" \
  --public-access-block-configuration "BlockPublicAcls=false,BlockPublicPolicy=false,IgnorePublicAcls=false,RestrictPublicBuckets=false"
aws s3api put-bucket-policy --bucket "${BUCKET}" --policy "$(cat <<EOF
{ "Version": "2012-10-17",
  "Statement": [ { "Sid": "PublicRead", "Effect": "Allow", "Principal": "*",
                   "Action": "s3:GetObject", "Resource": "arn:aws:s3:::${BUCKET}/*" } ] }
EOF
)"
aws s3 sync /Users/serhii_l/code/GenAi/presentation/ "s3://${BUCKET}/" --acl public-read
echo "http://${BUCKET}.s3-website-us-east-1.amazonaws.com"
```

Cleanup:

```bash
aws s3 rb "s3://${BUCKET}" --force
```

### Option 2 — Local-only preview (zero AWS, instant)

For rehearsals or off-line venues:

```bash
# Either:
npx serve /Users/serhii_l/code/GenAi/presentation
# Or:
python3 -m http.server 5500 --directory /Users/serhii_l/code/GenAi/presentation
# Then open: http://127.0.0.1:5500/index.html
```

---

## Useful one-liners

```bash
# Show every supported intent example
assignee plan --help

# Re-render an apply for a previously-provisioned resource (no AWS write)
assignee describe <run-id-or-arn>

# Find drift between plan and live state for one resource
assignee drift <arn> --detailed

# Cost optimisation suggestions for the current account
assignee optimize --region us-east-1

# Verify the audit-log HMAC chain (proves no record was tampered with)
assignee audit-verify

# Restore the provisions registry from the latest local backup
assignee restore-provisions --from $(date +%Y-%m-%d)

# Generate shell completions
assignee completions zsh > ~/.zsh/completions/_assignee
```

---

## Pre-demo checklist (run through 30 minutes before)

- [ ] `pnpm build` is green
- [ ] `aws sts get-caller-identity` returns your admin ARN (or IAM keys are exported)
- [ ] `assignee doctor --short` shows operator role active, region correct
- [ ] `.assignee/config.yaml` has the budget panic limit set
- [ ] The static-website deploy is finished and the CloudFront URL loads in your browser
- [ ] The MCP server is wired into your Claude Code / Cursor config (backup B)
- [ ] You have a working `asciinema` recording of a dry run (backup C)
- [ ] Your terminal font is large enough for the audience to read
- [ ] You have the deck open at slide 1 in a separate browser tab

Good luck.
