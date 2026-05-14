# Reviewer: ACCEPT — qa (Quinn) — EPIC-106-2

**Commit (pre-amend)**: `0f7af5e4` — fix(intent-parser): lambda body quote-tight + option-A handler-body semantics
**Base**: `8591c86f` (EPIC-106-1 hook hardening on main)
**Story**: `_bmad-output/implementation-artifacts/epic-106-2-sx7-quote-mangle-fix.md`

## Gate-criteria verification

1. **Quote-leak fix** — `lambda-body-extractor.ts:61` regex `/\bbody\s+(['"`])((?:(?!\1)[\s\S])\*)\1/i`uses backreference`\1`in the closing position. The negative lookahead`(?!\1)` guarantees the opening quote character cannot appear inside the captured content. Symmetrical across all 3 quote styles (`'`/`"` / `` ` ``). ✓

2. **Option-A handler body shape** — `buildHandlerFromQuotedBody(body)` emits `exports.handler = async (event) => { ${body} };` — the user's literal IS the handler body. No more static `{statusCode: 200, body: '...'}` envelope for quoted intents. ✓

3. **Unquoted verb-form path preserved** — `buildHandler(bodyLiteral)` keeps the static envelope shape for `returns X` / `logs Y` / `prints Z` / etc. Existing SX-7 tests at lines 161-298 unchanged in assertion content (only comment edits). ✓

4. **Priority ordering correct** — Priority 1 (QUOTED_BODY) at line 142 runs BEFORE Priority 2 (BODY_PHRASE) at line 157, with `return` on quoted-match success. This prevents the verb-form regex from also matching `return event` inside a quoted body (`return` is a verb-form trigger word). ✓

5. **Variation F (PH1-D-1 / SX-7 regression guard)** — Test at line 97-101 asserts bare `"Create a Lambda function"` leaves `elicited.Code` UNSET so the pattern's placeholder ZipFile applies. PH1-D-1 closure preserved. ✓

## Probe-plan coverage (Variations A-H)

