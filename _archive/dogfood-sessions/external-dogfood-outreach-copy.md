# External Dogfood Outreach — Ready-to-Send Copy

**Story**: 108-A-06 RELEASE_CHECKLIST.md RR-10 (closure prep)
**Audience**: someone other than the project owner who has an AWS test
account they're willing to spend < $5 on, and ~30 minutes.

This file pairs with `external-dogfood-template.md` (the sign-off
record) and `external-dogfood-testing-guide.md` (the step-by-step
playbook for the tester). Send those two files to the tester
alongside the outreach copy below.

---

## Outreach copy (paste into Slack / email / DM)

### Short version (~50 words)

> Hey! I'm shipping a CLI tool that turns natural-language intents
> into AWS plan-then-apply ops. Before v1.0 I need one external
> dogfooder. ~30 min, costs < $5 of AWS, gives me a written sign-off
> on the first-run UX. Up for it? I'll send a one-page guide + the
> sign-off template.

### Medium version (~150 words)

> Hey — I'm about to ship v1.0 of [Assignee.ai](https://github.com/SergSlon/assignee-ai),
> a CLI that turns natural-language intents into AWS infrastructure
> plans (with cost preflight + apply gating). Before I flip the publish
> switch I need ONE external person to run it end-to-end against their
> own AWS account and write up the first-run UX.
>
> What it takes:
>
> - ~30 minutes
> - An AWS test account willing to spend < $5 (the test resources are
>   S3 bucket + Lambda + EC2 micro — auto-destroyed at session end)
> - A short written sign-off using my template
>
> I'll send:
>
> - A one-page setup + testing guide
> - The sign-off template (fill in the blanks)
> - My direct contact for live questions
>
> The whole thing closes the last item on my v1.0 release checklist
> (RR-10). Up for it?

### Long version (~300 words, for someone who hasn't seen the project)

> Hi! I'm working on [Assignee.ai](https://github.com/SergSlon/assignee-ai)
> — a developer CLI that turns natural-language intents like "create an
> S3 bucket with versioning and a 7-day lifecycle" into AWS
> CloudControl plans, runs a cost preflight, and only applies after
> you review. It's been in private development for the past several
> months and is now at v1.0 release-candidate stage: 10 of 12
> publish-gate items are checked, and the last blocking item is a
> single external user dogfood session.
>
> The dogfood session is straightforward:
>
> - Clone the repo, run `assignee dev setup` to mint three IAM users
>   in your AWS account (operator / reader / auditor — least-privilege
>   by design).
> - Run `assignee infra plan "<your intent>"` against any of the 38
>   supported resource types. The plan box shows estimated monthly
>   cost + a best-practice score before you approve apply.
> - Optionally run `assignee infra apply` to actually provision, then
>   `assignee infra destroy --all` to clean up.
> - Fill in a one-page sign-off template covering the first-run UX
>   rating, any blockers, and a tester-acknowledgement quote.
>
> AWS cost should stay under $5 if you stick to the documented
> patterns (S3 + Lambda + a few EC2 micros). The whole thing takes
> ~30 minutes including teardown.
>
> Why I'm asking you: <fill in the specific context of why this
> person is a good fit — maybe they've shipped IaC tools, maybe they
> use AWS daily, maybe they've critiqued similar tools and would
> spot UX issues fast>.
>
> If you're in, I'll send:
>
> 1. The one-page setup + testing guide.
> 2. The fill-in-the-blanks sign-off template.
> 3. My direct contact (Slack / email / WhatsApp — your pick) for
>    live questions during the session.
>
> Once you complete the sign-off, I commit your write-up to
> `_archive/dogfood-sessions/external-dogfood-<date>-<your-handle>.md`,
> flip RR-10 to `[x]` in the release checklist, and ship v1.0. Your
> name (or a pseudonym, your choice) goes in the release notes as
> "first external dogfooder."
>
> Let me know if you're game.

---

## Suggested recipients (categories)

Order of preference for who to ask first:

1. **A friend who ships IaC tools at work** — fastest signal on
   "does this feel like the right shape for an IaC CLI." Probably the
   highest-bandwidth feedback per minute.
2. **A friend who uses AWS heavily but doesn't build IaC tools** —
   tests whether the CLI is approachable for the actual target user.
3. **A friend who's critical-by-nature** (you know who they are) —
   catches the UX rough edges that an excited builder misses.
4. **A junior dev who's new to AWS** — first-time-user friction is
   the highest signal of all if they can complete the session at all.

Avoid:

- Anyone currently employed at AWS (potential conflict of interest
  re: future commercial direction).
- Anyone you've already shown alpha builds to (their feedback is
  cumulative, not first-impression).
- Anyone who hasn't agreed to spend < $5 on their own AWS account
  (we don't reimburse for v1.0).

## Followup if no response in 48h

> Just bumping this — totally fine if not your bandwidth right now;
> I'll find someone else. But if you DO have 30 min sometime this
> week, the sign-off is what's gating my v1.0 ship.

If still no response after the bump, move down the priority list.

## After the tester accepts

Send three files:

1. `external-dogfood-testing-guide.md` (the step-by-step playbook —
   created in this PR's other file)
2. `external-dogfood-template.md` (the sign-off form — already
   exists from 108-A-06)
3. Direct contact for live questions

## After the tester completes

1. Commit their sign-off to
   `_archive/dogfood-sessions/external-dogfood-<date>-<handle>.md`.
2. Flip RR-10 to `[x]` in `RELEASE_CHECKLIST.md` with citation.
3. (Optional, with their permission) credit them in v1.0 CHANGELOG
   entry under "First external dogfood".
