/**
 * Matcher precedence — pinned `it.todo` for the deferred follow-up
 * story `error-message-stale-session-token.md`.
 *
 * ## Why this file exists
 *
 * When AWS rejects a request because a session token is invalid
 * (typical message: "The security token included in the request is
 * invalid"), the assignee error matchers currently classify the
 * failure as `ErrorCode.MISSING_CREDENTIALS` because
 * `matchConfigError` substring-matches "credentials" before any
 * STS-specific rule has a chance to fire. The user-visible result is
 * misleading: the user is told "No AWS credentials detected" when in
 * fact the credentials WERE detected — they were just paired with a
 * stale STS session token from a prior `aws sso login`.
 *
 * The user reported exactly this: after running `assignee setup` they
 * saw "No AWS credentials detected" because their .env still carried
 * `ASSIGNEE_OPERATOR_SESSION_TOKEN` from a prior SSO session, AWS
 * Bedrock returned `InvalidClientTokenId`, and the matcher mapped that
 * to `MISSING_CREDENTIALS`.
 *
 * The env-writer fix (commit 24cc60a4) prevents the stale token from
 * landing in .env after `assignee setup` — but a stale token can
 * still arrive via a stale shell export or a stale paste of
 * `aws configure export-credentials`. The matcher fix is the safety
 * net for those user paths.
 *
 * ## Implementer playbook (when picking up the follow-up)
 *
 *   1. Add `ErrorCode.STALE_SESSION_TOKEN` (or similar) to
 *      `packages/core/src/constants/errors.ts`.
 *   2. Register an entry in `catalog-config.ts` (or a new
 *      `catalog-aws-sts.ts`) with `what / why / howToFix` that points
 *      the user at `aws sso login` + re-export, plus — for assignee
 *      operator credentials — `assignee setup` to refresh long-term
 *      IAM keys.
 *   3. Add the matcher rule BEFORE the generic "credentials" branch
 *      in `matchAwsErrorName` (or hoist it to a top-level matcher
 *      that runs ahead of `matchConfigError`). The pattern set is at
 *      least:
 *        - "The security token included in the request is invalid"
 *        - "InvalidClientTokenId"
 *        - "ExpiredToken"
 *        - "ExpiredTokenException"
 *   4. Flip this test from `it.todo` to a real `it(...)` block that
 *      asserts:
 *        - the resolved entry's `code` is `STALE_SESSION_TOKEN`
 *        - the entry's `code` is NOT `MISSING_CREDENTIALS`
 *        - the `howToFix` mentions `aws sso login` and/or
 *          `assignee setup`
 *      against `defaultErrorMessageRegistry.resolveFromMessage(...)`
 *      (or whichever public surface ends up exposing the matcher).
 *
 * The test stays pinned as `it.todo` so vitest reports the
 * outstanding work in its summary without going red on main — the
 * follow-up implementer has a concrete failing test to drive against
 * the moment they remove `.todo`.
 *
 * @see packages/core/src/utils/error-messages/matchers.ts — the
 *   generic "credentials" branch that currently swallows the case
 *   (matchConfigError, around line 88).
 * @see follow-up story: error-message-stale-session-token.md (TBD path)
 * @see env-writer fix: commit 24cc60a4 (apps/cli/src/utils/env-writer.ts)
 */

import { describe, it } from "vitest";

describe("matcher precedence — stale STS session token", () => {
  it.todo(
    'AWS "The security token included in the request is invalid" → STALE_SESSION_TOKEN, not MISSING_CREDENTIALS',
  );
});