- **A** single-quoted `'return event'` → body contains "return event", NO "statusCode: 200", quote-trailing pattern excluded. ✓
- **B** double-quoted `"return event"` → same shape. ✓
- **C** backtick `` `return event` `` → same shape. ✓
- **D** arrow expression `'x => x*2'` → placed verbatim as handler body. Chosen semantics documented in test header (line 64-67): "the captured body IS placed verbatim inside the handler braces" — simplest, least-surprising. ✓
- **E** `'JSON.stringify(event)'` → handler body contains full call (no parser confusion from internal parens). ✓
- **F** no-body fallback → `elicited.Code` undefined (SX-7 closure preserved). ✓
- **G** multi-statement `'console.log(event); return event'` → both statements present in handler body. The `;` inside the quoted body is correctly NOT treated as a sentence terminator (BODY_PHRASE's `;` boundary only applies to the unquoted verb-form path). ✓
- **H** quote-leak negative assertion — iterates all 6 cases (A/B/C/D/E/G), parses `exports.handler = async (event) => { <body> };` shape, asserts trimmed body does NOT end in `'`/`"`/`` ` ``. **DC-2-class trailing-quote leak provably blocked.** ✓

## Adversarial findings (extra-rigor)

- **Verb-form regex priority correctness** — Intent `"with body 'return event'"` contains the word `return` which would match BODY_PHRASE's `\b(?:returns?|...)`. The implementation correctly checks QUOTED_BODY first (line 142) and returns on success, preventing the verb-form regex from running. Tested implicitly via Variation A's `not.toContain("statusCode: 200")` assertion. ✓
- **Existing `Code` object preservation** — Quoted path at line 146-151 uses spread `...existingCode` so user-supplied `Code.Handler` survives the merge. Same pattern as the unquoted path at line 168-173. Tested via verb-form test at line 219-231 (`Handler: "custom.handler"` preserved). Symmetric behaviour across both paths. ✓
- **Empty/whitespace body guard** — Quoted path at line 145 requires `quotedBody.length > 0 && /\w/.test(quotedBody)` — guards against captures like `body ''` or `body '   '`. ✓
- **POSIX edge case (escaped quote inside body)** — Intent `body 'foo \' bar'` would have the regex stop at the first `'`, capturing `foo \`. This is acceptable: the intent string is the user's typed text (already post-shell-parse) and an unescaped-quote in the body is a user-visible "you typed an ambiguous string" issue, not a code defect. Spec didn't require escape-sequence handling. Out of scope. ✓
- **mcp-server mirror** — `grep -rn "extractLambdaBody\|QUOTED_BODY\|buildHandlerFromQuotedBody" apps/mcp-server/src` returns empty. mcp-server consumes core's intent-parser via the shared graph pipeline; no parallel implementation to update. ✓
- **No test weakening** — Diff vs base shows only ADDITIONS to assertions; deletions are comment-only (docstring header expansion, simplified SQS-gate comment, tightened empty-body-guard comment). Zero `it.skip`/`xit`/`describe.skip`/`toBeTruthy`/`toBeFalsy` introduced. Pre-existing SX-7 test assertions unchanged. ✓

## Build + tests

- `pnpm build`: green (FULL TURBO, 4/4 cached).
- `pnpm exec vitest run lambda-body-extractor.test.ts`: 20/20 pass in 3.33s (8 EPIC-106-2 + 12 SX-7).
- Broader sanity (intent-parser + lambda-with-exec-role + lambda-body-propagation): 270/270 pass.
- No live AWS calls. No new deps.

## File-ownership verification

Per story spec, 3 files changed (matches dev_summary):

- `lambda-body-extractor.ts` (+100/-24) — new QUOTED_BODY regex + buildHandlerFromQuotedBody + priority-1 branch ✓
- `lambda-body-extractor.test.ts` (+154/-0 net additions, deletions are comment-only) — 8 new Variation tests ✓
- `CHANGELOG.md` (+24) — Behaviour-change callout present (spec line 87) ✓

No changes to `resource-post-process.ts` or `lambda-with-exec-role.ts` — the static envelope assembly happens in the extractor itself, not downstream, so the option-A switch is fully contained in the one file. Confirmed via the pattern-templates lambda-body-propagation test (2/2 pass).

## CHANGELOG behaviour-change callout

Per spec line 87, CHANGELOG entry includes a **"Behaviour change"** bold callout explaining that existing users relying on the static-envelope shape for `body 'X'` intents will see different handler code. The callout also clarifies unquoted verb-form intents are unaffected — necessary disambiguation so users reading the changelog know which intents are affected. ✓

## Informational nits (non-blocking)

1. **Variation D semantic choice** — `body 'x => x*2'` produces handler body `x => x*2` (the arrow expression sits as a statement, which JS evaluates and discards). It's a no-op handler — the arrow isn't invoked. Per the test header comment line 64-67, this is documented as "simplest, least-surprising behaviour" and the user can manually invoke if needed. Acceptable as a documented choice; could be extended in a follow-up to detect arrow-shapes and wrap in `return (<arrow>)(event);` — out of scope here.

2. **Multi-line bodies** — `body 'console.log(event); return event'` produces `exports.handler = async (event) => { console.log(event); return event };` — the `;` between statements is valid JS, but the trailing `;` from the template means the final statement is followed by two `;`s. Cosmetic only; emits valid JS. Could be tidied in a paydown by removing the template's terminal `;`.

3. **Quote-style normalisation** — The captured body retains whatever character the user typed; if the body contains backticks but the handler is emitted with the template literal-wrapped style (no backticks in the template), no conflict. The existing escape pass `replace(/'/g, "\\'")` is only applied in the unquoted path (buildHandler) — the quoted path puts the user's literal in verbatim. Consistent with option-A semantics. ✓

## Verdict

ACCEPT — every closure criterion met. Quote-leak class provably blocked at the regex level; option-A handler shape correctly delivered. PH1-D-1 / SX-7 regression guard explicit and tested. CHANGELOG flags behaviour change. No test weakening. No mcp-server mirror needed.
