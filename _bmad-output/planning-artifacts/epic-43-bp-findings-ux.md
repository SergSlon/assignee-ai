# Epic 43 — BP Findings UX: Consequences + Fix-and-Continue Flow

## Problem Statement

### 1. Findings lack consequence explanations

Users see `"BLOCK S3 bucket should block public ACLs"` but don't understand:

- What happens if they skip it
- What the security/cost/reliability risk is
- How severe the real-world impact is

Each BP finding needs a human-readable **consequence** — e.g., "Without this, anyone on the internet can read your bucket contents via ACLs."

### 2. Fixing all findings doesn't continue to provisioning

When the user fixes all blocking findings in the interactive fix selection, the apply still ends with `bp_blocked` → "Operation completed successfully" — but the bucket was NOT created. The user has to re-run `assignee apply` to actually provision.

Expected flow: fix blocking findings → re-evaluate → if all blocking resolved → proceed to human_approval → provision.

## Stories

### Story 43.1 — Add consequence text to all BP rules (P0)

Every BP rule YAML needs a `consequence` field explaining what happens if the user ignores it.

Format in YAML:

```yaml
consequence: "Without public access blocks, anyone on the internet can read or write to your bucket via ACLs or bucket policies."
```

Display in CLI:

```
BLOCK  S3 bucket should block public ACLs
       ⚠ Risk: Anyone on the internet can read your bucket via ACLs
       → Fix: --set BlockPublicAcls=true
```

Add `consequence` field to all 133 BP rules. Prioritize blocking rules (they're the ones users need to decide on).

### Story 43.2 — Fix-and-continue: proceed to provisioning after all blocking resolved (P0)

Current flow:

1. Apply → phase 1 → BP blocks → result_formatter shows plan box
2. User fixes all blocking findings interactively
3. Plan box re-renders with zero blocking findings
4. Apply exits with "bp_blocked" → "completed successfully" (misleading!)
5. User must re-run apply

Expected flow:

1. Apply → phase 1 → BP blocks → result_formatter shows plan box
2. User fixes all blocking findings interactively
3. Plan box re-renders with zero blocking findings
4. **If all blocking resolved AND executionMode=APPLY → proceed to human_approval**
5. User confirms → provision → success

Implementation: In result-formatter.ts, after `promptFixSelection()` returns, check if all blocking findings are now resolved. If yes AND mode is APPLY, return state with `preflightPassed: true` so the graph can route to human_approval.

But there's a graph routing issue — the graph has already ended at result_formatter. We need to either:

- Option A: Re-invoke the graph from the apply command after fix selection (resume checkpoint)
- Option B: Change the graph to loop back from result_formatter to preflight_guard after fixes
- Option C: In apply.ts, detect that fixes resolved all blockers and re-run phase 1

### Story 43.3 — Display consequence in fix selection prompt (P1)

When the user is choosing which findings to fix, show the consequence:

```
◆  S3 bucket should block public ACLs
│  ⚠ Risk: Anyone on the internet can read your bucket via ACLs
│  ● [Y] Fix (enable BlockPublicAcls)
│  ○ [N] Skip (accept risk)
```

This helps users make informed decisions rather than blindly clicking "fix all".
