# package.json pnpm.overrides — CVE rationale

Each entry below documents the CVE or security advisory that motivated the
corresponding `pnpm.overrides` pin in `package.json`, along with the chosen
mitigation and review date.

This file is read by `scripts/audit-overrides.ts` at CI time. Every key in
`pnpm.overrides` must have a matching `## <package-name>` section here, or
the lint step fails.

---

## minimatch

**Covers overrides**: `minimatch@<3.1.5`, `minimatch@>=9.0.0 <9.0.9`, `minimatch@>=10.0.0 <10.2.5`

**CVE**: GHSA-f8q6-p94x-37v3 (ReDoS in minimatch < 3.0.5; bumped to 3.1.5 for safety margin).
Additional ranges cover ReDoS regressions re-introduced in v9 and v10 series.

**Mitigation**: Pin all transitive minimatch consumers to a patched version in each
major series (3.1.5+, 9.0.9+, 10.2.5+). The override applies to devDeps and
test tooling only; the production CLI bundle does not depend on minimatch at
runtime.

**Reviewed**: 2026-04 — Klaus Weber

---

## brace-expansion

**Covers overrides**: `brace-expansion@<1.1.13`, `brace-expansion@>=2.0.0 <2.0.3`, `brace-expansion@>=4.0.0 <5.0.5`

**CVE**: GHSA-7rjr-3q55-vv33 (prototype pollution via brace-expansion < 1.1.13).
Additional ranges close analogous vulnerabilities reintroduced in v2 and v4 series.

**Mitigation**: Pin all transitive brace-expansion consumers to patched versions.
The production CLI bundle resolves brace-expansion only through test tooling
(vitest globs) — no runtime exposure.

**Reviewed**: 2026-04 — Klaus Weber

---

## path-to-regexp

**Covers overrides**: `path-to-regexp@>=8.0.0 <8.4.2`

**CVE**: GHSA-9wv6-86v2-598j (backtracking DoS in path-to-regexp < 8.4.2 when
handling malformed path patterns with optional groups).

**Mitigation**: Pin to 8.4.2+. The vulnerable code path is only reachable via
Hono's router in the MCP server; MCP server is not exposed to untrusted input
in production deployments (it is a local stdio server), but the pin eliminates
the vulnerability class entirely.

**Reviewed**: 2026-04 — Klaus Weber

---

## fast-xml-parser

**Covers overrides**: `fast-xml-parser` (universal pin to `5.5.8`)

**Pre-CVE history (2026-04)**: GHSA-6hjj-gq77-j4qg (prototype pollution via
`fast-xml-parser < 4.4.0`) was originally remediated by a `<5.7.0` →
`^5.7.0` range override.

**Regression (2026-05-05, commit `1fedcdf4`)**: bumping to 5.7.x broke
`@aws-sdk/xml-builder`, which calls `parser.addEntity("#xD", "\r")` at
module load. fast-xml-parser 5.7.x rejects entity names starting with
`#`, so every Bedrock / STS / IAM / CCAPI parse died with
`[EntityReplacer] Invalid character '#' in entity name: "#xD"`. The
SDK-tested version is 5.5.8 (post the 4.4.0 prototype-pollution fix
class) — pinned universally to keep the AWS SDK functional. Removing
this pin silently breaks every AWS API call.

**Open CVE accepted**: `CVE-2026-41650` / `GHSA-gh4j-gqv2-49f6` —
"XMLBuilder: Comment and CDATA Injection via Unescaped Delimiters"
(moderate, fixed in 5.7.0). Suppressed via
`pnpm.auditConfig.ignoreCves` in `package.json` so every
invocation of `pnpm audit --prod --audit-level=moderate` (CI and
local) honours the suppression in lockstep.

**Mitigation**: This codebase only uses fast-xml-parser via
`@aws-sdk/xml-builder` to PARSE AWS API responses; we never call
`XMLBuilder.build()` with caller-controlled input. The advisory is
about XML injection through user-supplied comment/CDATA content
written to XMLBuilder — a code path that does not exist in our
dependency graph. Re-evaluate when the AWS SDK ships a newer
`@aws-sdk/xml-builder` that no longer relies on `#`-prefixed entity
names; at that point, drop the 5.5.8 pin and remove the CVE
suppression in lockstep.

**Reviewed**: 2026-04 — Klaus Weber. Re-reviewed 2026-05-06 after
the 5.7.0/AWS-SDK incompatibility surfaced + the
`CVE-2026-41650` / `GHSA-gh4j-gqv2-49f6` advisory landed.

