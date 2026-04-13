# Edge Case Hunter — Story 45.6 (MCP version drift)

Scope: `apps/cli/src/services/mcp-version-check.ts`,
`apps/cli/src/services/__tests__/mcp-version-check.test.ts`,
`apps/cli/src/commands/doctor.ts` (`checkMcpVersionDrift` + wiring),
`apps/cli/src/commands/doctor.test.ts` (drift describe block + skip tests),
`apps/cli/scripts/check-mcp-versions.ts`.

Findings are ordered by severity. Line numbers reference `main` as reviewed.

---

## 1. Doctor time budget blown on offline runs — BUG

`apps/cli/src/services/mcp-version-check.ts:158-194` (`checkMcpVersions`) and
`apps/cli/src/commands/doctor.ts:1019-1050` (`runDoctor` `Promise.all`).

Scenario: user on a plane, or behind a proxy that blackholes pypi.org.
`checkMcpVersions` runs 5 fetches in parallel, each with its own 5000ms
AbortController. Because the 5 are parallel, wall-clock is ~5s — _assuming
DNS resolves promptly_. If DNS itself stalls (Happy Eyeballs timeout, captive
portal), Node's `fetch` can hang longer than the AbortController budget on
some libc stacks, AND the signal only unblocks the body read, not the
pre-connect DNS lookup in all Node versions.

Worst real case observed in the wild: ~10-15s per hung DNS. The doctor header
claims "<10s total, 5s per check" — this section alone can blow that budget
on flaky networks and make `doctor` feel frozen. There's no per-section
overall timeout wrapper.

Fix: wrap the whole `checkMcpVersionDrift` call in
`Promise.race([..., setTimeout(7000, fallbackWarnSection)])` so the section
degrades to "warn: version check timed out" rather than stalling the CLI.
Add a test that injects a `checkVersionsImpl` which never resolves and asserts
`runDoctor` still returns within the budget.

---

## 2. `compareVersions` gives the wrong answer for `1.0.0` vs `1.0.0rc1` — BUG

`apps/cli/src/services/mcp-version-check.ts:77-88`,
tests at `__tests__/mcp-version-check.test.ts:91-96`.

The strict-int gate drops _both_ inputs to lexicographic compare when either
has a non-numeric component. Test file line 94 asserts
`compareVersions("1.0.0rc1", "1.0.0") === 1` with the comment "`1.0.0rc1` >
`1.0.0` lexically" — that is the exact opposite of PEP 440, which says a
release-candidate is **earlier** than the final. The test is codifying a bug
as "expected behaviour".

Scenario: awslabs ships `1.0.28rc1` on PyPI (release engineering preview).
Our pin is `1.0.27`. Current code: lexicographic compare → `"1.0.27" <
"1.0.28rc1"` → flagged as `behind`. User bumps pin to `rc1`. Two days later
upstream ships real `1.0.28`. Current code: lex compare `"1.0.28rc1" >
"1.0.28"` → reports `up-to-date`. We just got stuck on a release candidate.

Fix: when the fallback kicks in, strip any `rc\d+|a\d+|b\d+|\.dev\d+|\.post\d+`
suffix and compare the numeric core; if the core is equal, the suffixed
version is **less**. Or just import `semver` — the package is already
transitively present. Add tests for `("1.0.0", "1.0.0rc1") === 1` and
`("1.0.0rc1", "1.0.0rc2") === -1`.

---

## 3. PyPI redirects not exercised — GAP

`apps/cli/src/services/mcp-version-check.ts:113-114`.

Native `fetch` follows 3xx by default (`redirect: "follow"`). PyPI has, in
the past, 302'd `/pypi/<pkg>/json` for packages that moved. This is fine
today, but: if PyPI ever starts responding with an HTTPS → HTTP redirect
(or a cross-origin redirect to `files.pythonhosted.org`), the fetch will
succeed but `response.json()` may receive HTML. Current code catches
malformed JSON and reports fetch-failed — OK — but we never verify
`Content-Type` is `application/json` before calling `.json()`, so an HTML
rate-limit page ("429 Too Many Requests") with `Content-Type: text/html`
produces the generic "malformed JSON" error instead of the real cause.

