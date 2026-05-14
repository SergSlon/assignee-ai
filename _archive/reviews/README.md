# Reviewer evidence archive

Every commit on main whose body contains `Reviewer: ACCEPT — ...` MUST have a matching evidence file in this directory named `<short-sha>-review.md`.

## Required first line

`# Reviewer: ACCEPT — <role> (<persona>) — <story_id>`

## Body

Free-form review notes from the qa role agent. Should include:

- Gate-criteria verification
- Probe-plan coverage
- File-ownership verification
- Any informational nits

## Pre-push hook

Enforced by `.husky/pre-push`. See `.claude/rules/bmad-workflow.md`.
