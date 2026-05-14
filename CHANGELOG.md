# Changelog

All notable changes to Assignee.ai are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both `assignee` and `@assignee/mcp-server` packages are `private: true`
— nothing is published to npm. `0.1.0` below is the internal version
baseline; no npm release is planned for the course-project submission.

For the full engineering history including BMAD story IDs, wave labels, and
review methodology notes, see
[`docs/engineering/changelog-history.md`](docs/engineering/changelog-history.md).

---

## [Unreleased]

### feat(compound-patterns): add sns-with-email-subscription compound + email-extractor (CP-2 / PH1-C-2 + DF-C2, 2026-05-14)

- core `pattern-templates/patterns/sns-with-email-subscription.ts`: NEW 2-resource
  compound pattern (`AWS::SNS::Topic` + `AWS::SNS::Subscription` with
  `Protocol=email`). `TopicArn` wired via `markerRef(R.TOPIC)`; topic provisioned
  first in `dependencyOrder`. Routes intents containing `"with email subscription
to"` / `"with subscriber"`.
- core `graph/nodes/intent-parser/extractors/email-extractor.ts`: NEW pure
  email-address extractor (`extractEmail`, `extractAllEmails`, `isWellFormedEmail`)
  using conservative regex `/[\w.+-]+@[\w-]+(\.[\w-]+)+/` with well-formed
  validation (no consecutive dots, no leading/trailing dot, TLD ≥ 2 chars).
- core `graph/nodes/intent-parser/extractors/messaging-extractors.ts`: new
  `extractEmailForSnsCompound` function. Runs on `SNS_TOPIC` primary slot;
  writes `Endpoint` which `filterElicitedForSlot` passes only to the
  `SNS_SUBSCRIPTION` slot (via new `Endpoint: SNS_SUBSCRIPTION` entry in
  `NAME_FIELD_TO_RESOURCE_TYPE`). Variation D decision: pick-first-and-advise
  (single `SNS::Subscription` per intent; advisory for extra addresses).
- Interacts with SX-2 `extractInlineName`: `"SNS topic genai-events with email
subscription to liamin.web@gmail.com"` produces `TopicName=genai-events` AND
  `Endpoint=liamin.web@gmail.com` in the same `elicitedOptions`.
- Pattern count bumped 12 → 13 in `help-hints.test.ts`, `integration-architecture.md`,
  and `README.md`.

### feat(compound-patterns): add sqs-with-dlq compound for "with DLQ" intents (CP-1 / PH1-B-1 + DF-B2, 2026-05-14)

- core `pattern-templates/patterns/sqs-with-dlq.ts`: NEW 2-resource compound
  pattern (primary `AWS::SQS::Queue` + DLQ companion). `RedrivePolicy.deadLetterTargetArn`
  wired via `markerGetAtt(R.DLQ, "Arn")`; `maxReceiveCount` defaults to 5; DLQ
  provisioned first in `dependencyOrder` so its ARN is available to the primary queue.
- Routes intents containing `"with DLQ"`, `"with dead-letter queue"`, or
  `"dead letter queue"` to the 2-resource compound. Bare SQS intents without
  DLQ phrasing continue to route to the standalone `AWS::SQS::Queue` singleton.
  `negativeKeywords: ["lambda", "processor", "message processing"]` prevents
  collision with the larger `message-processing` compound.
- DF-B2 (deferred SQS+DLQ compound gap) closes.

### Inline-name extractor for SNS/SQS/DynamoDB/Lambda/S3 (SX-2 / PH1-C-1, 2026-05-14)

- core `graph/nodes/intent-parser/extractors/name-extractor.ts`: NEW
  `extractInlineName` function runs after the explicit
  `"named X"`/`"called X"` keyword path. When the keyword path did NOT
  set the resource name AND the intent contains an inline name pattern
  (`<type-keyword> <candidate>`, e.g. `"SNS topic genai-events"`), the
  candidate is validated against the per-resource AWS naming constraint
  (S3 lowercase rule, Lambda alphanumeric+`_-`, SNS/SQS/DDB
  alphanumeric+`._-`) and written to the resource's name field
  (`TopicName`, `QueueName`, `TableName`, `FunctionName`, `BucketName`).
- core: NEW `graph/nodes/advice/inline-name-hint.ts` helper emits an
  `INLINE_NAME_DETECTED` INFO advisory documenting the extracted name and
  the explicit `"named X"` form that suppresses the hint. Confined to a
  dedicated helper file so the advisory wiring does not collide with
  SX-6's `mcp-advisor.ts` work.
- Closure conditions: explicit `"named X"`/`"called X"` still wins
  (keyword path runs first); boundary keywords (`with`, `for`, `to`,
  ...) reject as candidates; `named`/`called` rejected as candidates
  (they signal the explicit-keyword path is in play); AWS-naming
  constraint violations fall through to the auto-name generator silently
  (no user-facing error — descriptive text is allowed to follow the
  type token).
- DF-C1 (SNS topic name dropped) closes by side-effect.
- 9 probe tests in `name-extractor.test.ts` cover variations A–H per the
  story spec (single-word, kebab-case, trailing clause, boundary fall-
  through, explicit-keyword wins, S3-constraint violation, DynamoDB
  table, S3 valid lowercase) + resource without a name field.

### Suppress self-referential and stale advice lines (SX-6 / PH1-C-4 + DF-A2/B3/C4/D4/E4, 2026-05-13)

- core: NEW `graph/nodes/advice/advice-filters.ts` — exports
  `filterSelfReferentialAdvice(adviceLines, plan)` which removes advice lines
  that instruct the planner to do what the user already requested and the plan
  already reflects. Patterns matched: `"Change the <Prop> to '<X>'"`,
  `"Set <Prop> to <X>"`, `"Update the <Prop> to '<X>'"`, and `"Enable <Prop>"`
  when the plan already has the property set to a truthy value. The filter is
  CONSERVATIVE — only suppresses when the proposed value EXACTLY matches the
  current plan value; genuine future-work guidance is always preserved.
- core: `advice-generator.ts` wires the post-filter pass right before
  `finalHints` is assembled; log entry gains `filteredCount` field for
  observability. Closes DF-A2/B3/C4/D4/E4 stale-advice carryovers by
  side-effect.
- Tests: 20 probe variations in `advice-filters.test.ts` covering A-F shapes
  (2 filtered, 4 preserved) plus mixed and edge-case scenarios.

### RDS instance-class extractor honours db.t4g._ / db.r6g._ (SX-3 / PH1-F-1 + DF-E1, 2026-05-13)

- core: EXTENDED `graph/nodes/intent-parser/extractors/compute-extractors.ts`
  with new `extractDbInstanceClass(intent, intentLower, elicited, errors)`.
  Captures the user-asserted `db.<family>.<size>` token VERBATIM and writes it
  to `elicitedOptions.DBInstanceClass`. Prior behaviour silently ignored the
  user assertion and let the defaults engine emit `db.t3.micro` even when the
  user wrote `db.t4g.micro` in the intent.
- core: EXTENDED `graph/nodes/intent-parser/validators/token-validators.ts`
  with `RDS_INSTANCE_FAMILY_PREFIXES` (t2/t3/t3a/t4g/m4/m5/m6g/m6i/m7g/
  r4/r5/r5b/r6g/r6i/r7g/x1/x1e/x2g), `RDS_INSTANCE_CLASS_REGEX`, and
  `isValidDbInstanceClass`. Family set mirrors `classifyRdsFamily` in
  `packages/core/src/utils/aws-resource-discovery/rds.ts:74`.
- Extractor uses two-pass matching: strict `db.[a-z][0-9]…` regex (first
  pass) plus broad `db.<word>.<word>` fallback (second pass) so invalid
  classes like `db.zz.xxlarge` emit a USAGE_ERROR hint rather than silently
  defaulting.
- Wired into `extractAssertedValues` in `intent-parser/index.ts` (one
  new import + one call site; sequenced AFTER `extractEngineVersion` so
  both RDS assertions coexist safely).
- Tests: 30 assertions in `compute-extractors.test.ts` — validator matrix
  (11 accept / 5 reject), Variations A–F from the spec probe plan, plus a
  non-RDS guard. All 357 core test files still pass (zero regressions).
- Closes DF-E1 by side-effect (user-asserted class no longer silently
  demoted).

### SQS decomposer: render Requests + Data transfer out (PD-3 / PH1-B-3, 2026-05-13)

- core/pricing/decomposers/sqs.ts: fix Requests filter from
  `productFamily=Queue|FIFO Queue` → `productFamily=API Request` +
  `queueType=Standard|FIFO` discriminator. The old filter matched zero
  SKUs in the AWS Pricing API; the new filter matches exactly one per
  region+queue-type combination. Closes the "Requests unavailable" display.
- core/pricing/decomposers/sqs.ts: fix Data transfer out from
  `serviceCode=AmazonSQS` → `serviceCode=AWSDataTransfer` + full
  `fromLocationType/toLocationType/transferType` filters (S3 DTO pattern).
  Closes the "Data transfer out unavailable" display.
- core/pricing/filter-constants.ts: add `PricingField.QUEUE_TYPE` constant.
- core/pricing/pricing-filter-values.ts: add `QUEUE_TYPE_STANDARD` and
  `QUEUE_TYPE_FIFO` constants.
- test-fixtures/mcp-mock-responses/pricing-sqs.ts: extend with
  `sqsStandardRequestsEu` (Variation B), `sqsDataTransferOut` (AWSDataTransfer
  fixture), `sqsEmptyResponse` (Variation D — graceful fallback).
- pricing/decomposers/sqs.test.ts: full PD-3 probe suite (Variations A–E):
  A=Standard us-east-1 renders non-null Requests+DTO; B=eu-west-1 region parity;
  C=FIFO rate > Standard; D=empty response → null (no crash); E=cache-poisoning
  guard rejects+deletes AmazonSNS-keyed entry stored under AmazonSQS key.
- pricing/decomposers/integration.test.ts: update SQS variant-consistency tests
  to assert new correct filters (API Request + queueType discriminator).

### RDS free-tier class detector — db.t3.micro / db.t2.micro recognised (RG-2 / DF-E6, 2026-05-13)

- core: ADD `RDS_FREE_TIER_INSTANCE_CLASSES` set and `isRdsInstanceClassFreeTierEligible(instanceClass)`
  to `utils/free-tier/maps.ts`. The two AWS-documented free-tier classes (`db.t2.micro`,
  `db.t3.micro`) are the only members; `db.t4g.micro` (Graviton) and any medium/large
  class return `false`.
- core: ADD `RDS_FREE_TIER_STORAGE_NOTE` constant exposing the "20 GB GP2 storage/month"
  free-tier allotment for use in plan display.
- core: NEW `utils/free-tier/maps.test.ts` covering 5 probe variations (A db.t3.micro free,
  B db.t2.micro free, C db.t4g.micro NOT free, D db.t3.medium NOT free, E storage note present).
- Closes DF-E6: plan output for RDS `db.t3.micro`/`db.t2.micro` no longer relies
  solely on account-date gating; class-level eligibility is now a first-class query.

### Lambda body compound propagation — completes PR #52 regression (SX-7 / PH1-D-1, 2026-05-14)

- core: NEW `graph/nodes/intent-parser/extractors/lambda-body-extractor.ts`
  detects `"returns X"` / `"responds with X"` / `"outputs X"` / `"prints X"` /
  `"logs X"` phrases in the user intent and writes a generated Node.js
  handler body to `elicitedOptions.Code.ZipFile`. The shallow-merge spread
  in `compound-plan.ts:76-79` (`{ ...patternDefaults, ...transformedOptions }`)
  then overrides each Lambda compound pattern's placeholder ZipFile with the
  user-extracted body.
- Closes PR #52 regression: the standalone `lambda-function` plugin path
  was fixed in #52 but the four compound patterns (`lambda-with-exec-role`,
  `serverless-api`, `scheduled-lambda`, `websocket-api`) still emitted
  `body: 'placeholder'` because nothing wrote to `elicitedOptions.Code`.
- Per Winston's compound-pattern architectural memo §1 Defect C, the fix
  lives in ONE new extractor file, NOT in the 4 pattern files. Benefits
  every compound pattern containing a Lambda resource without per-pattern
  edits. CP-4 (already merged) ensures the IAM execution role is correct;
  this story ensures the function code is correct.
- Tests: 10 probe variations in `lambda-body-extractor.test.ts` (Variations
  A-F + non-Lambda guard, empty-body guard, sentence-terminator boundary,
  single-quote escaping). 2 regression-mirror tests in
  `pattern-templates/__tests__/lambda-body-propagation.test.ts` lock the
  shallow-merge spread order (placeholder is replaced; placeholder is
  preserved when intent has no body phrase).

