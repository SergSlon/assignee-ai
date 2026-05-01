// E2E plan tests for compound resource patterns (multi-resource apply+destroy).
// Originally extracted from e2e-plan.test.ts during the M-018 cluster-D split (2026-04-28).
// Split into focused files during M-β-015 (2026-04-29):
//   - e2e-plan-compounds-storage.test.ts   — efs-with-vpc (1 test, ~123 LOC)
//   - e2e-plan-compounds-web.test.ts       — static-website (1 test, ~307 LOC)
//   - e2e-plan-compounds-lambda.test.ts    — scheduled-lambda + serverless-api + message-processing (3 tests, ~262 LOC)
//   - e2e-plan-compounds-container.test.ts — container-service (1 test, ~403 LOC)
//   - e2e-plan-compounds-three-tier.test.ts — three-tier-web (1 test, ~530 LOC*)
//
// * three-tier-web exceeds the 450 LOC target: it is a single indivisible
//   it+afterAll block with 7 sequential AWS cleanup phases that close over
//   the same suffix variable; splitting further would require artificial
//   shared state. Accepted as a single-block exception per the W19-S3 triage rule.
//
// This file is intentionally empty — all tests live in the split files above.
// It is kept so that any tooling that references e2e-plan-compounds.test.ts
// by name continues to resolve without error.