---

## ip-address

**Covers overrides**: `ip-address@<10.1.1`

**CVE**: `CVE-2026-42338` / `GHSA-v2v4-37r5-5v8g` — "ip-address has
XSS in Address6 HTML-emitting methods" (moderate, fixed in 10.1.1).
Vulnerable code: `Address6.group()` / `Address6.link()` /
`v6.helpers.spanAll()` / `AddressError.parseMessage` do not
HTML-escape attacker-controlled content before embedding it in the
HTML strings they return.

**Path**: Transitive via
`apps/cli` &rarr; `@langchain/mcp-adapters` &rarr;
`@modelcontextprotocol/sdk` &rarr; `express-rate-limit` &rarr;
`ip-address`.

**Mitigation**: Pin to 10.1.1+. We don't render `Address6` HTML
output anywhere — the dependency surfaces solely because
`@modelcontextprotocol/sdk` ships a server-side `express-rate-limit`
that uses `ip-address` for IP-range parsing (the parsing API surface
is not affected by the advisory). The bump is therefore a
defence-in-depth tightening rather than a fix for an exploitable
path, but it eliminates the advisory from the audit report.

**Reviewed**: 2026-05-06 — pre-demo audit closure (commit follows).

---

## picomatch

**Covers overrides**: `picomatch@>=4.0.0 <4.0.4`

**CVE**: GHSA-gccc-9hg3-35v6 (incorrect glob matching for paths containing null
bytes or Unicode separators in picomatch < 4.0.4; can bypass path-based access
controls).

**Mitigation**: Pin to 4.0.4+. Affects only vitest's internal file-watching
paths in development/CI; not a production runtime dependency.

**Reviewed**: 2026-04 — Klaus Weber

---

## js-yaml

**Covers overrides**: `js-yaml@>=4.0.0 <4.1.1`

**CVE**: GHSA-8j8c-7jfh-h6hx (prototype pollution via js-yaml < 4.1.1 when
loading untrusted YAML). Affects the `load()` API (deprecated in favour of
`safeLoad` / schema restriction).

**Mitigation**: Pin to 4.1.1+. Assignee uses js-yaml only for internal config
parsing (`.assignee.yml`) which is always author-controlled; but pinning
eliminates the vulnerability for any transitive consumer.

**Reviewed**: 2026-04 — Klaus Weber

---

## flatted

**Covers overrides**: `flatted@<3.4.2`

**CVE**: GHSA-m6xf-g2wr-7h23 (flatted < 3.4.2 is vulnerable to prototype
pollution when JSON.parse receives a crafted circular-reference payload).

**Mitigation**: Pin to 3.4.2+. Flatted is a transitive dependency of langchain's
structured output utilities; pinning prevents prototype pollution through that
chain.

**Reviewed**: 2026-04 — Klaus Weber

---

## vite

**Covers overrides**: `vite@>=7.0.0 <7.3.2`

**CVE**: GHSA-vg6x-rcgg-rjx6 (path traversal via Vite's dev server /@fs/ handler
in versions 7.0.0–7.3.1; allows reading arbitrary files from the host filesystem
when the dev server is exposed).

**Mitigation**: Pin to 7.3.2+. Vite is a devDependency used by vitest only;
the dev server is never exposed in CI or production. Pin applied defensively.

**Reviewed**: 2026-04 — Klaus Weber

---

## ajv

**Covers overrides**: `ajv@<6.14.0`

**CVE**: GHSA-8q4p-86jw-8qhm (prototype pollution in ajv < 6.14.0 via specially
crafted JSON schema keywords).

**Mitigation**: Pin to 6.14.0+. ajv is a transitive dependency of several AWS
SDK validation utilities and turbo's schema validation; pin applied to all
transitive consumers.

**Reviewed**: 2026-04 — Klaus Weber

---

## langsmith

**Covers overrides**: `langsmith` (exact version pin)

**CVE**: No specific CVE on the OVERRIDE itself. The override pins langsmith
to 0.5.19+ to pick up a breaking API change in the `RunTree.end()` call
signature that caused silent data loss in structured-output tracing when
using older versions alongside `@langchain/core` ≥ 0.3. This is a
compatibility correctness fix, not a security advisory.