Fix: after `response.ok`, check `response.headers.get("content-type")` and
throw a specific "PyPI returned non-JSON response (likely rate-limited or
redirected to HTML page)" if it isn't `application/json`. Add a test with a
`text/html` 200 response.

---

## 4. `info.version: null` and `info.version: 1.0` (number) not covered — GAP

`apps/cli/src/services/mcp-version-check.ts:140-143`,
test at `__tests__/mcp-version-check.test.ts:185-205`.

The defensive narrowing catches _missing_ and _empty-string_ versions but
the tests never drive the two realistic misparses:

- `info.version: null` (PyPI has briefly returned this mid-release for yanked
  packages) — hits the `typeof !== "string"` branch, but untested.
- `info.version: 1.0` as a JSON number (a MITM proxy, Charles, or a corporate
  Zscaler JSON "beautifier" can coerce). Current code throws correctly, but
  the error message "`info.version` is not a non-empty string" is misleading
  when the real cause is "wrong type: number".

Fix: add two tests (`version: null`, `version: 1.0`). Improve the error
message to include `typeof version` so operators can diagnose.

---

## 5. `info.yanked: true` / `yanked_reason` silently accepted — GAP

`apps/cli/src/services/mcp-version-check.ts:140-143`.

If upstream yanks a release after we pin to it, PyPI's `info.version` still
points to the yanked release (PyPI returns the highest non-yanked by
default in most endpoints, but `/pypi/<pkg>/json` specifically returns the
version currently tagged "latest" which can briefly be a yanked one during
the yank window). Current code would happily report `up-to-date` against a
yanked release. Even worse, if WE pinned to a version that's since been
yanked, nothing tells the user.

Fix: if `info.yanked === true` OR `info.yanked_reason` is a non-empty
string, surface a dedicated `status: "yanked"` (or append to the `behind`
detail). At minimum, fail loudly rather than silently. Tests: mock a yanked
payload and assert the row flags it.

---

## 6. `parsePin` accepts whitespace-only versions — GAP

`apps/cli/src/services/mcp-version-check.ts:47-55`,
test `__tests__/mcp-version-check.test.ts:51-57`.

Guard is `at === pin.length - 1` — only rejects literally trailing `@`. A pin
of `awslabs.foo@ ` (trailing space) or `awslabs.foo@\t` passes, yielding
`pinnedVersion: " "`. Downstream `compareVersions(" ", "1.0.30")` goes
through the string-fallback and returns `-1`, so it reports `behind` with
`latestVersion: "1.0.30"` — confusing but survivable. But if someone hand-
edits `MCP_PINS` with a stray space, the error should scream.

Fix: `pinnedVersion.trim().length === 0` → throw. Add a test for
`parsePin("awslabs.foo@ ")`.

---

## 7. `@scope/pkg@1.0.0`-style pins (leading `@`) trip the guard — LATENT

`apps/cli/src/services/mcp-version-check.ts:47-55`.

Today no MCP uses npm-scope syntax, but the guard `at <= 0` rejects
`@scope/pkg@1.0.0` because the first `@` is at index 0. `lastIndexOf` does
pick the correct split (`1.0.0`), but the `<= 0` check needs to be `< 0`
for future-proofing. With `<= 0` today, pins like `@anthropic/mcp@1.2.3`
would throw `Invalid MCP pin format` even though they're valid.

Fix: change to `if (at < 0 || at === pin.length - 1)`, then recompute:
when `at === 0`, `packageName = ""` which is its own invalid case — add a
specific `if (!packageName) throw` check. Add tests for both shapes.

---

## 8. `checkMcpVersions` empty-result path: `0/0 up-to-date` header — GAP

`apps/cli/src/commands/doctor.ts:547-553`.

