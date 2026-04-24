# How-to Guides

Task-oriented recipes. The reader knows what they want to achieve;
these guides show the most direct path to get there.

How-to guides are the most **prescriptive** of the four
[Diátaxis](https://diataxis.fr/) quadrants. They assume competence —
you already know what `assignee plan` and `assignee apply` do. The goal
is the outcome, not the explanation.

---

## Current how-to guides

| Guide                                      | Goal                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| [`read-a-plan-box.md`](read-a-plan-box.md) | Decode every section of the `assignee plan` output box |

Coverage is intentionally small today — this directory is the right place
to add new task recipes as the project grows. See "Pending how-tos" below
for the queue.

---

## Pending how-tos

The following topics are candidates for future how-to guides (not yet
written). Contributors: pick one, write the recipe, open a PR.

- Override a best-practice rule for a single resource
- Configure multiple AWS accounts / profiles in one project
- Set up `assignee` in a CI/CD pipeline (GitHub Actions, GitLab CI)
- Use drift detection and auto-reconcile on a schedule
- Migrate an existing CloudFormation stack to `assignee` management
- Extend `assignee` with a new resource type plugin
- Expose the Assignee MCP server to Cursor / Claude Code
- Run `assignee` with temporary STS credentials / AWS SSO

---

## When to write a how-to (vs. a tutorial or reference)

| Situation                                              | Quadrant        |
| ------------------------------------------------------ | --------------- |
| Experienced reader; the **outcome** is the deliverable | **How-to**      |
| First-time reader; the **learning** is the deliverable | **Tutorial**    |
| Lookup — "what does this flag do?"                     | **Reference**   |
| "Why does assignee work this way?"                     | **Explanation** |

A how-to answers "how do I …?" — not "what is …?" or "why does …?".
Keep each guide focused on a single goal; link to reference for flag
details and explanation for design rationale.

---

## Further reading

| Quadrant    | Directory                            | Purpose                            |
| ----------- | ------------------------------------ | ---------------------------------- |
| Tutorials   | [`../tutorials/`](../tutorials/)     | Learning-oriented walk-throughs    |
| Reference   | [`../reference/`](../reference/)     | Every command, flag, config option |
| Explanation | [`../explanation/`](../explanation/) | Architecture and design rationale  |
| Docs root   | [`../index.md`](../index.md)         | Full documentation map             |
