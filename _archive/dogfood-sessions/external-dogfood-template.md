# External Dogfood Session Template (RR-10)

**Story**: 108-A-06 (Epic 108-A close-out)

## Sign-off format

For each external dogfood session, copy this template to a new file
`_archive/dogfood-sessions/external-dogfood-<date>-<tester-handle>.md` and fill in:

- **Date**: <YYYY-MM-DD>
- **Tester handle**: <github-username or pseudonym>
- **Setup environment**: macOS / Linux / WSL + node version
- **Intent tested**: <exact natural-language input passed to `assignee infra plan`>
- **Output observed**: <copy of CLI output, with any real account-IDs redacted to 112233445566>
- **First-run UX rating** (1–5): <number>
- **Blockers encountered**: <list, or "none">
- **Recommended next test**: <follow-on intent if any>
- **Tester acknowledgment**: <quoted line confirming they ran the command end-to-end and the output was usable>

## Coverage requirement

At least one external (non-coordinator) user must complete this template against
the current `main` HEAD before `RELEASE_CHECKLIST.md` RR-10 can be marked `[x]`.
The dogfood session must use the `infra plan` command (post-108-A-05 noun-grouped
form) and must NOT be from a fresh clone of the repo by the project owner.
