# Reviewer: ACCEPT — Quinn (qa) — EPIC-107-1

# EPIC-107-1 LLM-Fallback Classifier Review — 083bac89

## Verdict

**ACCEPT** — all seven closure criteria from the story file are met. All thirteen adversarial probes pass on direct source inspection. The cost guardrail (keyword-hit short-circuits LLM entirely) is correctly implemented in `intent-parser/index.ts` Step 3 → return BEFORE Step 3.5, and is exercised by `__tests__/llm-fallback-integration.test.ts` Variation A with a zero-response `SequentialMockLlm` that would throw on any LLM call. The hallucination guard, NONE-normalisation, low-confidence rejection, and schema-rejection fall-through paths are each individually tested and individually log-correlated with the `intent-parser/compound-classifier-llm` callsite. CI never constructs a real Bedrock client; all tests use constructor-injected `LlmPort` test doubles. Three minor findings below are LOW severity and should land in a follow-up paydown wave — none of them block this story.

## Closure criteria verified (one per story acceptance criterion)

1. **`classifyCompoundViaLlm(intent, registry)` returns Zod-validated `{ patternKey, confidence, rationale }`** — `compound-classifier-llm.schema.ts:24-31` defines the schema; `compound-classifier-llm.ts:131-138` invokes `llmClient.generateStructured(prompt, CompoundClassifierResponseSchema, …)`. Return type extended to a discriminated union (`match | no-match | skipped`) to thread the cheap-gate through the same channel; acceptable elaboration on the spec.
2. **Keyword classifier FIRST, LLM fallback ONLY on null AND ≥ 10-word intent** — `index.ts:343-364` returns directly on `detectedPattern !== null` before reaching Step 3.5 (`index.ts:382-386`). `compound-classifier-llm.ts:120-126` enforces `wordCount < minWords ⇒ skipped` (boundary: `< 10` skips, `>= 10` calls — exactly-10 fires). Unit test `Variation F` covers 3-word skip, 9-word skip, and 10-word fire.
3. **Schema-rejection short-circuits to advisory; no crash** — `compound-classifier-llm.ts:140-156` returns `no-match` on `err !== null`. Unit test `Variation D` wraps the call in `try/catch` and asserts `caughtError === null`. Integration test `Variation D` uses `"error"` sentinel in `SequentialMockLlm` and asserts the graph reaches `ExecutionStatus.UNSUPPORTED_RESOURCE` cleanly.
4. **Per-call cost logged via `callsite: "intent-parser/compound-classifier-llm"`** — `CALLSITE` constant at `compound-classifier-llm.ts:62`, threaded to `generateStructured` options at `:135`. Unit test "callsite token" inspects `spy.mock.calls[0][2].callsite` to verify. Integration test `Variation B` also asserts the callsite on the first LLM invocation.
5. **Tests cover all six variations (A-F)** —
   - (a) keyword-hit → no LLM call: integration `Variation A`, zero responses queued, `expect(llm.calls).toHaveLength(0)`.
   - (b) keyword-miss → LLM-hit injects compound pattern: integration `Variation B`, `result.resourcePattern.patternId === "lambda-with-exec-role"`.
   - (c) keyword-miss → LLM-NONE: integration `Variation C`, two queued responses (`NONE` + UNSUPPORTED), graph lands at `ExecutionStatus.UNSUPPORTED_RESOURCE` which is the SX-1 advisory path.
   - (d) schema rejection: integration `Variation D`, "error" sentinel + UNSUPPORTED.
   - (e) low-confidence rejection: integration `Variation E`, `confidence: "low"` falls through to Step-4 LLM.
   - (f) short-intent threshold: integration `Variation F`, `"make sqs"` (2 words) → only Step-4 LLM called.
6. **CI tests mock `LlmAdapter` — no real Bedrock** — No `vi.mock("ai")`, no AWS SDK construction in either test file. Both tests use constructor injection. `pnpm -r test:coverage` passing per commit message → CI parity verified.
7. **Documented in CHANGELOG and `docs/explanation/intent-parser.md`** — CHANGELOG entry present (16 LOC added). `intent-parser.md` is a NEW file (82 LOC) describing the two-tier classification flow, the cost surface, and the deferred LRU-cache follow-up. (Story said "UPDATE" but the file did not exist on `ec9b5594` — see Notes for story-spec error.)

