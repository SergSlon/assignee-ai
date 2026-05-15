# Reviewer: REJECT — Quinn (qa) — EPIC-107-2

# EPIC-107-2 Existing-Resource Discovery Review — c8d57793

## Verdict

REJECT.

Rationale: Two BLOCKER findings break stated closure criteria, plus one HIGH
silent-wrong-pick bug in the multi-match fast-path, plus the destroy-mirror
test the story Reviewer Guidance explicitly demanded is _structural-only_
(re-runs the existing dry-run path with a stub list that never contained a
VPC). The remaining ADR fidelity is good — port shape, cache reuse, no new
MCP, reader-creds isolation are all correct. But the region-scoping break
alone would silently bind a `eu-west-1` plan to `us-east-1` VPCs in prod,
which fails Variation G of the Probe Plan and AC #7 part (g). Cannot ship.

## Closure criteria verified

1. **CC1 (extractExisting + ExistingResource[])**: present at
   `packages/core/src/graph/nodes/intent-parser/extractors/existing-resource-extractor.ts:113`.
   Signature `(intent, port, region)` returns `{existing, needsElicitation}`.
   **Partial** — `tags` field was removed per Patch #2; ExistingResource shape
   is `{kind, id, label, region}`. Acceptable per dev's documented rationale.

2. **CC2 (ResourceDiscoveryPort abstracts AWS SDK)**: clean port at
   `packages/core/src/services/resource-discovery-port.ts:60-65`. No SDK
   types leak through. Production impl wraps existing direct-SDK module.
   **PASS**.

3. **CC3 (graph-state.existingResources, read-only)**: added at
   `packages/core/src/graph/graph-state.ts:349` with `default: () => []`.
   Reducer is `(_, b) => b` (overwrite, no merge — fine for plan-time
   single-write). The ~20 reader call-sites default cleanly because the
   field is annotation-defaulted. **PASS**.

4. **CC4 (cache reuse, no new infra)**: ADR-mandated. Confirmed —
   `vpc.ts`, `ecs.ts`, `elb.ts`, `rds-subnet-groups.ts` all use
   `cachedDiscover(DiscoveryCacheKey.X, ...)` from existing
   `aws-resource-discovery/cache.ts`. **PASS** at structural level, but
   see HIGH finding #2 — cache key carries no region, so cache pollutes
   across regions.

5. **CC5 (failure → CP-3 advisory fallback, no crash)**: port `safeFetch`
   wraps every fetcher in try/catch + emits `DISCOVERY_FAILURE` log.
   Extractor adds belt-and-suspenders catch. Variation D covers throw →
   `existing: [], needsElicitation: false`. **PASS**.

6. **CC6 ("Found existing X" rendered)**: `emitExistingResourceLines` in
   `plan.ts:38-44` writes one line per Existing node to stdout BEFORE the
   plan box. Snapshot test in `plan.test.ts:194` covers empty + undefined
   cases. **PASS**.

7. **CC7 (test coverage a-f)**: extractor test covers A/B/B2/C/D/F/G + multi-
   kind. Cache hit/miss (E) deferred to existing `cache.test.ts`. **Partial**
   — but see BLOCKER #1: Variation G test passes at the port surface only;
   downstream SDK calls ignore the region. AC #7(b) is the picker UX, which
   was downgraded from "elicitation prompt" to "advisory-only" — see HIGH
   finding #4.

8. **CC8 (CI uses mock, zero real AWS)**: all new tests use `vi.fn()` or
   `vi.mock("...resource-discovery-port.js")` mocks. No fetch escapes.
   **PASS**.

9. **CC9 (CHANGELOG + Diátaxis explanation page)**: CHANGELOG entry at
   `CHANGELOG.md:22-46` names live-AWS surface explicitly per Reviewer
   Guidance. `docs/explanation/existing-resource-discovery.md` exists (118
   LOC per diff stat). **PASS**.

## Self-review patch audit

- **Patch #1 (destroy mirror test)**: WEAK. The new test at
  `apps/cli/src/commands/destroy/bulk-action.test.ts:1153-1207` does NOT
  construct a graph state containing `existingResources: [...]` and prove
  bulk-destroy skips it. It just re-runs the existing dry-run path with
  `mockFetchManagedResources.mockResolvedValue([S3_BUCKET])` and asserts
  the destroyer doesn't manifest a VPC out of thin air. That's the trivial
  case. The story Reviewer Guidance says "A unit test alone is
  insufficient; add a result-formatter snapshot AND a destroy-strategy
  mirror test." The result-formatter snapshot exists; the destroy-strategy
  test added doesn't go further than the existing dry-run case. The
  second sub-test is purely type-level (`"kind" in item`). **Verdict:
  patch attempts but doesn't satisfy the demand — the call-path with an
  Existing node present is not demonstrated.**