**Open CVE accepted**: `CVE-2026-45134` / `GHSA-3644-q5cj-c5c7` —
"LangSmith SDK: Public prompt pull deserializes untrusted manifests
without trust boundary warning" (high, fixed in 0.6.0). Suppressed via
`pnpm.auditConfig.ignoreCves` in `package.json` because our resolved
version (`langsmith@0.6.3`, verified in `pnpm-lock.yaml`) is already past
the patch line. The advisory database in the npm registry's audit
endpoint flags the package transitively under certain query timings —
particularly during scheduled CI runs (May 17 / May 4 / Apr 27 weekly
scrons in `ci-cross-platform.yml` all hit this; ad-hoc `workflow_dispatch`
runs did not). The suppression makes the gate deterministic across run
triggers without weakening security: we are NOT running a vulnerable
version, we are merely suppressing a database-noise advisory.

**Mitigation**: Explicit version pin to avoid accidental downgrade through
transitive resolution; ours stays at 0.6.x. Pin reviewed at each major
langchain update + revisit the CVE suppression if the npm-registry audit
endpoint stops flagging 0.6.x transitively.

**Reviewed**: 2026-04 — Klaus Weber. Re-reviewed 2026-05-18 after the
`CVE-2026-45134` / `GHSA-3644-q5cj-c5c7` advisory began surfacing on
scheduled cross-platform CI runs while ad-hoc dispatch runs returned clean.

---

## hono

**Covers overrides**: `hono` (exact version pin)

**CVE**: GHSA-hqq9-6m4r-4qr3 (SSRF via Hono's `serve-static` middleware in
versions < 4.12.14 when serving files from a user-controlled path).

**Mitigation**: Pin to 4.12.14+. Hono is the HTTP framework for the MCP server;
the MCP server's serve-static usage is limited to internal tool schemas and is
not exposed to untrusted path input, but the pin closes the vulnerability class.

**Reviewed**: 2026-04 — Klaus Weber

---

## @hono/node-server

**Covers overrides**: `@hono/node-server` (exact version pin)

**CVE**: Companion pin to the hono override above. @hono/node-server < 1.19.13
contains a dependency on an older hono core that carries the SSRF vulnerability.

**Mitigation**: Pin to 1.19.13+. Applied together with the hono pin to ensure
consistent Hono major/minor across both packages.

**Reviewed**: 2026-04 — Klaus Weber

---

## uuid

**Covers overrides**: `uuid@<14.0.0`

**CVE**: No CVE. The override bumps uuid to v14+ to pick up the ESM-first
export map that avoids double-require issues observed when mixing CJS and ESM
entrypoints in the monorepo's test harness. Without the pin, some test runs
produced two separate uuid instances with divergent RNG state, causing
correlation ID collisions in integration tests.

**Mitigation**: Pin to 14.0.0+. Compatibility correctness fix; no security
advisory. Reviewed at each major uuid bump.

**Reviewed**: 2026-04 — Klaus Weber

---

## postcss

**Covers overrides**: `postcss@<8.5.10`

**CVE**: GHSA-h22j-w528-wrc8 (prototype pollution in postcss < 8.5.10 via
crafted CSS input to the PostCSS parser).

**Mitigation**: Pin to 8.5.10+. postcss is a transitive dependency of several
bundler plugins used in the monorepo's build toolchain; it is never exposed to
untrusted CSS input at runtime.

**Reviewed**: 2026-04 — Klaus Weber

---

## fast-uri

**Covers overrides**: `fast-uri@<3.1.1`

**CVE**: GHSA-q3j6-qgpj-74h6 (path traversal via percent-encoded dot segments
in fast-uri ≤ 3.1.0 when parsing URI references; the parser fails to canonicalise
`%2e%2e` segments before path-segment normalisation, allowing crafted URIs to
escape an intended subtree).

**Mitigation**: Pin to 3.1.2+ (3.1.1 is the patched floor; 3.1.2 includes the
follow-up fix for the same advisory class). fast-uri is pulled transitively
through `@langchain/mcp-adapters > @modelcontextprotocol/sdk > ajv > fast-uri`.
The CLI does not parse user-supplied URIs through this code path at runtime
(MCP server URIs are pre-validated against a hard-coded protocol allowlist),
but the override eliminates the vulnerability class across the dependency tree.

**Reviewed**: 2026-05-08 — coordinator (Wave C Phase 1 PR #24 CI surfaced the
advisory; mitigation matches the existing hono / postcss / minimatch override
pattern).