If `MCP_PINS` is empty (shouldn't happen in prod but trivial in a test fork
or a feature flag that disables MCP), `upToDateCount = 0`, `subs.length = 0`,
and `rollup([])` returns `"ok"` (the reducer's initial value). Section
renders as `MCP version drift (0/0 up-to-date)` with status `ok`, giving a
green check for a check that didn't run.

Fix: if `subs.length === 0`, return `status: "warn"` with a single sub
`{ label: "no MCP pins configured", status: "warn" }`. Add a doctor test
injecting `checkVersionsImpl: async () => []`.

---

## 9. Script is not covered when invoked directly — GAP

`apps/cli/scripts/check-mcp-versions.ts:1-28`,
tests only cover `runMcpVersionScript` with injected sinks.

The 5-line wrapper itself (`runMcpVersionScript().then(process.exit).catch(...)`)
is never executed in tests. The `.catch` branch in particular has never been
verified — if `runMcpVersionScript` rejects (e.g. an import error thrown
during module load of `mcp-version-check.js`), we print "fatal: …" and exit
1, but that string format is untested and the stderr sink goes to the real
stderr, which vitest will swallow.

Also: the shebang `#!/usr/bin/env npx tsx` means `./check-mcp-versions.ts`
will try to resolve `npx` on PATH. On Windows, and on systems where `tsx`
isn't globally installed, this fails with a confusing error. `pnpm
check-mcp-versions` bypasses the shebang, but a curious developer
`chmod +x`-ing the file will hit it.

Fix: either (a) lose the shebang entirely — the file is only meant to be run
via pnpm — or (b) use `#!/usr/bin/env -S npx tsx` and document it.
Optionally add a smoke test that spawns `pnpm check-mcp-versions` with
`FETCH_MOCK` injected via a tiny harness.

---

## 10. `fetchLatestVersion` abort mid-body not covered — GAP

`apps/cli/src/services/mcp-version-check.ts:114-122`, test at
`__tests__/mcp-version-check.test.ts:207-225`.

The existing "aborted signal" test fires `controller.abort()` BEFORE calling
fetch, so the mock throws immediately. It does not exercise the realistic
case: timeout fires while `response.json()` is in flight (post-headers).
In that case, `fetch` resolves with the `Response`, then `.json()` rejects
with `AbortError`. The `try { payload = await response.json() } catch`
block catches it and mis-labels it as "PyPI returned malformed JSON: The
operation was aborted" — wrong category, operator reads it as "PyPI sent
garbage" when the real cause is "we timed out".

Fix: inspect the caught error — if it's an `AbortError` (name === `AbortError`
or `err.cause?.name === 'AbortError'`), re-throw with "PyPI fetch aborted
(timeout)" instead of the malformed-JSON wrapper. Add a test that resolves
`response` but rejects `.json()` with an AbortError.

---

## 11. `clearTimeout` idempotency is fine — but `AbortController.abort(Error)` signature is Node-version-specific

`apps/cli/src/services/mcp-version-check.ts:284-286`.

`controller.abort(new Error("PyPI fetch timed out"))` passes a reason — this
is supported from Node 18+, but Node 20 and Node 24 differ in how the reason
surfaces: on Node 20, `signal.reason` is the Error; on some Node 18.x minor
releases it's coerced to a `DOMException`. The project claims to support
"Node 20 vs Node 24" (per the story file). On Node 24 specifically, `fetch`
currently wraps the rejection as `new TypeError("fetch failed", { cause: <reason> })`
so the caller sees `"fetch failed"`, not `"PyPI fetch timed out"`. The error
message surfaced into the doctor row is therefore version-dependent and not
actionable for users on Node 24.

Fix: catch at `checkSinglePin` and if `err.name === "AbortError" || err.cause?.message?.includes("timed out")`, rewrite the
message to "PyPI fetch timed out after 5000ms". Verify the happy-path message
on both Node 20 and Node 24 in CI.

---

## Summary

| #   | Severity | Type   | Location                             |
| --- | -------- | ------ | ------------------------------------ |
| 1   | HIGH     | bug    | doctor.ts orchestration budget       |
| 2   | HIGH     | bug    | compareVersions pre-release ordering |
| 3   | MED      | gap    | Content-Type not checked             |
| 4   | MED      | gap    | null/number version payloads         |
| 5   | MED      | gap    | yanked release acceptance            |
| 6   | LOW      | gap    | parsePin whitespace version          |
| 7   | LOW      | latent | parsePin leading-@ guard             |
| 8   | LOW      | gap    | empty MCP_PINS → green check         |
| 9   | LOW      | gap    | script wrapper uncovered, shebang    |
| 10  | MED      | gap    | abort mid-body mislabeled            |
| 11  | MED      | bug    | Node 24 abort reason swallowed       |

Finding #1 and #2 should block merge. #5, #10, #11 are strongly
recommended. The rest are test-gap polish.
