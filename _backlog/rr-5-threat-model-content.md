# Backlog: RR-5 Security Threat Model — Full Content

**Source**: Epic 108-A RELEASE_CHECKLIST.md RR-5
**Effort**: M
**Blocking for**: `pnpm publish` (v1.0 release)

## Scope

1. Author full threat model at `docs/explanation/security-threat-model.md` (stub exists from Story 108-A-06).
2. Cover all six sections: trust boundaries, credential handling, telemetry boundary, plan/apply isolation, destruct safety, supply chain.
3. Perform a light STRIDE or equivalent analysis sized for a developer-tool threat profile.
4. User signs off that the threat model accurately reflects the system as built.

## Acceptance

- `docs/explanation/security-threat-model.md` contains complete content (no STUB status line).
- All six sections have substantive prose (not just headings).
- Citation-lint passes with no path errors.
- RR-5 `[x]` in RELEASE_CHECKLIST.md with citation.