- **Patch #2 (tags removal)**: complete. `git grep -n tags
packages/core/src/utils/aws-resource-discovery/` shows the field is
  truly gone from `ExistingResource`. Docstring explicitly notes the
  follow-up contract for raw tags. tagSubstringAutoSelect reads from
  `label` which embeds tag fragments. **PASS**.

- **Patch #3 (advisory)**: present at `intent-parser/index.ts:336-345`,
  test at `existing-resource-advisory.test.ts` covers (a) multi → advisory,
  (b) single → no advisory, (c) none → no advisory. Negative-case coverage
  is genuine. BUT this patch DOWNGRADES Story AC #7(b) — the picker via
  option-elicitor (per ADR Decision 2) is replaced by an advisory-only
  message that does NOT block. Multi-match `existing[]` still contains
  BOTH candidates, leaving downstream compound-pattern consumers to either
  pick arbitrarily or fail. See HIGH finding #4.

- **Patch #4 (defer)**: deferred-work.md not provided to me in the
  workspace I can see (no commit-tracked deferred-work.md changed in
  this diff). The story line item is `[x] [Review][Defer]` but the diff
  shows no doc update — verify before close.

## Adversarial findings

- **BLOCKER (region-scoping broken end-to-end)**:
  `packages/core/src/services/resource-discovery-port.ts:121-126` — the
  port's production impl accepts `opts: { region? }` per the interface,
  but `safeFetch` discards it (parameter is `_opts`). Downstream
  `discoverVpcs()` / `discoverEcsClusters()` / `discoverElbs()` /
  `discoverDbSubnetGroups()` in `packages/core/src/utils/aws-resource-discovery/{vpc,ecs,elb,rds-subnet-groups}.ts`
  take ZERO arguments. The underlying client factories (`createEc2Client`,
  `createEcsClient`, `createElbClient`, `createRdsClient` in
  `clients.ts:43,52,61,70,79,88,97,106`) hardcode `region: AWS_REGION`
  (module-level env var). Consequence: user intent in `eu-west-1` will
  discover `us-east-1` VPCs (or whatever AWS*REGION points to at process
  boot). Variation G test passes only because it asserts the PORT was
  called with `{region: "eu-west-1"}` — it never asserts the SDK was
  called against `eu-west-1`. This violates Story Probe Plan #G and CC #6
  ("the plan card surfaces ... (<region>)" — the region label on the line
  is the port's input region, NOT the region the SDK actually queried, so
  the user sees a \_false* region badge). **Fix**: thread `opts.region`
  through each helper (`discoverVpcs(opts?: {region?: string})`) →
  optionally rebuild client when region differs from `AWS_REGION`. Or
  document the single-region constraint explicitly in CHANGELOG +
  refuse to honour `opts.region` in the port interface signature.

- **HIGH (cache pollutes across regions)**:
  `packages/core/src/config/discovery-keys.ts:22-25` — new keys are
  region-naive strings (`"discover-vpcs"`, `"discover-ecs-clusters"`).
  `cachedDiscover()` uses the key as the cache identity. If a session
  switches AWS_REGION mid-flight (the existing CLI supports this), the
  cache returns stale results from the prior region. The existing module's
  `EFS_FILE_SYSTEMS` has the same shape, but EFS was added before regional
  workflows; the bug is being PROPAGATED here, not introduced — but with
  4 new resource kinds added in one wave, it's worth fixing now. **Fix**:
  key suffix with region: `cachedDiscover(${key}:${AWS_REGION}, ...)` —
  one-line change.

- **HIGH (tag-substring auto-select can silently pick wrong VPC)**:
  `packages/core/src/graph/nodes/intent-parser/extractors/existing-resource-extractor.ts:79-95`
  — `tagSubstringAutoSelect` uses `intentLower.split(" ").find(w => w.length>=3 && uniquely matches one candidate)`.
  Failure mode: intent "rds in my prod-eu vpc", VPCs `[prod-us, prod-eu]`.
  `find()` returns the FIRST qualifying word — if "rds" (length 3)
  appears in one label only (unlikely but legal), or if "vpc" appears in
  only one label, that wins regardless of user intent. The reverse
  failure: intent "create rds in production VPC", VPCs `[prod, staging]`
  — `production` doesn't appear in either label so the `find()` callback
  short-circuits at "rds" or "create" → fallback `____NO_MATCH____` →
  needsElicitation=true. Asymmetric. **Fix**: rank candidates by Jaccard
  / substring score over the _full intent_, then only auto-select if the
  top score is dominant. Add a test for "production" vs "prod" disambig.

- **HIGH (multi-match picker missing — AC #7(b) regression)**:
  Story Probe Plan §B says "extractor surfaces an elicitation prompt via
  existing elicited-options flow (NOT silent pick of first match)". ADR
  Decision 2 mandates the option-elicitor picker. Dev shipped only the
  advisory (`EXISTING_RESOURCE_AMBIGUOUS`) + tag-substring fast-path.
  When `needsElicitation=true`, BOTH ambiguous VPCs end up in
  `state.existingResources` and downstream compound consumers (`efs-in-existing-vpc`,
  etc.) have no contract for which to use. The "no silent pick" invariant
  is upheld trivially because nothing gets picked — the plan just renders
  two `Found existing VPC: ...` lines and an advisory. This is a regression
  from AC #7(b) — the user sees both, no prompt, no commitment. **Fix**:
  either implement option-elicitor wiring this story, or explicitly defer
  AC #7(b) with rationale in the story file and add a separate sprint
  ticket. Currently the story is mark-as-done but AC #7(b) is unsatisfied.

- **MED (no pagination — silent truncation in big accounts)**:
  `vpc.ts:24`, `ecs.ts:27`, `elb.ts:23`, `rds-subnet-groups.ts:24` — none
  of the new helpers loop on `NextToken`. AWS APIs cap default page sizes
  (~100 results). For accounts with 100+ ALBs (uncommon but legal), the
  plan silently misses some. Story Probe Plan #16 ("big-account scale")
  is not satisfied. The existing module's `discoverEfsFileSystems` has
  the same gap — propagating, not new — but the dev added 4 new fetchers
  in this PR. **Fix**: wrap each in a paginate-until-no-token loop with
  a hard cap (e.g. 500 items, log+warn beyond that). Or document the cap
  explicitly in CHANGELOG.

- **MED (DISCOVERY_FAILURE log uses fixed runId "discovery")**:
  `resource-discovery-port.ts:108`, `existing-resource-extractor.ts:139` —
  `runId: "discovery"` literal. The standing `log()` contract uses runId
  for trace correlation. With a hard-coded string, every discovery
  failure across every CLI run aggregates under the same runId, breaking
  correlation. **Fix**: thread the actual graph state `runId` through to
  the port; if unavailable at construction time, accept `runId` as a
  constructor arg.

- **LOW (destroy mirror test is not adversarial)**: per Patch #1 audit
  above. **Fix**: add a third sub-test that constructs an `AgentState`
  with `existingResources: [{kind:"VPC", id:"vpc-existing", ...}]`,
  invokes the destroy code path on that state, and asserts no SDK
  delete fires for `vpc-existing`. Currently the patch is structural,
  not behavioural.

- **LOW (`opts` parameter dead in port impl)**:
  `resource-discovery-port.ts:121-126` — every method has signature
  `async (_opts) => safeFetch(...)`. The `_opts` underscore is a code
  smell (interface contract widened to accept input that's then dropped).
  Lint should catch this with `noUnusedParameters` or
  `@typescript-eslint/no-unused-vars`. **Fix**: dovetails with BLOCKER
  fix — once `region` threads through, `_opts` becomes `opts` and is
  used.

## Notes

- **Auth surface**: confirmed reader-creds isolation via existing
  `tryAssigneeCredentials("reader")` path. No admin leak. ADR Decision 1
  point 2 is honoured.
- **Latency**: discovery runs serially per-kind inside `extractExisting`
  (sequential `await port.discoverX`). Could be `Promise.all` for
  fan-out — current shape blocks plan render by up to N×timeout. Not a
  blocker but a paydown item: ~50-200ms added serial latency per kind in
  warm-cache miss case. **Recommend**: `Promise.all` in next story.
- **Big-account scale**: see MED finding #5 (pagination).
- **ADR fidelity**: Decision 1 (Option D — extend existing direct-SDK
  module, no MCP) honoured 100%. Decision 2 (picker UX) NOT honoured —
  only the tag-fast-path landed; picker missing.
- **Paydown for next iteration**: (a) region pass-through everywhere
  (BLOCKER); (b) regional cache keys (HIGH); (c) tag-fast-path scoring
  rework (HIGH); (d) option-elicitor picker wiring (HIGH, currently
  AC #7(b) regression); (e) pagination on all 4 new fetchers (MED);
  (f) runId threading (MED); (g) parallel fan-out via Promise.all (LOW).

## Citations

- `apps/cli/src/commands/destroy/bulk-action.test.ts:1153-1207`
- `packages/core/src/services/resource-discovery-port.ts:60-65,121-126`
- `packages/core/src/utils/aws-resource-discovery/vpc.ts:19`
- `packages/core/src/utils/aws-resource-discovery/ecs.ts:22`
- `packages/core/src/utils/aws-resource-discovery/elb.ts:19`
- `packages/core/src/utils/aws-resource-discovery/rds-subnet-groups.ts:19`
- `packages/core/src/utils/aws-resource-discovery/clients.ts:43-106`
- `packages/core/src/config/discovery-keys.ts:22-25`
- `packages/core/src/graph/nodes/intent-parser/extractors/existing-resource-extractor.ts:79-95,113-188`
- `packages/core/src/graph/nodes/intent-parser/index.ts:319-345`
- `packages/core/src/graph/graph-state.ts:349`
- `packages/core/src/graph/nodes/result-formatter/formatters/plan.ts:38-44`
- `CHANGELOG.md:22-46`