### SECURITY/CORRECTNESS: attach AWSLambdaBasicExecutionRole to all Lambda compound execution roles (CP-4 / PH1-D-2, 2026-05-14)

**Winston memo §1 Defect C — systemic policy hole.** Four Lambda compound
patterns produced IAM execution roles with `PermissionsBoundary` set to
`PowerUserAccess` but with ZERO `ManagedPolicyArns` or inline `Policies`.
`PermissionsBoundary` CAPS the maximum permission set but does NOT GRANT
permissions — resulting Lambdas had zero IAM grants and could not write to
CloudWatch Logs, making every deployed Lambda silently broken.

- **Core fix** — four patterns now attach
  `AWSLambdaBasicExecutionRole` via `ManagedPolicyArns`:
  - `packages/core/src/pattern-templates/patterns/lambda-with-exec-role.ts`
  - `packages/core/src/pattern-templates/patterns/serverless-api.ts`
  - `packages/core/src/pattern-templates/patterns/scheduled-lambda.ts`
  - `packages/core/src/pattern-templates/patterns/websocket-api.ts`
    (`message-processing.ts` was already correct — it is the canonical reference.)
- **Doc fix** — `lambda-with-exec-role.ts` doc comment at lines 11-13
  claimed `AWSLambdaBasicExecutionRole` was attached; the code now matches
  the doc.
- **Keyword extension** — `message-processing.ts` gains `"processes sqs"`
  keyword to support the CP-4 Variation D probe intent.
- **Guard 1** — NEW
  `packages/core/src/pattern-templates/__tests__/lambda-compound-policy-parity.test.ts`:
  iterates all patterns with IAM_ROLE + LAMBDA_FUNCTION sibling pair; asserts
  `ManagedPolicyArns` is non-empty AND includes `LAMBDA_BASIC_EXECUTION_PATH`.
- **Guard 2** — NEW
  `packages/core/src/pattern-templates/__tests__/pattern-doc-parity.test.ts`:
  asserts every IAM entity named in a pattern JSDoc block (regex on
  `AWSLambdaBasicExecutionRole|AWSLambda\w+Role|PowerUserAccess|AWSManaged\w+`)
  appears in the file body (literal or canonical constant alias).
- **Guard 3** — NEW
  `packages/core/src/pattern-templates/__tests__/pattern-coverage.test.ts`:
  fixture table asserting `defaultPatternRegistry.detect(intent)` returns the
  expected `patternId` for 14 canonical Lambda-bearing intents. CP-1/CP-2
  append their fixtures in separate commits.
- **Unit tests** in each modified pattern's `.test.ts` file: assert
  `Properties.ManagedPolicyArns` contains the expected ARN.
- **Partition-aware** (Variation E): `rewriteManagedPolicyArnsForPartition()`
  correctly rewrites both `ManagedPolicyArns` and `PermissionsBoundary` to
  GovCloud / China partitions at apply time.

### EventBridge bare-Rule routing + no-target advisory (SX-1 / PH1-H-1 BLOCKER, 2026-05-13)

- core `pattern-templates/patterns/scheduled-lambda.ts`: extend the keyword
  list with four bare-Rule phrasings — `"EventBridge rule"`, `"fires every"`,
  `"fires at"`, `"trigger every"`. Intent `"Create an EventBridge rule that
fires every 5 minutes"` now routes to the `scheduled-lambda` compound
  (4 resources with a wired Lambda target) instead of producing a target-less
  `AWS::Events::Rule` with a CRITICAL finding and no path forward.
- core: NEW `graph/nodes/advice/eventbridge-no-target-hint.ts` advisor helper
  - wired into `advice-generator.ts`. When the planner still produces a bare
    `AWS::Events::Rule` with no Targets (keyword routing miss), an actionable
    HIGH advisory now suggests `assignee plan "scheduled lambda <schedule>"`
    or `--set Targets=...` to recover.
- Per Winston's compound-pattern architectural memo (`arch-compound-pattern-coverage-2026-05-13.md`),
  the long-tail fix (LLM-fallback compound classifier) is filed in
  `_bmad-output/implementation-artifacts/sprint-status.yaml` under
  `deferred-backlog.deferred-llm-fallback-compound-classifier` with rationale
  `"needs planner-fallback architecture, not keyword whack-a-mole"`.

### Tier-ladder unit-aware formatRange — 3-for-1 cost-rendering fix (PD-1 / PH1-A-1 + PH1-C-3 + PH1-D-3, 2026-05-13)

- core `pricing/tier-ladder.ts`: `formatRange(value, unit)` now switches on
  unit family instead of unconditionally rendering `GB→TB`:
  - **Byte units** (`GB-Mo`, `GB-month`, `GB`): keep `GB→TB` at ≥512 GB
    (unchanged behaviour — DDB Storage tier still renders `25 GB` /
    `40 TB` correctly).
  - **Count units** (`Requests`, `Notifications`, `Publishes`, `Messages`,
    `Invocations`, etc.): render with `k` / `M` / `B` suffix and append
    the unit name. SNS publishes that used to render as
    `"free up to 98 TB"` now correctly render as `"free up to 98B Publishes"`.
  - **Compute-second units** (`Lambda-GB-Second`, `GB-Second`): render with
    `M` / `B` suffix and append `"GB-Seconds"`. Lambda Duration tiers that
    used to render as `"$0.00001667/Lambda-GB-Second up to 5859375 TB"` now
    correctly render as `"... up to 5.86B GB-Seconds"`.
  - **Unknown units**: raw locale-formatted value + unit string, NO TB
    conversion (previously fell through to `GB→TB` which produced gibberish
    for non-storage units).
- `formatCount` helper handles the `toPrecision` round-up at the k → M
  boundary: `999_999 / 1000 = 999.999` no longer renders as `"1000k Requests"`
  but promotes to `"1M Requests"`. Same guard for M → B.
- 8 probe variations (A-H) cover byte preservation, byte small,
  Notifications, Publishes, Lambda-GB-Second, unknown unit fallback, k/M/B
  boundary cases, and case-insensitive unit family detection.
- Closes three Phase-1 dogfood findings with one fix:
  - PH1-A-1 — DDB Storage mixed unit suffix (LOW)
  - PH1-C-3 — SNS publishes "98 TB" drift (MED)
  - PH1-D-3 — Lambda GB-Seconds "5859375 TB" drift (MED)

### Security: bump langsmith pnpm override to ^0.6.0 — GHSA-3644-q5cj-c5c7 (2026-05-13)

- **CVE fix**: GHSA-3644-q5cj-c5c7 (langsmith <0.6.0 deserializes untrusted prompt
  manifests) resolved by bumping `pnpm.overrides.langsmith` from `^0.5.19` to
  `^0.6.0`; resolves to `0.6.3` (npm latest at time of fix).
- **Compatibility**: `@langchain/core@1.1.45` declares `langsmith: >=0.5.0 <1.0.0`,
  so `0.6.x` is fully within the accepted range. No code changes required.
- `pnpm audit --audit-level=moderate --prod` now reports 0 un-ignored advisories;
  the pre-existing `CVE-2026-41650` remains in `auditConfig.ignoreCves`.

### BP-SQS-003 false-positive reduction — demote to MEDIUM (BR-1 / PH1-B-2, 2026-05-13)

- best-practices: BP-SQS-003 (`SQS queue should have server-side encryption
with KMS`) demoted from HIGH → MEDIUM severity. The rule previously fired
  HIGH on every plan that set `SqsManagedSseEnabled: true`, conflating "SSE
  enabled in any flavour" (satisfied by SQS-managed SSE) with "SSE-KMS with
  a customer-managed CMK" (a compliance-workload preference). BP-SQS-001
  already covers FSBP SQS.1 (SSE enabled, any flavour) at HIGH; BP-SQS-003
  is now correctly positioned as a compliance recommendation rather than a
  universal HIGH finding.
- best-practices: BP-SQS-003 title, description, and remediation reworded to
  "compliance workloads should use SSE-KMS with a customer-managed CMK",
  mirroring the BP-S3 SSE-KMS convention. `source_id` updated to `SQS.KMS`
  to eliminate the duplicate `SQS.1` reference shared with BP-SQS-001.
- best-practices: new test file `__tests__/bp-sqs-003-scope.test.ts` covers
  all 4 combinations of `SqsManagedSseEnabled` × `KmsMasterKeyId` (Variations
  A–F from the probe plan) plus a severity-lock in `bp-all-rules-audit.test.ts`
  that prevents regression back to HIGH.

### Display polish: empty-row suppression + approxFirePerMonth helper (SX-5 / PH1-F-2+H-2, 2026-05-13)

- core `utils/display-helpers/format-desired-state.ts`: suppress config-block
  rows whose rendered value is an empty string (e.g. `VPCSecurityGroupIds: []`,
  `Comment: ""`). Previously these rows rendered as a blank label+value pair that
  looked like a corruption artefact. `null`/`undefined` values continue to render
  as `"-"` (non-empty) and are not suppressed. Both RDS empty-SG and generic
  empty-string cases are covered by new tests (probe variations A–D).
- core `graph/nodes/advice/cost-advisor/events-rule-hints.ts`: extract the
  inline rate-calculation block as the named `approxFirePerMonth(expression)`
  helper. `eventsRuleCostHints` now delegates to the helper — a single source of
  truth for the fire-count figure (8,767/mo for `rate(5 minutes)`, 731/mo for
  `rate(1 hour)`) so any future BP-EVR-XXX INFO line that needs the same count
  imports from one place. Helper is exported and covered by a dedicated test
  suite (probe variations E–F + boundary cases).

### Fix: pricingBreakdown must not leak across compound resources (PD-2 / PH1-G-1, 2026-05-13)

- core: `preflight-guard.ts` now always includes `pricingBreakdown` in the
  return object (even as `undefined`) instead of conditionally omitting the
  key. Previously, free/non-priced resources (e.g. `SubnetRouteTableAssociation`,
  `EFS::MountTarget`, `IAM::Role`) did not include the `pricingBreakdown` key in
  the partial-state return. LangGraph's annotation reducer retains a field's
  previous value when the key is absent from the update, so the EFS::FileSystem
  breakdown (Storage $0.0250/GB-month) leaked through to all four downstream
  free resources in the EFS-with-VPC compound plan.
- core: `graph-state.ts` `pricingBreakdown` annotation reducer updated from
  `(_, b) => b` to `(_, b) => b ?? undefined`. The explicit `?? undefined`
  documents intent: when the returning node sends `pricingBreakdown: undefined`
  (free resource), the reducer must actively clear the stale prior value rather
  than silently retain it.
- tests: 5-variation probe suite added to `preflight-guard.test.ts`:
  Variation A (EFS compound — no leak to SubnetRouteTableAssociation /
  EFS::MountTarget), Variation B (Lambda + exec-role — no leak to IAM::Role),
  Variation C (single S3 bucket — no regression), Variation D (SQS + DLQ —
  no over-clearing on back-to-back priced resources), Variation E (direct
  reducer contract test).

### S3 lifecycle "30d" contradiction fix (PD-4 / PH1-E-1, 2026-05-13)

- core: **fix** — intent `"Create an S3 bucket with lifecycle 30d"` now emits
  an **expire-only** LifecycleConfiguration (no STANDARD_IA transition). The
  previous behaviour emitted both an IA transition and a 30-day expiration at
  the same boundary, making the transition pointless (objects are deleted
  before they can benefit from the IA-tier price reduction). A non-blocking
  advisory is added to the plan envelope:
  `"Lifecycle simplified to expire-after-<N>d. Use 'transition to IA after Nd
then expire after Md' for a multi-tier ladder."`
- core: NEW `intent-parser/extractors/s3-lifecycle-extractor.ts` — detects
  bare `"lifecycle Nd"` / `"lifecycle N days"` phrases for S3 buckets and sets
  `LifecycleExpireOnly=true` + `LifecycleExpirationDays=N` on `elicitedOptions`.
  When the intent contains BOTH `"transition"` AND `"expire"` keywords the
  extractor defers to the full multi-rule lifecycle path unchanged.
- core: NEW `CfnKey.LIFECYCLE_EXPIRE_ONLY` wizard-only key —
  `"LifecycleExpireOnly"` — consumed by `assembleS3Composites` in
  `plan-generator/cfn-emitter.ts` to select the expire-only rule shape.
