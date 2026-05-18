/**
 * Matcher precedence — STS session-token errors must classify as
 * STALE_SESSION_TOKEN, not MISSING_CREDENTIALS / LLM_API_KEY_INVALID.
 *
 * Pre-demo audit (2026-05-06) follow-up: closes the deferred
 * Adversarial #4 HIGH from commit 24cc60a4 (env-writer paired-token
 * eviction). The env-writer fix prevents stale tokens from landing in
 * .env after `assignee dev setup`, but a stale token can still arrive via
 * a stale shell export, a stale paste of `aws configure
 * export-credentials`, or — most relevant for the customer demo
 * tomorrow — a user who forgets to re-run `assignee dev setup` after
 * pulling the new operator policy. The matcher fix is the safety net
 * for those user paths: AWS rejects with "The security token included
 * in the request is invalid" / "InvalidClientTokenId" / "ExpiredToken"
 * and the user sees an actionable "re-run `assignee dev setup`" hint
 * instead of the misleading "No AWS credentials detected".
 *
 * @see _bmad-output/implementation-artifacts/error-message-stale-session-token.md
 * @see commit 24cc60a4 (env-writer.ts) — root-cause fix
 * @see packages/core/src/utils/error-messages/matchers.ts:matchStsAuthError
 */

import { describe, it, expect } from "vitest";
import {
  defaultErrorMessageRegistry,
  ConfigurationError,
  BedrockError,
} from "../../../index.js";
import { ErrorCode } from "../../../constants/errors.js";

describe("matcher precedence — stale STS session token", () => {
  describe("via resolveMessage (raw error-message strings)", () => {
    it.each([
      "The security token included in the request is invalid",
      "InvalidClientTokenId: The security token included in the request is invalid",
      "ExpiredTokenException: The security token included in the request has expired",
      "ExpiredToken: provided session token is expired",
      "TokenRefreshRequired: token refresh is required for this credential",
    ])(
      "classifies %s as STALE_SESSION_TOKEN (not MISSING_CREDENTIALS)",
      (message) => {
        const entry = defaultErrorMessageRegistry.resolveMessage(message);
        expect(entry.code).toBe(ErrorCode.STALE_SESSION_TOKEN);
        expect(entry.code).not.toBe(ErrorCode.MISSING_CREDENTIALS);
        expect(entry.howToFix).toContain("assignee dev setup");
      },
    );

    it("howToFix mentions both `assignee dev setup` AND the SSO refresh path", () => {
      const entry = defaultErrorMessageRegistry.resolveMessage(
        "The security token included in the request is invalid",
      );
      expect(entry.howToFix).toContain("assignee dev setup");
      expect(entry.howToFix.toLowerCase()).toMatch(/sso|aws\s+configure/);
    });

    it("does NOT misclassify a genuine missing-credentials message as STALE_SESSION_TOKEN", () => {
      // The original "No AWS credentials" path must still fire when no
      // STS-token markers are present in the message. Wording is
      // chosen to land on the generic credentials branch rather than
      // the more-specific MISSING_ACCESS_KEY (which would fire if the
      // message included "access key" / the AKID env-var name).
      const entry = defaultErrorMessageRegistry.resolveMessage(
        "No AWS credentials detected for the operator role.",
      );
      expect(entry.code).toBe(ErrorCode.MISSING_CREDENTIALS);
    });

    it("does NOT misclassify an AccessDenied (real auth) as STALE_SESSION_TOKEN", () => {
      const entry = defaultErrorMessageRegistry.resolveMessage(
        "AccessDenied: User: arn:aws:iam::112233445566:user/test is not authorized to perform iam:CreateRole",
      );
      expect(entry.code).not.toBe(ErrorCode.STALE_SESSION_TOKEN);
    });
  });

  describe("via resolve (typed error instances)", () => {
    it("ConfigurationError with stale-token wording → STALE_SESSION_TOKEN, not MISSING_CREDENTIALS", () => {
      // Important: ConfigurationError previously short-circuited to
      // matchConfigError, which substring-matched "credentials" and
      // returned MISSING_CREDENTIALS. The fix adds a matchStsAuthError
      // pre-check on every typed branch.
      const err = new ConfigurationError(
        "The security token included in the request is invalid",
      );
      const entry = defaultErrorMessageRegistry.resolve(err);
      expect(entry.code).toBe(ErrorCode.STALE_SESSION_TOKEN);
    });

    it("BedrockError with InvalidClientTokenId → STALE_SESSION_TOKEN, not LLM_API_KEY_INVALID", () => {
      // Important: BedrockError previously short-circuited to
      // matchLlmError, where "UnrecognizedClientException" maps to
      // LLM_API_KEY_INVALID — wrong category for an STS issue. The fix
      // hoists matchStsAuthError ahead of matchLlmError on the typed
      // LlmError/BedrockError branch.
      const err = new BedrockError(
        "InvalidClientTokenId: The security token included in the request is invalid",
      );
      const entry = defaultErrorMessageRegistry.resolve(err);
      expect(entry.code).toBe(ErrorCode.STALE_SESSION_TOKEN);
      expect(entry.code).not.toBe(ErrorCode.LLM_API_KEY_INVALID);
    });

    it("plain Error with stale-token wording → STALE_SESSION_TOKEN", () => {
      const err = new Error(
        "ExpiredTokenException: The security token included in the request has expired",
      );
      const entry = defaultErrorMessageRegistry.resolve(err);
      expect(entry.code).toBe(ErrorCode.STALE_SESSION_TOKEN);
    });

    it("string-thrown error with stale-token wording → STALE_SESSION_TOKEN", () => {
      const entry = defaultErrorMessageRegistry.resolve(
        "The security token included in the request is invalid",
      );
      expect(entry.code).toBe(ErrorCode.STALE_SESSION_TOKEN);
    });
  });

  describe("entry shape", () => {
    it("STALE_SESSION_TOKEN entry exposes a non-empty what / why / howToFix triple", () => {
      const entry = defaultErrorMessageRegistry.get(
        ErrorCode.STALE_SESSION_TOKEN,
      );
      expect(entry).toBeDefined();
      expect(entry?.code).toBe(ErrorCode.STALE_SESSION_TOKEN);
      expect(entry?.what.length).toBeGreaterThan(0);
      expect(entry?.why.length).toBeGreaterThan(0);
      expect(entry?.howToFix.length).toBeGreaterThan(0);
    });

    it("STALE_SESSION_TOKEN.why distinguishes 'stale-paired token' from 'missing credentials'", () => {
      const entry = defaultErrorMessageRegistry.get(
        ErrorCode.STALE_SESSION_TOKEN,
      );
      expect(entry?.why.toLowerCase()).toMatch(/stale|expired|paired|session/);
    });
  });
});
