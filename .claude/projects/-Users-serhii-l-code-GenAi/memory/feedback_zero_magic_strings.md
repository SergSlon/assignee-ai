---
name: Zero magic strings policy
description: User demands ZERO magic strings in any code — every repeated literal must be a named constant, no exceptions
type: feedback
---

Every string literal that appears more than once in production code must be extracted to a named constant. No exceptions for "domain values", "UI labels", "AWS API values", "measurement units", or "enum options". The user considers ALL of these magic strings.

**Why:** Code must be easy to change. If a value changes, it should only need updating in one place. SOLID Open/Closed principle — the code should be closed for modification.

**How to apply:** Before claiming "done" on any constant extraction work, run a comprehensive grep for ALL string literals appearing 2+ times in production code (excluding imports, comments, type annotations). Every single one must either be a constant or have a documented reason why it can't be.