- core: `assembleS3Composites` updated to branch on `LifecycleExpireOnly`:
  `true` → `{ Id, Status, ExpirationInDays }` (no `Transitions`);
  falsy → existing full-ladder path preserved.
- tests: 21 new unit tests in `s3-lifecycle-extractor.test.ts` (5 probe
  variations A–E) + 8 new lifecycle-specific tests in `cfn-emitter.test.ts`.

### KMS alias-based default-CMK resolver (epic-104 Wave C, 2026-05-08)

- core: NEW `services/kms-alias-resolver.ts` exports
  `resolveOrCreateDefaultKmsKey()` — looks up (or atomically creates) one
  account+region-scoped customer-managed CMK addressable via the alias
  `alias/assignee-default-encryption`. The first call within a session
  paginates `kms:ListAliases` to find the alias; on a hit it returns the
  underlying key arn (after a `kms:DescribeKey` `KeyState=Enabled` sanity
  check). On a miss it creates the CMK with the project's standard
  `managed-by=assignee-ai` tag set (inline via `CreateKey`'s `Tags` —
  zero extra `TagResource` round-trips), enables key rotation
  (warn-and-continue if the operator's IAM doesn't grant
  `kms:EnableKeyRotation`), and creates the alias. A `CreateAlias`
  `AlreadyExistsException` race is handled by scheduling the just-created
  orphan key for the 7-day pending-deletion window and re-entering the
  lookup once. Subsequent calls in the same session hit the per-process
  cache. Stale alias targets (`Disabled`/`PendingDeletion`/`PendingImport`)
  raise `AssigneeError(KMS_ALIAS_STALE)` with operator-actionable advice
  rather than silently re-pointing the alias.
