# Backlog: RR-5 Security Threat Model — Full Content

> **STATUS: CLOSED 2026-05-18.** RR-5 was completed during Epic 108-A
> closure; `docs/explanation/security-threat-model.md` is now the
> v1.0-rc.1 baseline (10 sections covering all six scope items plus
> review cadence). RELEASE_CHECKLIST.md row RR-5 is `[x]`. This
> backlog file is retained as audit-trail history; do not re-open
> unless the threat model needs a v2.0 refresh.

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