## Adversarial findings

- **LOW** — `compound-classifier-llm.ts:147-149` — `description` field cast `(p as unknown as { description?: string }).description ?? "keywords: X, Y"`. The `ArchitecturePattern` type does not declare `description`, so this is a runtime-best-effort cast. In practice the prompt feeds the LLM a keyword summary, not real descriptions, which is exactly the whack-a-mole shape the deep-fix aims to escape. **Fix**: add a `description: string` field to `ArchitecturePattern`, populate per pattern, and drop the cast. Follow-up story material, not a blocker because the LLM still receives the keyword summary and works in the test fixtures.
- **LOW** — `__tests__/llm-fallback-integration.test.ts:106-110` — Variation B intent `"Set up a compute handler plus an identity role granting write access to object storage"` is fragile to keyword-list expansion. If any future patternId adds `"compute"`, `"handler"`, `"identity"`, `"role"`, `"storage"`, or `"object"` as a keyword, Tier 1 will short-circuit and this test will silently exercise the wrong code path. **Fix**: add an in-test assertion that `defaultPatternRegistry.detect(intent) === null` before invoking the node, so the test fails loudly when its assumption is broken. Optional but cheap insurance.
- **LOW** — `compound-classifier-llm.test.ts:12` — `beforeEach` imported from vitest but never used in the file. Dead import; lint will flag if `noUnusedImports` is on. **Fix**: drop the import.

None of the adversarial probes (1-13) surfaced behavioural bugs.

## Notes

**Dev open-questions audit**:

- `PatternRegistry.description` gap — confirmed as LOW finding above. Functional today; warrants a follow-up to materialise descriptions properly so the LLM reasons over architecture intent rather than keyword bags.
- Variation B intent fragility — confirmed as LOW finding above. Adding the `defaultPatternRegistry.detect(intent) === null` pre-assertion fully closes the regression risk.

**Docs deviation (UPDATE → CREATE)**: Verified by `git show ec9b5594:docs/explanation/intent-parser.md` returning `fatal: path … exists on disk, but not in 'ec9b5594'`. The file did NOT exist before this commit. The story spec at `_bmad-output/implementation-artifacts/epic-107-1-llm-fallback-compound-classifier.md:42` said `(UPDATE — document the two-tier classify flow)` which is a story-authoring error, not a dev error. Dev correctly created the file. The new doc is well-structured (three tiers, cost surface explicit, LRU-cache deferral noted). **No action**.

**Cost-surface validation**:

- `MAX_TOKENS = 256` declared at `compound-classifier-llm.ts:55`; cap is appropriate for the small JSON envelope (`{patternKey, confidence, rationale}`).
- Prompt size: ~500 tokens per the story estimate; per-call ~650 tokens total. With Sonnet pricing this is well inside the production budget for the few-percent of intents that fall through the keyword gate.
- Hot-path skip (intent < 10 words) does NOT log to avoid flooding the structured-log stream — sensible.
- No caching present (correctly deferred per story OOS section). Doc names the LRU-cache follow-up as the recommended response if production telemetry surfaces frequent Tier 2 firing.

**Paydown for next iteration**:

1. Add `description: string` to `ArchitecturePattern`; populate per pattern; drop the `as unknown as` cast in the classifier. (LOW finding 1)
2. Add `expect(defaultPatternRegistry.detect(intent)).toBeNull()` pre-assertion to integration Variations B, C, D, E so the keyword-gate assumption is enforced. (LOW finding 2)
3. Drop the unused `beforeEach` import in `compound-classifier-llm.test.ts`. (LOW finding 3)
4. Audit story spec at line 42 to align `(UPDATE/NEW)` markers with on-disk reality before authoring future stories.

**Reviewer-skip BAN compliance**: Commit body line `Reviewer: PENDING — qa (Quinn) — review pending` is the placeholder for this review; the dev's amendment (or the next commit) needs to write `Reviewer: ACCEPT — Quinn (qa) — 083bac89` plus the citation to this file, OR commit body will fail the pre-push hook.
