# Tutorials

Learning-oriented, hands-on walkthroughs. The reader starts knowing
nothing about Assignee.ai and ends with a concrete, working result.

Tutorials are the most **narrative** of the four [Diátaxis](https://diataxis.fr/)
quadrants. They optimise for "I ran the commands and it worked" — not for
reference completeness or theoretical depth.

---

## Current tutorials

_(Pending — this quadrant is scaffolded but empty as of Epic 99 Wave 3.
The canonical first tutorial will be a "first plan + apply + destroy"
walk-through for a brand-new AWS account. Contribute tutorials here.)_

---

## When to write a tutorial (vs. a how-to)

| Situation                                                                       | Quadrant     |
| ------------------------------------------------------------------------------- | ------------ |
| First-time reader; the **learning** is the deliverable                          | **Tutorial** |
| Experienced reader who knows what they want; the **outcome** is the deliverable | **How-to**   |

Heuristics:

- "How to do X for the first time, explained step-by-step" → tutorial.
- "How to override a BP rule" (assumes familiarity) → how-to.
- "What every flag of `assignee plan` means" (lookup, no narrative) → reference.
- "Why assignee uses a run-ledger instead of a state file" (conceptual) → explanation.

---

## Scope expectations

Tutorials assume:

- Working AWS credentials with `AdministratorAccess` or the Assignee
  bootstrap role (see [`../aws-bootstrap.md`](../aws-bootstrap.md)).
- A clean AWS account with no Assignee-managed resources yet.
- A working `pnpm install && pnpm build` baseline.

Tutorials do **not** cover bootstrap or account setup — those live under
[`../how-to/`](../how-to/) (task recipes) or the top-level
[`../how-to/quickstart.md`](../how-to/quickstart.md) (single-page quickstart).

---

## Further reading

| Quadrant    | Directory                            | Purpose                            |
| ----------- | ------------------------------------ | ---------------------------------- |
| How-to      | [`../how-to/`](../how-to/)           | Task recipes for experienced users |
| Reference   | [`../reference/`](../reference/)     | Every command, flag, config option |
| Explanation | [`../explanation/`](../explanation/) | Architecture and design rationale  |
| Docs root   | [`../index.md`](../index.md)         | Full documentation map             |