- core: NEW `apply_resource_created` audit-event emit on the create-path
  (re-uses Wave B-1's audit shape) so `assignee restore-provisions
--from-audit-log` can rebuild a provision record for the auto-created
  CMK. The reuse-path emits no audit event (no resource was created).
- core: NEW structured-log actions `KMS_ALIAS_CMK_CREATED` (info on
  successful create), `KMS_ALIAS_RESOLVE_PARTIAL` (warn when a non-fatal
  sub-step like `EnableKeyRotation` failed), and `KMS_ALIAS_RACE_LOST`
  (warn on the orphan-key path). All three route through the shared
  `log()` helper so `--verbose` users see them in
  `~/.assignee/logs/cli-YYYY-MM-DD.jsonl` and OTEL-configured deployments
  ship them downstream.
- iam: operator policy gains `kms:CreateAlias`, `kms:DeleteAlias`,
  `kms:ListAliases`, `kms:UpdateAlias` so the resolver can lookup-or-create
  the alias without IAM-policy churn. The four actions land in the
  existing `SECURITY_ACTIONS[KMS_KEY]` registry, so the
  `audit-iam-policies.ts` registry-driven coverage check picks them up
  automatically. `kms:UpdateAlias` is included defensively so a future
  "rotate the default CMK" flow can repoint the alias without re-touching
  the IAM policy.
- scope (deferred to a follow-up wave): plugin-level wiring that lets
  S3 SSE-KMS / SQS / SNS / Logs / EFS / EventBridge default to the
  resolved alias when the user opts into customer-managed encryption
  but supplies no `KmsKeyId`. Wave C ships the primitive + IAM + audit
  surface only; consumer plugins consume the resolver in the next wave.

### KMS alias-resolver consumer wiring — S3 / SQS / SNS plugins (epic-104 Wave D-1/D-2/D-3, 2026-05-09)

- core: NEW per-resource pre-hooks
  `graph/nodes/resource-provisioner/{s3,sqs,sns}-encryption.ts` substitute
  the Wave C alias-CMK (`alias/assignee-default-encryption`) into
  `desiredState` at apply-time when the operator did NOT supply an
  explicit customer-managed key. User-supplied values always win;
  AWS-managed alternatives (S3 SSE-S3 `AES256`, SQS `SqsManagedSseEnabled`,
  SNS bare `alias/aws/sns` sentinel) skip the substitution via
  per-plugin discriminators documented in each helper's invariants block.
  Each pre-hook fails closed (resolver throw → orchestrator returns
  FAILED with operator-actionable error message rather than silently
  falling back to AWS-managed).
- core: pre-hooks share the per-(accountId, region) cache from Wave D-0's
  `resolveDefaultKmsKeyForApply` — multiple buckets / queues / topics in
  one apply share one STS round-trip + one `kms:ListAliases` call.

**Behaviour change (cost-implications)** — bare-intent S3 SSE-KMS, SQS,
and SNS topics that previously consumed the AWS-managed key (free or
free-tier) now consume the customer-managed
`alias/assignee-default-encryption` CMK, which costs ~$1/key/month plus
$0.03 per 10 000 KMS API requests. Free-tier-sensitive deployments
should explicitly opt into the AWS-managed key per resource:

- S3: leave SSE absent OR set `SSEAlgorithm: "AES256"` (SSE-S3 free).
- SQS: set `SqsManagedSseEnabled: true` (SSE-SQS free) — already the
  plugin default.
- SNS: pass the alias-ARN form
  `arn:aws:kms:<region>:<account>:alias/aws/sns` (passes plugin validate
  and is preserved verbatim — the bare `alias/aws/sns` literal is the
  sentinel-upgrade trigger).

### `restore-provisions --from-audit-log` (epic-104 Wave B-2, 2026-05-08)

- cli: `assignee restore-provisions --from-audit-log` rebuilds missing
  `provisions.json` records from the HMAC-chained audit log produced by
  Wave B-1. Verifies the chain BEFORE any write (refuses to rebuild from
  a tampered log), acquires the existing provisions advisory lock around
  the append, writes a `provisions.json.pre-restore.<ts>` safety backup,
  and validates every reconstructed record against `ProvisionRecordSchema`
  before persistence. Skip telemetry routes through the shared structured
  `log()` helper at WARN level (new action `RESTORE_AUDIT_LOG_SKIP`).
  `--from-audit-log` and `--from <date>` are mutually exclusive — combining
  them throws `AssigneeError(USAGE_ERROR)` and exits 73. JSON envelope adds
  `mode`, `rebuiltCount`, `skippedCount`, `alreadyPresentCount`,
  `inBatchDuplicateCount`, `candidateCount`, `durationMs`, and `errorCode`
  fields for CI/automation parity.
- core: NEW `@assignee/core/locks` subpath export exposes
  `defaultFileAdvisoryLock`, `FileAdvisoryLockAdapter`, `LockAcquisitionError`,
  and the file-lock retry constants so cross-package consumers (e.g. the new
  CLI recovery path) can serialise writes against the same advisory-lock
  primitive used inside core. Implementation moved nowhere; this is a public
  re-export only.

### Audit-log provision events (epic-104 Wave B-1, 2026-05-08)

- audit: emit `apply_resource_created` event after successful `appendProvision`
  (B-1; pre-requisite for `restore-provisions --from-audit-log`). The event
  joins the existing HMAC chain (`packages/core/src/audit/audit-log.ts`) and
  carries `runId`, `resourceType`, `resourceArn`, `region`,
  `estimatedMonthlyCost`, `desiredStateHash`, and `timestamp` so a future
  Wave B-2 CLI flag can rebuild a missing `provisions.json` record from the
  audit log alone. Audit-emit happens AFTER the provisions advisory lock is
  released so audit fsync latency does not serialise provisions throughput.
  Audit-emit failure is non-fatal — the provision write is the source of
  truth and a structured `MEMORY_WRITE_FAILED` warning is logged on failure.

### S3 bucket destroy IAM fix — AWS tag-scoping limitation workaround (2026-05-07)

`assignee destroy <s3-arn>` (single and bulk) now succeeds for all
assignee-managed S3 buckets. Previously the operator user received
`AccessDenied: no identity-based policy allows the s3:DeleteBucket action`
even though the bucket carried the `managed-by=assignee-ai` tag and the
policy explicitly granted `s3:DeleteBucket` with an `aws:ResourceTag`
condition.

Root cause: AWS does NOT auto-populate `aws:ResourceTag` into the IAM
request evaluation context for `s3:DeleteBucket` and `s3:DeleteBucketPolicy`.
The `StringEquals` condition receives `<missing>` for the tag value, returns
false, and the Allow never matches. Confirmed via `aws iam simulate-principal-policy`
(returns `EvalDecision: implicitDeny`, `MissingContextValues` includes
`aws:ResourceTag/managed-by`) and via direct live testing.

This is NOT a code bug — it is an AWS-side limitation specific to S3
bucket-level destructive operations. Lambda / EC2 / ECS / SQS / SNS / RDS
and S3 object-level operations (DeleteObject / DeleteObjectVersion) all
correctly receive the resource tag and remain tag-scoped.

#### Changed (security-sensitive — re-run `assignee setup` required)

- Operator IAM policy: `s3:DeleteBucket` and `s3:DeleteBucketPolicy` moved
  from `ServiceDestructiveResourceTagScoped` (which carries
  `aws:ResourceTag/managed-by = assignee-ai`) to a new dedicated statement
  `S3BucketDestructiveResourcePrefixScoped` with `Resource: "arn:aws:s3:::*"`
  and NO Condition. `Resource: "arn:aws:s3:::*"` is the narrowest possible
  scope — S3 bucket ARNs have no account-ID slot.

- **Security tradeoff**: the operator can technically issue `s3:DeleteBucket`
  against any S3 bucket in the account. Non-assignee buckets remain protected
  by their own bucket policies' default deny. See
  [docs/explanation/security-model.md](docs/explanation/security-model.md)
  for the full analysis, mitigations, and compensating control.

- `s3:DeleteObject` and `s3:DeleteObjectVersion` remain in
  `ServiceDestructiveResourceTagScoped` — object-level operations correctly
  receive the `aws:ResourceTag` context and do not need this workaround.

#### Added

- `docs/explanation/security-model.md` — documents the operator IAM policy
  structure, the tag-scoping principle, the S3 bucket-level AWS limitation
  (with empirical evidence and mitigations), and all scoped statement
  rationales.

- **Compensating bucket policy at `assignee apply` time (Part 2)**: every
  `assignee apply` that creates an S3 bucket now also calls
  `PutBucketPolicy` to attach a resource-based bucket policy granting the
  operator the 6 destructive actions (`DeleteBucket`, `DeleteBucketPolicy`,
  `DeleteObject`, `DeleteObjectVersion`, `ListBucket`, `ListBucketVersions`)
  conditional on `aws:ResourceTag/managed-by = assignee-ai`. Bucket policies
  (resource-based policies) DO evaluate `aws:ResourceTag` correctly for
  bucket-level operations, restoring the per-bucket tag boundary that the
  identity-policy limitation prevents.
  - Non-blocking: if `PutBucketPolicy` fails (throttling, IAM gap), a
    loud warning is printed to stderr and logged, but the bucket
    creation is NOT rolled back. The identity policy already allows
    destructive operations so the bucket remains fully functional.
  - Applies to both single-resource and compound-pattern apply paths
    (e.g. static-website pattern).

#### Operators must re-run `assignee setup`

The operator IAM policy schema changed (new `S3BucketDestructiveResourcePrefixScoped`
statement; `s3:DeleteBucket` + `s3:DeleteBucketPolicy` removed from
`ServiceDestructiveResourceTagScoped`). After pulling this update, run:

```sh
assignee setup
```

---

### SSH-bundle UX epic + pre-demo audit closure (2026-05-05 / 2026-05-06)

`assignee apply "Create EC2 with SSH"` now delivers a working SSH
session end-to-end in one step. Previously the bundle compound-
provisioned the security group + EC2 KeyPair but stopped short on
4 axes that left the user staring at an ARN with no way to connect.
Eleven commits land the epic + the audit-closure cluster:
`75907252` (epic, 4 stories), `5aeab09a` env-writer cascade
integration test, `24cc60a4` env-writer paired-token eviction,
`bd80bda4` vitest mock-graph deadlock fix, then `45f1caa8` /
`f4e832fb` / `286a96d9` / `2a9a2344` / `f0ae89d2` / `581f8fc0`
closing the pre-demo audit findings.

#### Added

- `assignee describe <run-id-or-arn>` — re-renders the apply-success
  line for a previously-applied resource with a live `DescribeInstances`
  overlay for EC2 and an inline `(was X at apply time)` annotation
  when the public IP has diverged (stop/start cycles re-issue public
  IPs). Read-only; never mutates provision records. Supports `--json`
  / `-o json` for scripts.
- SSH-bundle Phase-2 IAM pre-hook (`ssh-iam.ts`): auto-creates a
  `assignee-ssh-<runId-suffix>` IAM Role + InstanceProfile carrying
  `AmazonSSMManagedInstanceCore` so the EC2 is SSM-reachable even when
  SSH is firewalled. All AWS calls idempotent; partial-failure cleanup
  via the existing rollback path. Tags `managed-by=assignee-ai` +
  `assignee-run-id=<runId>` so the role/profile are discoverable for
  any future IAM-aware destroy sweep (per `feedback_iam_role_rgta_gap`).
- Public IP + DNS lines in apply-success output for EC2 instances.
  Non-EC2 callers (RDS / Lambda / S3) silently skip the network
  block (no DescribeInstances call wasted).
- `Connect: ssh -i ~/.assignee/keys/<key>.pem <user>@<ip>` line in
  apply-success when the SSH bundle was active AND the local `.pem`
  exists on disk. AMI-Name → default-user mapping covers AL2023 /
  AL2 / Ubuntu / Debian / RHEL / SLES / CentOS with `ec2-user`
  fallback + warn-level hint. Windows-AMI fail-fast at compound-plan
  time prevents wasting compute on an unconnectable instance.
- `STALE_SESSION_TOKEN` error code + catalog entry. AWS rejects
  carrying "The security token included in the request is invalid",
  "InvalidClientTokenId", "ExpiredToken[Exception]", or
  "TokenRefreshRequired" now route to the actionable
  "re-run `assignee setup` to refresh credentials" hint instead of
  the misleading "No AWS credentials detected".
- Post-destroy IAM cleanup: `assignee destroy <ec2-arn>` now tears
  down the auto-created SSH-bundle IAM role + instance profile via
  deterministic name derivation (no IAM listing call needed). Best-
  effort with NoSuchEntity tolerance and an actionable hint when
  DeleteRole hits DeleteConflict.

#### Changed

- BP-EC2-004 ("EC2 should have IAM instance profile attached") no
  longer fires in the plan box for the canonical
  `Create EC2 with SSH` intent. The original suppressor's
  `mustHaveDesiredKey` guard required `desiredState.IamInstanceProfile`
  to be populated at suppressor-eval time, but `bp_evaluator` runs at
  plan time while `ensureSshIamProfile` only populates the slot at
  apply time — the guard always failed and the BP fired spuriously.
  Future entries that need the guard back can still set
  `mustHaveDesiredKey`; the SSH entry now omits it because the intent
  alone is sufficient evidence the bundle WILL satisfy BP-EC2-004 at
  apply time.
- `isSshIntent` shared helper replaces five separate bare
  `/\bssh\b/i` regex sites (resource-provisioner / plan-generator /
  bp-evaluator). The helper rejects negation phrasings ("without ssh",
  "no ssh", "disable ssh", "remove ssh", "drop ssh", "skip ssh",
  "ssh disabled", "ssh off") so an intent like
  `Create EC2 without SSH` no longer silently fires the bundle. 30+
  unit tests pin the negation matrix.
- Operator IAM policy gains 6 instance-profile actions
  (`iam:CreateInstanceProfile`, `iam:DeleteInstanceProfile`,
  `iam:GetInstanceProfile`, `iam:AddRoleToInstanceProfile`,
  `iam:RemoveRoleFromInstanceProfile`, `iam:TagInstanceProfile`)
  scoped to `arn:*:iam::*:instance-profile/assignee-*`. Existing
  operator users must re-run `assignee setup` to pick up the new
  policy version.
- `mergeEnvFile` evicts paired stale `*_SESSION_TOKEN` entries when
  `assignee setup` rotates `*_ACCESS_KEY_ID` without a matching
  session token in the same update. Regex constrained to the
  explicit `ASSIGNEE_(?:OPERATOR|READER|AUDITOR)_ACCESS_KEY_ID`
  allowlist so unrelated session tokens (`AWS_SESSION_TOKEN` from
  `aws sso export`, `MCP_AWS_SESSION_TOKEN`, compound-named tokens)
  never get accidentally evicted.
- `describe` command's Connect line silently suppresses when the
  local `~/.assignee/keys/<name>.pem` does not exist on the current
  machine (cross-machine describe scenario). Mirrors apply-single's
  existsSync gate; renderer's own `if (!keyName) return;` short-
  circuits naturally.
- `describe` is now wired into the static shell-completion generator
  (`apps/cli/scripts/generate-completions.ts`); regenerated
  `assignee.{zsh,bash,fish}` scripts include the command + its
  `-o / --output` and `--json` flags.

#### Fixed

- vitest 3.2.4 mock-graph deadlock (`bd80bda4`): four test files
  parked on `kevent` because their `vi.mock("../llm/adapter.js", ...)`
  factories did `await import("../index.js")` while the same file
  identity-mocked `../index.js`. Replaced inner `await import(...)`
  calls with leaf-module imports (`../errors.js`,
  `../types/result.js`) — neither is identity-mocked, so the cycle
  is broken; tests use the REAL classes (preserves
  `instanceof AssigneeError`, `alreadyRendered` field).
- Apply-time `compound-helpers.ts` injects an SSH `KeyName`
  placeholder ONLY when intent affirmatively asks for SSH; same for
  the `llm-plan/resource-post-process.ts` mirror.
- Reviewer-token grammar in commit bodies: every closing commit in
  this cluster carries `Reviewer: SKIP — <reason>` matching the
  `.husky/pre-push` hook regex; pushes are not blocked by the
  reviewer-evidence gate.

#### Deferred (not code-fixable in this epic)

- B1: re-running `assignee setup` to pick up the new operator-policy
  version is a user action requiring admin AWS credentials.
- H1: verifying keypair ↔ `.pem` coherence (`aws ec2
describe-key-pairs --key-names assignee-ssh-key`) is a user-side
  pre-demo prep step.

### Full-project audit closure (2026-04-26 / 2026-04-27)

Closes the highest-ROI cluster of findings from a 9-persona / 11-input
full-project audit: release-pipeline correctness, supply-chain hygiene,
process-governance enforcement (reviewer-evidence on every commit body),
and two follow-on bug-hunt remediation passes that fixed real issues
introduced by the prior waves' rapid integration. Five commits land the
changes (`80d639b` release/CI gates, `f4bbf7d` governance + audit
closures, `7223642` first bug-hunt remediation, `2422324` second
bug-hunt remediation, `fc22e6a` tenant-cache scoping as a
SaaS-readiness foundation step).

#### Added

- CodeQL security analysis workflow (`.github/workflows/codeql.yml`)
  with weekly cadence plus push and pull-request triggers.
- Dependabot configuration (`.github/dependabot.yml`) with grouped npm
  and `github-actions` ecosystem updates.
- CI security gate workflow (`.github/workflows/ci-security.yml`)
  running 5 previously-orphaned audit scripts (`audit-action-pins`,
  `audit-secrets-inherit`, `audit-overrides`, `audit-homebrew-pin`,
  `audit-codeowners`) on every push and PR.
- Anchore SBOM scanning step in the release pipeline; SARIF results
  surface in the GitHub Security tab.
- Cost-ledger artifact upload in the nightly E2E workflow so the
  FinOps monthly-budget gate has data to enforce against (the
  monthly-budget consumer was previously reading an artifact that
  no producer step ever uploaded).

#### Changed

- Release-pipeline gates now read from repository Variables
  (Settings → Secrets and variables → Actions → Variables) instead
  of Secrets. Prior `env.*` references inside job-level `if:`
  clauses were silently ineffective per GitHub Actions
  context-availability rules; gates appeared green but were
  actually never evaluated.
- The pre-push hook now enforces a reviewer-evidence token on every
  commit body being pushed: one of `Reviewer: ACCEPT`,
  `Reviewer: SKIP — <reason>`, or a
  `_archive/reviews/<sha>-review.md` citation. Force-push and
  shallow-clone scenarios fail closed; tag pushes are exempted.
- `audit-no-suppress` script extended to scan
  `.github/workflows/*.yml` in addition to
  `.github/actions/*/action.yml`, closing the gap where workflow
  files could silently mask CLI failures with `|| true`.

#### Fixed

- `vacation-quality.yml` no longer suppresses doc-lint failures with
  `|| true`. The doc-lint command was also corrected to invoke the
  workspace-root script (the previous `pnpm --filter assignee
doc-lint` never matched any package and the suppression hid the
  failure).
- `nightly-e2e.yml` cost-ledger upload now resolves `$HOME`
  correctly. The previous configuration used a literal `~`, which
  `actions/glob` does not shell-expand, so the artifact glob
  matched nothing.

### Full-project audit closure (continued)

A second bug-hunt remediation pass landed at `2422324` after a
review of the integration state at `7223642` surfaced a fresh round
of issues, and a tenant-cache scoping wave landed at `fc22e6a` as
a SaaS-readiness foundation step.

#### Changed

- The release-pipeline SBOM job now declares all four required
  permissions explicitly (`contents`, `id-token`, `attestations`,
  `security-events`). The previous configuration relied on
  workflow-level defaults that GitHub Actions does not propagate
  into job permission blocks once any job declares its own
  `permissions:` map; the SARIF upload to the Security tab and the
  release-asset upload were both silently denied even though the
  job appeared green.
- The pre-push hook is now exempted for tag pushes
  (`refs/tags/*`). The reviewer-evidence gate fired on
  release-tag pushes that legitimately carry no new commits,
  blocking the publish flow; tag pushes now skip the scan.
- The pre-push hook's `git log -n 50` fallback is removed in
  favour of a fail-closed posture: if the upstream-range
  computation fails (force-push, shallow clone, missing
  remote-tracking ref), the hook errors out with a remediation
  hint instead of silently scanning a 50-commit window that
  could let unreviewed commits ride along.
- The pre-push hook's default-branch detection now falls back
  through `main` → `master` → `develop` → `trunk` rather than
  hardcoding `main`, so the gate works on repositories that
  haven't migrated branch names.
- The `audit-no-suppress` script's CLI surface was rewritten as
  an explicit YAML state machine (was a hand-rolled regex chain
  that mis-handled multi-line scripts and quoted strings); the
  same script now also indirects its `|| true` and `2>/dev/null`
  idiom-detection through a small lookup so the patterns are
  testable in isolation.

#### Changed (continued — `fc22e6a` SaaS-readiness foundation)

- Introduced a tenant-scoped cache abstraction that prepares the
  codebase for multi-tenant SaaS operation. Five module-level
  singletons (best-practices rule loader, marker resolver,
  free-tier catalogue, ARN resolver, EC2 instance-type catalogue)
  migrated from per-process caches to per-tenant caches isolated
  by a request-scoped tenant identifier. Twenty-four new isolation
  tests assert that two concurrent tenants cannot observe each
  other's cached state. No user-visible behaviour changes for the
  single-tenant CLI path; this is a foundation step for upcoming
  SaaS work.

### Code quality and test coverage improvements

Closed the final batch of deferred audit items: raised CLI branch
coverage to ≥80% in the five lowest-covered files, expanded
`validatePlanShape` from 2 to 22 of 25 resource types, added a CI
FinOps monthly-budget workflow, and cleaned up all 14 deprecated
symbols across the codebase.

#### Added

- CLI branch coverage raised to ≥80% for
  `apps/cli/src/billing/recommendations.ts`,
  `apps/cli/src/cleanup/checkpoint-dry-run.ts`,
  `apps/cli/src/cleanup/cache-dry-run.ts`,
  `apps/cli/src/views/drift-detail.ts`, and
  `apps/cli/src/utils/command-runner/credentials.ts`. 84 new tests
  across 4 new test files and 2 extended test files.
- `validatePlanShape` in
  `packages/core/src/graph/nodes/plan-generator/llm-helpers.ts`
  refactored to a `PLAN_SHAPE_VALIDATORS` registry. 20 new per-type
  validators covering IAM Role trust policy, Lambda Code one-source-only,
  EC2 ImageId required, SQS/SNS FIFO suffix, SSM Parameter Type enum,
  Logs retention discrete values, ApiGatewayV2 protocol enum,
  SecretsManager mutually-exclusive sources, EC2 VPC/Subnet required
  fields, RDS DBSubnetGroup ≥2 subnets, CloudWatch ComparisonOperator
  enum, ELBv2 Scheme enum, EFS encryption ↔ KmsKeyId, Events Rule
  pattern OR schedule, KMS KeyPolicy required, EC2 SecurityGroup VpcId,
  RouteTable VpcId, and NAT Gateway SubnetId + AllocationId.

#### Changed

- New `.github/workflows/finops-monthly-budget.yml` (weekly cadence)
  and `scripts/finops-aggregate.mjs` aggregate nightly cost-ledger
  JSONL files in a rolling 30-day window and fire an alert webhook
  when spend exceeds `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD` (default
  $50). `docs/explanation/ci-gates.md` extended with a new sub-section
  and gate inventory row.
- ANSI-escape coverage for `memoryHints` in
  `packages/core/src/utils/display-findings.ts:185-195` verified with
  new `display-findings.test.ts` (8 tests: null/empty guard, non-TTY
  plain output, TTY ANSI emission).
- CI Prettier format check added to `.github/workflows/ci-core.yml`
  between Lint and Type-check steps, closing the gap where
  `git commit --no-verify` could bypass format enforcement entirely.

#### Removed

- All 14 deprecated symbols removed: `AwsManagedPolicy.LAMBDA_BASIC_EXECUTION`
  / `POWER_USER_ACCESS`, `PROVISIONS_FILE` / `FAILURES_FILE`,
  `EnvVar.ASSIGNEE_MODEL`, `INVALID_DESIRED_STATE_CODE`,
  `renderApplyNowConfirm`, `promptWithHelp` positional overload,
  `createCoreMockTools`, and 4 mcp-server destroy-strategy shims.
  19 files modified; 4 shim files deleted.
- `operatorCredentials` deprecated symbol and its test file removed.
  `packages/core/src/config/operator-credentials.ts`,
  `apps/cli/src/config/operator-credentials.ts`, and their tests
  deleted. 11 call sites across 9 files migrated to
  `requireAssigneeCredentials("operator")` or
  `tryAssigneeCredentials("operator")`. ~105 LOC net removed.
- `@langchain/langgraph` caret-range concern resolved: all three
  `@langchain/*` packages reached `1.x`; no code changes required.

#### Fixed

- `apps/cli/src/utils/command-runner/credentials.ts` test: queued
  exactly `MAX_PROVISION_LOOPS` in-loop mocks so the post-break
  `getState` call hits the catch-all mock with the expected SUCCESS
  shape, eliminating a TypeError on `.executionStatus` read.
- `checkpoint-dry-run` tests: used `fs.utimes()` to age candidate
  files to 1h in the past, bypassing the pruner's
  `skipRecentMinutes=10` recency guard.
- Lazy credential resolution restored at
  `packages/core/src/graph/create-graph.ts` and
  `apps/cli/src/services/destroy-service.ts` — both sites now use
  `tryAssigneeCredentials("operator")` with empty-string fallback
  so graph construction and destroy orchestration do not hard-throw
  on missing credentials.

### Security hardening and compliance follow-up

Addressed high-severity audit findings: E2E compound-pattern test
coverage completed, CI alerting hardened, dead env-var slots removed,
and audit-log silent-swallow pinned with regression tests.

#### Added

- E2E compound-pattern test grid completed: `e94-websocket-render.test.ts`
  and `e94-vpc-public-only.test.ts` now ship 6 real Section A tests
  (3 per pattern, mock-mode, always-runs) covering pattern detection,
  compound-dispatcher queue shape, and pattern `defaultOptions`. All
  11 compound patterns now have E2E coverage.
- Audit-log silent-swallow regression test:
  `apps/mcp-server/src/utils/__tests__/audit-log.test.ts` (+195 LOC,
  14 tests) pins that when `fs.appendFile` fails, the function does
  not throw to the caller and fires `mcpLogError` on stderr with
  `{tool, runId, errorClass}`.

#### Changed

- `nightly-e2e.yml` now requires 3 consecutive failures before firing
  the alert webhook or opening a sticky GitHub issue (implements the
  documented acceptable-miss window policy).
- `mock-fixture-drift.yml` now fires a webhook on every failure (was
  missing the webhook step entirely). Tracking-issue branch fires for
  both runtime errors and fixture mismatches.
- `docs/explanation/ci-gates.md`: corrected stale env-var name, added
  drift gate inventory row, and clarified the issue-open policy.

#### Removed

- Dead per-node LLM env-var slots removed from
  `packages/core/src/constants/env-vars.ts`:
  `ASSIGNEE_LLM_PLAN_GENERATOR`, `ASSIGNEE_LLM_INTENT_PARSER`,
  `ASSIGNEE_LLM_ADVICE_GENERATOR`, `ASSIGNEE_LLM_WORKLOAD_CLASSIFIER`.
  Factory sites were never built; `ASSIGNEE_LLM_DEFAULT` remains the
  single active slot. `docs/configuration.md` and
  `docs/explanation/ai-architecture.md` updated accordingly.

### Security audit — high-severity findings remediation

Three high-severity security findings addressed: path-traversal guard
on `drift --output-file`, prompt-injection hardening for MCP-derived
snippets, and Bedrock Guardrail visibility in the doctor command.

#### Added

- `apps/cli/src/utils/safe-output-path.ts` — `validateOutputPath`
  rejects NUL bytes, path-traversal escapes, and absolute paths
  outside CWD (CWE-22). `apps/cli/src/commands/drift/orchestrator.ts`
  validates before every `fs.writeFile`.
- `packages/core/src/graph/nodes/advice-generator.ts` now wraps each
  MCP-derived snippet (`pricingSnippet`, `docSnippet`, `securitySnippet`)
  in `stripPromptBoundaryTags` before concatenation into the LLM advice
  prompt, closing the silent-injection vector for drift-poisoned MCP
  responses.
- Bedrock Guardrail missing-state surfacing: Bedrock invocations without
  a configured Guardrail emit a one-time stderr warning and `assignee doctor`
  flags it as a HIGH-severity sub-check. `BEDROCK_GUARDRAIL_DISABLE=1`
  suppresses both surfaces as an informed-acceptance opt-out.

#### Fixed

- `apps/cli/src/commands/doctor.test.ts`: stale `section.status === "ok"`
  assertion updated to set `BEDROCK_GUARDRAIL_DISABLE=1`, isolating the
  LLM-adapter health check from the new Guardrail sub-check.

### Identity scaffolding

#### Added

- `packages/core/src/audit/hmac-chain.ts` — per-tenant HMAC chain
  (`computeChainLink` + `verifyChainLink`). Each audit-log record
  carries `HMAC(key, prevHmac || record_serialised)`; corrupting any
  single record breaks the chain and the verifier identifies the index.
  Meets ISO 27001 A.12.4 logging-and-monitoring for the in-process scope.
- `packages/core/src/audit/audit-log.ts` — append-only audit log with
  chain metadata `{record, hmac, prevHmac, index}`. Writes go through
  the advisory-lock service so concurrent writers don't corrupt the
  chain. File-mode 0o600.
- `packages/core/src/audit/audit-verifier.ts` — chain walker returning
  `{ ok: true }` or `{ ok: false, brokenAt, reason }`. Pre-HMAC records
  bypass the verifier with a clear marker.
- `assignee audit-verify` CLI command — runs the verifier against the
  local audit log; exit 0 on clean, non-zero with diagnostics on a
  broken chain.
- `packages/core/src/rbac/{policy-schema,policy-store,role-context}.ts`
  — Zod schema (role + actions + resource-glob), in-memory and file
  adapters, `"operator"` role context. Five fixtures committed (admin /
  operator / read-only / auditor / restricted). Audit-log records carry
  the role field. RBAC enforcement at command boundaries is deferred.
- `packages/core/src/identity/{oidc-port,in-memory-oidc-adapter}.ts`
  — `OIDCPort` interface (`validateToken`, `extractClaims`,
  `refreshToken`) with a fixture-backed in-memory adapter.
- `apps/cli/src/utils/account-id-validator.ts` — 12-digit numeric
  format, partition-agnostic, rejects placeholder test account IDs.
- `--target-account <ID>` flag on `plan`, `apply`, `destroy` (surface
  only — emits a not-yet-implemented message; single-account flow
  unchanged when the flag is absent).
- `ProcessExitCode.NOT_IMPLEMENTED = 12` enum entry.

#### Compliance

- HMAC chain + verifier satisfies ISO 27001 A.12.4 for in-process
  audit-log writes. KMS-signed S3 object-lock remote sink and RBAC
  command-boundary enforcement are deferred to the enterprise identity
  tier.

### Distribution and release pipeline

#### Added

- `.github/workflows/release.yml` — full build → SBOM → provenance →
  publish pipeline, DRY-RUN-by-default. Eight `ASSIGNEE_RELEASE_PUBLISH=1`
  gates across every publish-side step (npm, binaries, GitHub release,
  smoke-test, SBOM, provenance, Homebrew tap). Nothing publishes until
  the flag is flipped; tag pushes alone produce no external artefacts.
- `CODEOWNERS` at repo root with `* @founder` catch-all baseline.
- `docs/explanation/codeowners-and-branch-protection.md` — SOC 2 CC8.1
  / ISO 27001 A.6.3 control baseline; required-status-checks table and
  `gh api` enablement example.
- `scripts/audit-codeowners.ts` — CI lint asserting `CODEOWNERS` exists,
  parses, and contains a catch-all rule.
- `scripts/verify-domain-mx.ts` and `verify-domain-ownership.ts` —
  re-runnable MX and TXT verification for `assignee.ai` /
  `app.assignee.ai`. Injectable resolver keeps unit tests deterministic.
- `scripts/generate-release-notes.ts` — produces external-facing
  release notes from `git log <from>..<to>`. Groups commits into
  Keep-a-Changelog categories and suppresses internal noise.
- `homebrew/assignee.rb` extended with SHA256 provenance comments and
  `cosign verify-attestation` instructions; the Homebrew tap publish job
  is gated behind both `ASSIGNEE_RELEASE_PUBLISH=1` and
  `ASSIGNEE_TAP_PUBLISH=1`.
- `docs/how-to/release-process.md` and
  `docs/how-to/install-via-homebrew.md` — cover DRY-RUN-by-default
  semantics and the private-tap install path.

#### Fixed

- Remaining unverified `TODO-PIN` SHAs in `release.yml` resolved to
  GitHub-verified values for `anchore/sbom-action`,
  `sigstore/cosign-installer`, and `softprops/action-gh-release`.
  `scripts/audit-action-pins.ts` now exits 0.

### SaaS-backbone scaffolding

#### Added

- `packages/core/src/checkpoint/port.ts` — `CheckpointerPort` Hexagonal
  port (save/load/list/delete/prune). In-memory and file-backed adapters
  ship with shared port-contract test coverage; HMAC + 0o600 +
  atomic-write invariants retained.
- `packages/core/src/locks/advisory-lock-port.ts` and
  `file-advisory-lock.ts` — `AdvisoryLockPort` with `withLock(name, fn)`
  plus a file adapter using `O_CREAT|O_EXCL` atomic acquisition and 10 s
  stale-lock reclamation. Verified with a 10-concurrent-writer contention
  test.
- `packages/core/src/telemetry/telemetry-event-schema.ts`,
  `telemetry-port.ts`, `in-memory-telemetry-adapter.ts` — `TelemetryEvent`
  schema and `TelemetryPort.emit` / `emitFiltered`. Off by default via
  `ASSIGNEE_TELEMETRY_ADAPTER` gate.
- `scripts/backup-provisions.ts` — copies
  `~/.assignee/memory/provisions.json` to dated backups with 7-day
  rotation, 0o600, atomic-write.
- `assignee restore-provisions [--from <date>]` CLI command — restores
  the destroy-safety registry from the latest or specified-date backup.
- 13 of 14 graph nodes (HUMAN_APPROVAL excluded) now emit telemetry at
  entry and exit through `withTelemetry` in `create-graph.ts`.

#### Changed

- Memory-recorder writes (`writeProvisionRecord`, `writeFailureRecord`,
  `upsertPatternRecord`) now acquire the advisory lock around the
  write+fsync, adding concurrency safety without changing semantics.

### EU-residency and partition support

#### Added

- `packages/core/src/utils/url-validator.ts` — scheme allowlist
  (`https://` always; `http://` only for `localhost`). `ASSIGNEE_SAAS_URL`
  and `OLLAMA_BASE_URL` now validate through this helper with actionable
  rejection messages.
- `packages/core/src/saas/saas-url.ts` — region-derived
  `SAAS_API_URL` default (`https://<region>.api.assignee.ai`); explicit
  `ASSIGNEE_SAAS_URL` override validated by the URL validator.
- `packages/core/src/provisioning/ccapi-partition-support.ts` — partition
  × resource-type CCAPI support matrix. S3, IAM, and VPC prefer the
  SDK-direct path in non-commercial partitions even where CCAPI nominally
  works, due to uneven property-surface coverage.
- `packages/core/src/provisioning/partition-aware-provisioner.ts` —
  router dispatching to SDK-direct in non-commercial partitions or
  emitting an actionable "not supported in `<partition>`" message.
- `packages/core/src/provisioning/sdk-direct-fallback/{s3-bucket,iam-role,ec2-vpc}.ts`
  — SDK-direct adapters for S3, IAM, and EC2 VPC in GovCloud / China /
  ISO / EU Sovereign Cloud partitions.
- 7-region matrix tests for region-derivation defaults.

#### Changed

- `DEFAULT_AWS_REGION` derived from `process.env.AWS_REGION` (falls
  back to `us-east-1` only when unset). EU operators with `AWS_REGION`
  set no longer hit US-East defaults.
- Bedrock model invocation derives the inference-profile prefix
  (`eu.` / `ap.` / `us.`) from the resolved region.
- `KNOWN_BEDROCK_REGIONS` updated: adds `eu-west-2` and `eu-north-1`.
- `eu-isoe-west-1` now correctly maps to the `aws-iso-e` partition.
  Synthesised ARNs round-trip parse for all 5 partitions (`aws`,
  `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-e`).

#### Compliance

- GDPR Chapter V (Articles 44-49) cross-border-transfer remediation at
  the technical layer. GovCloud, China, ISO, and EU Sovereign Cloud
  partitions now receive SDK-direct provisioning paths.

### Sensitive-field redaction in plugin memory

#### Added

- `ResourceField.sensitive?: boolean` marker on the plugin elicited-field
  type. Default `false`; existing plugins remain back-compatible.
- `stripSensitiveFromElicited(record, sensitiveNames)` helper in
  `packages/core/src/utils/redact.ts` — replaces sensitive field values
  with `[REDACTED]` before writing to disk.
- `redactLogContent()` in `packages/core/src/telemetry/otel-allowlist.ts`
  — line-by-line allowlist filter used by `scripts/scrub-logs-for-upload.ts`
  before uploading JSONL log artefacts.
- `filterSensitiveElicitedFields(extras, sensitiveNames)` in
  `otel-allowlist.ts` — OTEL emission filter that drops sensitive fields
  from `event.extras`.
- `scripts/migrate-patterns-cleartext.ts` — idempotent dry-run-by-default
  migration that redacts credentials from existing
  `~/.assignee/memory/patterns.json`. Backs up before mutation.
- `scripts/audit-patterns-cleartext.ts` — CI-runnable audit scanning the
  patterns file for credential and AKIA-key patterns.
- Plugin annotations: `rds-dbinstance/credentials.ts` (`MasterUserPassword`),
  `secretsmanager-secret.ts` (`SecretString`), and
  `events-connection.ts` (`AuthParameters`) now declare `sensitive: true`.

#### Fixed

- `upsertPatternRecord` now strips sensitive fields before `JSON.stringify`.
  Pattern-memory records no longer persist credentials elicited by wizards.
- `writeFailureRecord` applies `redactAccountIdsInPrompt()` to the
  captured `errorMessage`, scrubbing AWS account IDs from CloudControl
  error strings before they reach the failure record.
- Checkpointer write path: `stripSensitiveFromElicited` composes
  additively with the existing CFN `desiredState` allowlist.

#### Security

- GDPR Art 32 — cleartext credential storage in plugin pattern-memory and
  checkpoints is closed.

### SSO credential support

#### Added

- `ASSIGNEE_OPERATOR_SESSION_TOKEN` read by the credential resolver and
  forwarded to every AWS SDK client. Required for ASIA-prefixed
  short-term credentials from SSO and assumed-role sessions.
- `--profile <name>` flag on `assignee init` for `~/.aws/config` SSO
  profile resolution via the AWS SDK provider chain
  (`fromIni` → `fromSSO` → `fromNodeProviderChain`).
- `packages/core/src/config/provider-chain.ts` — exports
  `resolveOperatorCredentialProvider()`.
- `packages/core/src/config/sso-refresh.ts` — translates AWS
  `AccessDenied` / `ExpiredToken` errors into actionable
  `aws sso login --profile <name>` hints.
- `docs/how-to/sso-authentication.md` — Diátaxis how-to for the
  supported SSO flow.

#### Fixed

- `AWS_PROFILE` is no longer silently rejected; the credential resolver
  honours the full AWS SDK provider chain.
- `InvalidSessionTokenError` now produces an actionable hint instead
  of an opaque `AccessDenied`.

### Destroy-strategy QA and observability

#### Added

- Per-strategy unit-test coverage for 9 destroy strategies (S3 bucket,
  EC2 internet gateway, EC2 route table, DynamoDB table, EFS file
  system, ELBv2 load balancer, EC2 EIP, CloudFront distribution, SQS
  queue) — happy path plus 3+ edge cases each. vitest enforces ≥80%
  line coverage for `packages/core/src/destroy-strategies/strategies/**`.
- `destroy-only-tagged-invariant.test.ts` — parametrised invariant
  asserting strategies refuse to act on resources missing the Assignee
  management tag.
- `packages/core/src/telemetry/otel-allowlist.ts` — OTEL field-name
  allowlist with `@privacy: PII | SYSTEM | OPERATIONAL` classification.
  PII fields stripped unless `ASSIGNEE_OTEL_INCLUDE_PII=1`.
- `packages/core/src/telemetry/spans.ts` — per-graph-node entry/exit
  span emission across 13 of 14 nodes (HUMAN_APPROVAL excluded).
- `apps/cli/src/e2e/nightly-destroy-smoke.test.ts`
  (`RUN_E2E=1`-gated) — provisions and destroys a fixture per resource
  type with `afterEach` teardown-guard.
- `scripts/cost-ledger-rollup.ts` — weekly aggregation of nightly
  cost-ledger JSONL records.
- `scripts/audit-no-suppress.ts` — CI lint forbidding `|| true`
  suppression on `assignee` CLI invocation lines in composite actions.
- `docs/explanation/ci-gates.md` — documents the merge-policy and
  acceptable-miss window for the nightly E2E gate.

#### Changed

- All 7 concrete destroy strategies now emit non-fatal warnings via
  `DestroyContext.warn` rather than the static `warnDestroy()` helper,
  making warnings unit-testable through the `ctx.warn` mock surface.

### Supply-chain hardening

#### Added

- `pnpm audit --audit-level=moderate --prod` gate in CI.
- `package.json.overrides-rationale.md` — documents the CVE reference
  and mitigation note for every entry in `pnpm.overrides`.
  `scripts/audit-overrides.ts` enforces parity in CI.
- SHA256 verification and signed-manifest version allowlist in
  `scripts/install.sh`. Downgrade to known-vulnerable versions requires
  explicit `ASSIGNEE_DOWNGRADE_ACK=1`. MITM-tampering test fixture in
  `apps/cli/src/e2e/install-sh-mitm.test.ts` (`RUN_INSTALL_MITM_FIXTURE=1`-gated).
- LLM-output sanitizer (`scripts/sanitize-llm-output-for-ci.ts`);
  composite actions `apply` and `plan` now route LLM output through file
  artefacts instead of template-literal interpolation.
- SPDX SBOM-generation and cosign blob-signature + OIDC certificate provenance steps
  in the release workflow (blob signature, not full SLSA L2 attestation).
  `docs/explanation/sbom.md` and `docs/explanation/supply-chain-provenance.md`.
- `homebrew/assignee.rb` references the signed release manifest;
  `scripts/audit-homebrew-pin.ts` asserts SHA256 parity.
- Lint scripts: `audit-action-pins.ts`, `audit-secrets-inherit.ts`,
  `audit-overrides.ts`, `audit-homebrew-pin.ts`,
  `scrub-logs-for-upload.ts`.

#### Changed

- Every `uses:` reference across 9 GitHub Actions workflows and 2
  composite actions SHA-pinned to a 40-character commit hash with a
  `# v<N>` comment. `scripts/audit-action-pins.ts` blocks tag/branch
  refs in CI.
- `secrets: inherit` removed from `ci.yml` and `ci-cross-platform.yml`;
  each callee now declares an explicit least-privilege `secrets:` block.
- `nightly-e2e.yml` provisions `RUN_E2E=1` plus AWS test credentials
  and routes failures to `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`.

#### Fixed

- `.github/actions/apply/action.yml` and `.github/actions/plan/action.yml`
  no longer suppress non-zero exit codes with `|| true`. Failed CLI
  runs now propagate as failed composite-action steps.

### Documentation and developer experience

#### Added

- `docs/engineering/changelog-history.md` — engineering-journal history
  with BMAD story IDs, wave labels, and review methodology notes.
- `docs/how-to/quickstart.md` — Quickstart guide re-tagged as a Diátaxis
  how-to (moved from `docs/quickstart.md`).
- `docs/reference/<type>.md` — 38 auto-generated reference pages, one per
  supported AWS resource type, sourced from the help-hints registry.
- `scripts/generate-reference-pages.ts` — generator with `--check` mode
  for CI lint.
- `scripts/generate-notice.ts` — NOTICE + THIRD-PARTY-NOTICES.md generator
  from `pnpm licenses list`; `--check` mode for CI lint.
- `NOTICE` — SPDX-compatible project notice file.
- `THIRD-PARTY-NOTICES.md` — 526 third-party packages with SPDX license IDs.
- `packages/core/src/utils/arn-redactor.ts` — ARN-structure-preserving
  redactor scrubbing account IDs and sensitive resource names before they
  enter LLM context. Allowlist-not-denylist design.

#### Changed

- `.husky/pre-commit` now runs `pnpm check-types` and `pnpm build` in
  addition to `lint-staged` and the AWS-account-ID scan. Uses turbo cache.
  `ASSIGNEE_SKIP_BUILD=1` escape-hatch available.
- `CONTRIBUTING.md` — added pre-commit / pre-push hook split documentation
  and CI enforcement note.
- `docs/index.md` — updated quickstart link to `how-to/quickstart.md`.

#### Fixed

- `packages/core/src/graph/nodes/status-poller.ts` — exponential backoff
  with jitter on 503 / ThrottlingException responses from CloudControl.
  Retry budget: 5 retries, capped at 60 s per delay.
- `packages/core/src/config/org-policy-cache.ts` — cache file written
  with mode `0o600` to prevent world-readable token leakage.
- `packages/core/src/graph/nodes/plan-generator/llm-helpers.ts` — ARN
  redactor wired into `buildPrompt` and `readMemoryHints` before content
  reaches the LLM boundary.

### Full-audit-2026-04-29 Wave 1 — 4 convergent Criticals + 1 top High

Two independent review teams (Team A: 375 findings; Team B: 534 findings) audited
the codebase and their convergence diff identified 4 Criticals both teams flagged
independently, plus 1 top-score convergent High that 5 worker lanes flagged. This
wave closes all 5.

#### Fixed

- **Lock-free audit corruption (CRITICAL)** — `withLock` fell back to lock-free
  execution after `FILE_LOCK_MAX_RETRIES` (20) attempts; concurrent
  `appendAuditRecord` callers could corrupt the HMAC chain under the lock-free
  path. Now throws `LockAcquisitionError` on retry exhaustion; `fn()` never runs
  without the lock held. (`locks/file-advisory-lock.ts`)
- **Timing oracle in HMAC comparison (CRITICAL)** — `verifyChainLink` used `===`
  to compare HMAC strings, leaking a timing side-channel. Replaced with
  `crypto.timingSafeEqual` + length-mismatch short-circuit.
  (`audit/hmac-chain.ts`)
- **Concurrent policy-store write corruption (CRITICAL)** — `FilePolicyStore.set`
  and `delete` did unguarded read-modify-write; concurrent writers silently
  overwrote each other. Both methods now wrap the RMW in
  `defaultFileAdvisoryLock.withLock`. (`rbac/policy-store.ts`)
- **Empty-string credentials masked by test mock (CRITICAL)** — `createGraph`
  propagated empty-string credentials to `CloudControlClient` when operator
  creds were absent. Reshaped via factory accepting `AwsConfig |
NoCredentialsConfig` discriminated union; the no-cred branch emits a stderr
  warning and returns a region-only client. (`graph/create-graph.ts`,
  `services/cloudcontrol-client.ts`)
- **REDACTED array passthrough in resume payloads (HIGH)** — `stripRedactedFields`
  routed arrays into a verbatim copy branch, sending literal `[REDACTED]`
  strings to AWS on checkpoint resume. New `stripRedactedArray` helper recurses
  into object elements and removes redacted values. (`checkpoint/redaction.ts`)

### Full-audit-2026-04-29 Wave 2 — pre-existing breakage closures

Wave 1 surfaced two pre-existing breakage clusters: 27 mcp-server tests failing
under coverage-only runs, and 5 pre-close probe failures caused by a stale
schema-cache. This wave closes the source-side breakage for all 5 probes and
fixes the coverage cascade; it also surfaces a latent schema-service failure
mode addressed in Wave 3.

#### Fixed

- **mcp-server coverage-only cascade (27 failures)** — `RW4d-migration-A`
  refactored checkpoint loader to use `LocalFsStorageAdapter`, which imports
  a different `node:fs` module ID than the test's `vi.mock("node:fs/promises")`.
  Fixed via dual `importOriginal` mock factories, `vi.hoisted()` for the shared
  `fn()` reference, and `Buffer.from()` mock values. (`apply-plan.test.ts`)
- **LLM plugin-default phase ordering (R5 / R2 probes)** — `mergePluginDefaults`
  ran before `sanitizeAgainstSchema`, causing the sanitiser to immediately strip
  plugin-injected keys absent from the trimmed schema fixture. Moved
  `mergePluginDefaults` to Phase 3a.1 (post-sanitize).
- **EFS bare-intent ambiguity (N3 probe)** — redundant `"efs file system"` keyword
  in the `efs-with-vpc` compound shadowed the bare-EFS singleton route. Removed
  the shadow keyword.
- **EC2 volume-size fidelity (R4 probe)** — added 2 regression tests pinning the
  post-plugin-default shape for both `bdm[0]` no-Ebs and `bdm[0].Ebs`
  no-VolumeSize edge cases.
- **BP-awareness severity normalisation (P1 probe)** — added explicit awareness
  short-circuit in `evaluate/barrel.ts` that emits the finding before any
  `getField()`/`checkPasses()` call. 5 regression-guard tests added.

### Full-audit-2026-04-29 Wave 3 — graceful schema-cache fallback

Wave 2 identified a latent failure: when `~/.assignee/cache/schemas/*.json`
exceeded their 7-day TTL and the AWS CloudFormation DescribeType API returned
an XML error page, the schema service propagated the error and broke every CLI
command silently.

#### Fixed

- **Schema-cache stale fallback** — `readCache()` now returns
  `{ schema, stale: boolean } | null`. When `fetchFromApi()` throws and a stale
  entry exists, `getSchema()` catches the error, emits a structured `WARN` log
  with a manual-recovery hint, and returns the stale schema. The cache mtime is
  deliberately not refreshed on fallback so subsequent invocations keep retrying.
  "No cache + API error" path is unchanged — `SchemaFetchError` propagates.
  (`packages/core/src/services/cloud-formation-schema-service.ts`)

### Full-audit-2026-04-29 Wave 4 — 5 convergent Highs

Five convergent High findings from AB-DIFF Tier 1 (each flagged independently by
both review teams, score 128 each). All are surgical fixes with disjoint file
ownership.

#### Fixed

- **Silent policy-corruption on corrupt file (W4-S1)** — `FilePolicyStore.readAll`
  swallowed all errors in a blanket `catch { return [] }`, making JSON corruption
  indistinguishable from "file not yet created" and silently granting every role
  effective operator access. Typed handler now splits `ENOENT` (return `[]`) from
  all other errors (re-throw). (`rbac/policy-store.ts`)
- **Audit-log index-monotonicity not verified (W4-S2)** — the audit verifier
  checked HMAC chain linkage but not `entry.index` monotonicity. An attacker
  could delete, duplicate, or reorder entries while replaying a consistent HMAC
  chain. Added `"index-gap"` to `VerifyReason`; index-gap detection runs before
  HMAC crypto. (`audit/audit-verifier.ts`)
- **Silent plugin-registration overwrite (W4-S3)** — `PluginRegistry.register`
  called unconditional `Map.set`, silently overwriting duplicate registrations.
  A `.has()` guard now throws on duplicate. (`resource-plugins/registry.ts`)
- **World-readable price-cache files (W4-S4)** — `mkdirSync` and `writeFileSync`
  in the price-cache defaulted to umask permissions (world-readable). Fixed:
  `mode: 0o700` on directory, `mode: 0o600` on file.
  (`services/price-cache.ts`)
- **Internal tracker strings leaked to users (W4-S5)** — Four
  `process.stderr.write` calls in `plan`, `apply`, `destroy`, and `init`
  commands leaked internal strings like `"Epic 101"` and `"story 100-W2-02"`
  to users. Replaced with user-facing wording.
  (`apps/cli/src/commands/{plan,apply,destroy,init}.ts`)

### Full-audit-2026-04-29 Wave 5 — 5 convergent Highs + tracker-leak follow-up

Four convergent High findings from AB-DIFF Tier 1, plus one Wave 4 reviewer
follow-up (`--help` stdout still leaked `"Epic 101"` after W4-S5 fixed stderr
only).

#### Fixed

- **`--help` stdout tracker-string leak (W5-S0)** — Commander `.option()`
  description strings on `plan`, `apply`, and `destroy` still contained
  `"Epic 101"`. Replaced with user-facing wording; completion shims
  regenerated. (`apps/cli/src/commands/{plan,apply,destroy}.ts`)
- **Duplicate `BP_CATEGORY` enum values (W5-S1)** — `"cost"` and
  `"cost_optimization"` coexisted in the enum; 11 YAML rule files used them
  inconsistently. Removed `"cost_optimization"` alias; all 11 YAML files
  migrated to `category: cost`. (`packages/best-practices/src/types.ts` +
  11 rule files)
- **Incorrect AWS_PROFILE UX guidance (W5-S2)** — first-run helper falsely told
  users the named profile was "not supported" and instructed them to export raw
  keys instead. Also fixed em-dash rendering on Windows cmd.exe and added
  PowerShell `$Env:` snippets alongside bash `export` snippets.
  (`apps/cli/src/utils/first-run.ts`)
- **Missing `NOT_IMPLEMENTED=12` exit-code test (W5-S3)** — table-test lacked
  an assertion for code 12; JSDoc omitted it. Added the assertion and extended
  JSDoc. (`apps/cli/src/utils/exit-code.ts`)
- **AKIA/ASIA tokens in audit-log error messages (W5-S4)** — `mcpLogError`
  forwarded raw `err.message`, which can contain access-key-id tokens from AWS
  SDK errors. Extended `redactSensitive` with `/A[KS]IA[0-9A-Z]{16}/g` and
  wrapped the audit-log error path. (`packages/core/src/utils/redact.ts`)

### Full-audit-2026-04-29 Wave 6 — 5 convergent Highs + W4-S5 placeholder fix

Five convergent High findings plus two carry-overs: the collect-all loader half
of W5-S1 deferred from Wave 5, and 3 tests that used a denylisted placeholder
account ID.

#### Fixed

- **BP loader fail-fast hides subsequent errors (W6-S0)** — `loadBestPractices`
  threw on the first `ZodError`, hiding all subsequent invalid files and
  performing no duplicate-rule-ID detection. Fixed to collect-all: walks every
  file, accumulates `schemaErrors` and tracks `seenIds`; reports all offending
  files in one aggregated `BPSchemaError`. (`best-practices/src/loader.ts`)
- **MCP server signal handler tears down before cleanup (W6-S1)** — synchronous
  `process.exit` in signal handlers tore down the event loop before
  `finally { releaseApply }` blocks could run, leaving stale `activeApplies`
  entries and causing "Active-applies cap reached" on every subsequent apply
  until restart. Signal handler now calls `clearAllApplies()` synchronously,
  races `mcpServerInstance.close()` against a 5-second timeout, then exits.
  (`apps/mcp-server/src/signal-handler.ts`)
- **KMS / SecretsManager / EventBridge bypass factory pattern (W6-S2)** — three
  inline AWS SDK clients in `destroy.ts` bypassed the `cloudcontrol-client.ts`
  factory (W1-C4). Added `createKmsClient`, `createSecretsManagerClient`, and
  `createEventBridgeClient` factories sharing a `buildClientConfig` helper.
  (`packages/core/src/services/`)
- **BP schema missing cross-field validation (W6-S3)** — `bestPracticeSchema`
  had `expected_value: z.unknown()` with no cross-field validation. A
  `.superRefine` block now validates 3 cross-field constraints:
  `policy_antipattern` → string + known antipattern name;
  `nested_array_predicate` → grammar parse; `condition` → field/value shape.
  (`best-practices/src/schema.ts`)
- **Release workflow embeds token in git-clone argv (W6-S4)** — `update-homebrew`
  job cloned the tap repo via `https://x-access-token:${TOKEN}@github.com/...`,
  embedding the secret in argv visible to `ps aux` and runner logs. Replaced
  with `actions/checkout@SHA-pinned-v4.2.2` using `with: token`.
  (`.github/workflows/release.yml`)

#### Changed

- Denylisted placeholder account ID (`123456789012`) in 3 W4-S5 tests replaced
  with `112233445566` (verified non-denylisted). Updated memory guidance:
  `210987654321` is also denylisted; `112233445566` is the correct test value.

### Full-audit-2026-04-29 Wave 7 — 5 convergent Highs

Five convergent High findings across CLI commands, CI workflows, audit-chain
semantics, and CLI output encoding.

#### Breaking Changes

- **Audit-log HMAC chain format changed.** Wave 7 (W7-S2) switches HMAC
  computation from `JSON.stringify` (non-deterministic key order) to an inline
  `canonicalJson` helper that sorts object keys alphabetically. Audit logs
  created before this wave will fail verification under the new verifier.
  **Migration**: use the `legacyVerifyChainLink` helper added in Wave 8 (W8-S0)
  to re-verify old entries, then re-sign them with `computeChainLink`.
  (`packages/core/src/audit/hmac-chain.ts`)

#### Added

- `--json` output mode for `audit-verify`, `restore-provisions`, and `version`
  commands with structured envelope shapes, enabling scripted consumption of all
  three commands. (`apps/cli/src/commands/`)
- `validate-bp-rules.ts` script wired into CI as a hard-gate step between Build
  and `test:coverage`, ensuring best-practice YAML rule validation runs on every
  push. (`.github/workflows/ci-core.yml`)

#### Fixed

- **`--wizard` flag description divergence (W7-S0)** — the `--wizard` flag
  description differed across `plan`, `apply`, and `init`, creating UX
  surprises. All three now carry the identical string
  "Run the interactive configuration wizard."; per-command behaviour differences
  documented in JSDoc. (`apps/cli/src/commands/{plan,apply,init}.ts`)
- **Non-deterministic HMAC key ordering (W7-S2)** — `JSON.stringify` is
  non-deterministic for object-key order across V8 versions. Replaced with
  `canonicalJson` (recursive alphabetical sort, no new dependency).
  (`packages/core/src/audit/hmac-chain.ts`)
- **Non-ASCII glyphs on Windows cmd.exe (W7-S4)** — `✓`, `❌`, and `⚠` rendered
  as `?` on Windows with default code pages. Replaced with ASCII
  `[OK]`/`[NONE]`/`[WARN]` tokens; `isTTY` guard added for ANSI sequences.
  (`apps/cli/src/utils/first-run.ts`, `utils/command-runner/credentials.ts`,
  `apps/cli/src/index.ts`)

### Full-audit-2026-04-29 Wave 8 — 5 convergent Highs + W7-S2 follow-up

Four convergent High findings plus the `legacyHmac` migration helper that was a
Wave 7 reviewer caveat.

#### Added

- `legacyComputeChainLink` and `legacyVerifyChainLink` exports — verify audit
  logs computed with pre-W7 `JSON.stringify` HMAC, enabling a migration path to
  the canonical W7 format. (`packages/core/src/audit/hmac-chain.ts`)
- `scripts/audit-version-parity.ts` — reads the 4 publishable `package.json`
  files, normalises the tag, and exits 1 with a diff on mismatch. New
  `Check version parity` CI step runs before `turbo build` on tag-triggered
  releases. (`.github/workflows/release.yml`)

#### Fixed

- **Audit-log temp-file write race and missing fsync (W8-S1)** — 4-syscall
  temp-file dance (write tmp → read tmp → append log → unlink tmp) had two
  failure windows: partial-write race on kill and no durability guarantee.
  Replaced with a single `fs.appendFile(line, { mode: 0o600 })` plus
  conditional `fd.sync()` gated by `ASSIGNEE_AUDIT_FSYNC !== "0"` (default on).
  (`packages/core/src/audit/audit-log.ts`)
- **Sprint-status YAML stale prelude (W8-S2)** — `sprint-status.yaml` had a
  158-line stale prelude with 35 lines of prior-epic comments. Rolled the
  comments into `_archive/sprint-history-rollup.md`; reduced prelude to 8
  lines; promoted `last_updated`/`current_sprint`/`sprint_dates` to top-level
  keys. All 218 epic entries preserved.
  (`_bmad-output/implementation-artifacts/sprint-status.yaml`)
- **Deferred-backlog misfiled in `done-stories/` (W8-S3)** — `audit-deferred-
backlog.md` was filed under `_archive/done-stories/` even though it contains
  active work items (Clusters F, H, I). Moved to `planning-artifacts/` and
  renamed with date suffix.
- **Release pipeline lacks version-parity gate (W8-S4)** — a stale package
  version could silently publish at the wrong version. New
  `audit-version-parity.ts` script and CI gate address this.
  (`.github/workflows/release.yml`)

### Full-audit-2026-04-29 Wave 9 (audit hardening)

#### Breaking Changes

- **`ASSIGNEE_AUDIT_KEY` minimum length raised to 32 characters.**
  Keys shorter than 32 characters now throw `AUDIT_KEY_TOO_SHORT` at
  startup. This is a hard breaking change for anyone running with a
  non-default short key stored in `.env` or a shell rc file.
  **Migration**: generate a compliant key with `openssl rand -hex 32`
  and replace the existing value. There is no opt-out; the guard
  enforces ISO 27001 A.12.4 HMAC key-strength requirements
  (full-audit-2026-04-29 W9-S3).

#### Added

- `ASSIGNEE_AUDIT_FSYNC` environment variable documented in
  `docs/configuration.md` — controls whether audit-log writes are
  followed by an `fsync` call (default: `true`). (W9-S1)

#### Fixed

- Audit-log directory `fsync` is now called after file creation so the
  directory entry is durable on crash (W9-S0).
- `audit-verify` auto-detects legacy HMAC entries and bypasses the
  canonical verifier, preventing false-positive broken-chain reports on
  pre-W7 logs (W9-S2).
- `assignee init` now exits with code `73` (`USAGE_ERROR`) rather than
  `1` (`GENERIC_ERROR`) when passed mutually-exclusive flags (W9-S4).

### Full-audit-2026-04-29 Waves 10–17 — cycle close

The full-audit-2026-04-29 cycle formally closed after 17 waves (commits
`a66aff5` → `62b8b818`, 2026-04-29 → 2026-05-01), closing approximately 86
findings from a two-team AB-DIFF audit (Team A: 375 findings; Team B: 534
findings). All 4 Tier-1a Convergent Criticals and all 6 Tier-2 single-team
Criticals were closed in the first 12 waves. The remaining waves (W10–W17)
drained Tier 1b convergent Highs, Tier 3 theme clusters, and Tier 4
single-team Highs. Ten items remain deliberately deferred with explicit
rationale and 2026-06-01 review-by dates in
`_bmad-output/planning-artifacts/audit-deferred-backlog-2026-04-28.md`;
the only infra-blocked item is M-γ-02 (nightly E2E OIDC key rotation).
Retrospective and final deferred-backlog are archived at
`.agents/reviews/full-audit-2026-04-29-RETROSPECTIVE.md`.

Waves 1–9 are documented in the subsections above. Highlights for Waves 10–17:

- **W10** — `setup.ts` USAGE_ERROR exit code; `audit-verify` chainMode user
  surface + mixed-chain migration hint; `ASSIGNEE_AUDIT_RETENTION_DAYS`
  documented in `configuration.md`; W9 CHANGELOG entry; audit-migrate script.
- **W11** — `throttleRetryCount` propagation to `CloudControlClient`
  (M-α-07); `version.test.ts` Commander double-parse leak; W1–W8 CHANGELOG
  backfill; `LlmAdapter` exponential-backoff retry on throttle (M-α-26).
- **W12-prelude + W12** — `schemaService` module-singleton (M-α-08) with 6
  consumer migrations; `process.exit` race in 4 async Commander actions
  (M-β-001); OTEL `exportLogEvent` ConfigPort injection (M-α-06+18);
  redaction allowlist for policy/token false-positive over-matches
  (M-α-005+007); reader/auditor credential wiring (M-α-30); schema in-flight
  dedup (M-α-23).
- **W13** — remaining 4 `process.exit` sites (M-β-001-cont); ARN regex
  GovCloud/China partition coverage (M-α-22); IAM unscoped `DeleteRole` +
  `GetSecretValue` (M-α-16+17); pricing fan-out cap (M-α-21); audit-iam-policies
  registry-derived (M-γ-04).
- **W14** — 3 pre-existing test failures; CLI cold-start `pkg.json` lazy
  read; signal-handler extraction; audit-key per-process persistence (M-α-15);
  sprint-status deferred-backlog canonical path (M-γ-01).
- **W15** — 17 accumulated pre-existing test failures cleared in one sweep
  (process.exit semantics, AKIA/ASIA redaction edge cases, OTEL scheme guard,
  S3 graph routing, best-practices manifest regen).
- **W16** — tracker-leak CI lint gate preventing `"Epic N"` recurrence;
  SLSA L2 claim correction in `release.yml` + `supply-chain-provenance.md`;
  OIDC token blast-radius tightening (workflow-level `id-token: none`);
  `install.sh` Node version probe + CI smoke; `show-if.ts` RegExp compilation
  cache (hot-path wizard prompt loop).
- **W17** — SLSA claim correction in `README.md` + `CHANGELOG.md`; stderr
  prefix unification (`[plan]`/`[ERROR]` → `error:`); N+1 `ListRoleTags`
  batching in MCP IAM enumeration; Monday cron stagger across 3 workflows;
  Diátaxis redirect stubs for 12 root-level orphan docs.

### Full-audit-2026-04-29 PROD-READINESS Waves 24a–24d — cycle close

41/41 prod-readiness findings closed across 4 waves (commits
`6a1cd553` W24a, `512d3660` W24b, `0e8f00c5` W24c, `fd76363a` W24d).

- **W24a** (PR-001/002/003/010/011/012/023/029/033) — install and
  release pipeline hardening: version-floor downgrade gate with POSIX
  `semver_lt`, token-safe install URLs, release-manifest now published
  as a GitHub Release asset, org-name canonicalization to
  `SergSlon/assignee-ai` across 24 files, `audit-github-org.ts` CI
  scanner, and a new operator rollback runbook
  (`scripts/rollback-release.sh`, +358 LOC).
- **W24b** (PR-006/007/008/009/015/016/017/024/025/034) — MCP host
  integration and Bedrock UX: per-OS Claude Desktop config paths,
  AWS_PROFILE promoted over static keys in MCP docs, incident-response
  runbook sections for partial MCP credential failure and regional
  Bedrock outages, Bedrock model end-of-life detection in `doctor`,
  `~/.aws/config` region fallback in `detect-aws-region.ts`,
  partition-aware `classifyPartition()`, and dynamic MCP server version
  from `package.json`.
- **W24c** (PR-013/018/019/020/026/027/030/035/036/037/040 + OOS-1/2/3)
  — Medium/Low advisory polish and W24b carryovers: ISO partition branch
  in `classifyPartition`, data-integrity hardening (HMAC cache-flag
  dedup, structured `lock_contention` JSON events, `zod`-validated
  backup restore), npm-registry `doctor` check, `version --json`
  extended fields, update-check suppressed for `--help`/`--version`,
  node-count drift corrected to 14-node in 3 docs, and un-redacted
  fingerprint removed from `README.md`.
- **W24d** (RES-1/2/3) — final carryover sweep: `version --json`
  `region` field now consults `~/.aws/config` default-profile fallback,
  un-redacted fingerprint removed from `docs/explanation/ai-architecture.md`,
  and `file-advisory-lock.ts` gains full JSDoc for the new structured
  stderr event schema.

### Full-audit-2026-04-29 SECURITY Waves SEC-A + SEC-C — cycle close

44/48 security findings closed across 2 waves (commits `19910a75`
SEC-A, `fab62ee2` SEC-C); 4 findings remain open.

- **SEC-A** (SEC-001/002/003/004/005/006/035/037) — audit-log hardening:
  5-minute TTL on the process-lifetime audit-key cache with `rotateAuditKey()`
  API and SIGHUP handler; symlink and hardlink attack guards; parent-dir
  mode enforcement (0o700); post-write `fs.chmod(0o600)` on every
  `appendFile`; legacy HMAC fallback gated behind
  `ASSIGNEE_AUDIT_ALLOW_LEGACY`; chain-rollback threat boundary scoped
  and documented in `docs/explanation/audit-threat-model.md`
  (full external-anchor implementation deferred to Epic 101).
- **SEC-C** (33 findings: SEC-007/008/013/014/015/016/017/018/019/020/021/022/023/024/025/026/027/028/029/030/031/032/033/034/036/038/039/040/041/042/043/044/045/046/047)
  — boundary, supply-chain, and DoS hardening: redaction patterns
  extended to Anthropic/OpenAI/GitHub/Slack/Google AI/JWT tokens with
  a DoS depth/node guard; install.sh SHA256 fail-closed + HTTPS-only
  curl + atomic wrapper write; LLM prompt sanitization with
  `GuardrailRequiredError` fail-closed and INST_TAG/ROLE_PREFIX boundary
  tags; LLM response wildcard-policy rejection and 512 KB size cap;
  audit consecutive-failure alarm (3) and fail-fast (10/60 s) circuit
  breaker; checkpoint HMAC secret persistence and symlink rejection;
  file-advisory-lock overflow alarms; OTEL hostname allowlist;
  randomized temp-file paths; AWS session-token length bounds; and
  15 further mechanical hardening items.
- **Open** (4 findings): SEC-009/010/011 IAM scope tightening (Wave
  SEC-B in flight, needs live AWS integration tests) and SEC-002
  external chain-anchor (Epic 101 dependency).

---

## [0.1.0] — 2026-04-24

Internal development baseline. Not published to npm.

### Added

- `assignee` CLI with 13 commands: `plan`, `apply`, `destroy`,
  `drift`, `reconcile`, `list`, `status`, `optimize`, `init`, `setup`,
  `doctor`, `completions`, `version`.
- `@assignee/mcp-server` exposing the pipeline to AI coding agents
  (Cursor, Claude Code, Windsurf) via MCP.
- `@assignee/core` shared library: ports, schemas, destroy strategies,
  checkpoint store, pricing, testing utilities.
- `@assignee/best-practices` — 185 YAML best-practice rules with
  SHA-256 manifest integrity.
- Support for 38 AWS resource types, 11 compound architecture patterns.
- 14-node LangGraph pipeline: intent_parser → schema_fetcher →
  option_elicitor → compound_dispatcher → plan_generator → bp_evaluator
  → fix_applicator → preflight_guard → human_approval →
  resource_provisioner → status_poller → result_formatter →
  advice_generator → validate_desired_state.
- AWS MCP server integrations: pricing, documentation, IAM,
  well-architected-security, billing-cost-management.
- Drift detection, reconcile, cost-rightsizing optimizer (Graviton
  swap recommendations).
- Exponential-backoff retry on throttled CloudControl poll responses.
- CloudFront S3 DNS-propagation retry (up to 3 attempts) for transient
  origin validation failures on compound deployments.
- Partition-aware ARN handling for GovCloud and China regions.
- File-mode 0o600 on sensitive cache writes (org-policy-cache).
- Pre-commit hook: lint-staged + AWS-account-ID scan + type-check + build.
- Pre-push hook: full lint chain + type-check + barrel/shim/doc/citation lint
  - test suite.
- 5-level CI lint chain: barrels + shims + doc-lint + citation-lint +
  ci-multiplier.
- Node 20 + 22 matrix in CI.
- NFR floor: startup p95 < 1300 ms / p99 < 1400 ms; memory heap ±20%
  stability (gated on `RUN_PERF=1`).
- Flake-rate policy: `retry: 1` in all vitest configs; 0.1% SLO.
- `docs/explanation/` quadrant with AI architecture, invariants, telemetry
  design, run-ledger design, flake policy, contributing-a-bp-rule.
- Diátaxis documentation structure: tutorials / how-to / reference / explanation.

### Changed

- Quickstart moved to `docs/how-to/quickstart.md` (Diátaxis re-tag).
- All reference pages auto-generated from the supported-types registry.

### Security

- ARN-preserving redactor applied at LLM prompt boundary: account IDs and
  sensitive resource names scrubbed before reaching Bedrock.
- Pre-commit AWS-account-ID guard blocks commits containing real dogfood
  account IDs.
- org-policy-cache written with `0o600` permissions.

---

[Unreleased]: https://github.com/SergSlon/assignee-ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SergSlon/assignee-ai/releases/tag/v0.1.0
