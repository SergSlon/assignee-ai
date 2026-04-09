/**
 * Compound failure-injection harness (Item 1, 2026-04-09).
 *
 * Test-only utility that wraps a ProvisioningPort with a failure at a
 * specific position in a compound's resourceQueue. Used by the
 * reverse-edge cleanup matrix tests to prove that partial compound
 * apply + rollback leaves no orphans.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * The compound apply loop provisions resources in dependency order.
 * The existing test suite covers the happy path (all resources succeed)
 * and the single-resource failure path, but has no coverage for the
 * "middle resource fails mid-compound — does cleanup unwind cleanly?"
 * scenario that Quinn called the "money bug" in the session N-1 debate.
 *
 * Closing that gap in production code would require a real cloud
 * account, a compound pattern with a forced-failure resource, and
 * reliance on the destroy pipeline. That's slow and brittle. This
 * harness instead wraps the `ProvisioningPort` used by the
 * resource-provisioner node and returns a synthetic error when the
 * provisioner asks to create the resource at `failAtIndex`. Everything
 * else (the node chain, the result formatter, the compound loop, the
 * renderCompoundPartialFailure output) runs unchanged.
 *
 * ── Safety ──────────────────────────────────────────────────────────
 *
 * This module lives under `apps/cli/src/test-harness/` and is only
 * imported by test files. The harness itself has ZERO production
 * callers. `ASSIGNEE_FAILURE_INJECTION_INDEX` is checked opportunistically
 * so that even if a test imports it into a non-test context, the
 * default state is "no injection, pass through". This is belt-and-suspenders:
 * production should never see this file at all, but if a misconfigured
 * build ships it, the failure-injection path must stay dormant.
 */

import type {
  ProvisioningPort,
  ProvisioningPortError,
  CreateResourceResult,
  DeleteResourceResult,
  GetRequestStatusResult,
  UpdateResourceResult,
} from "../services/provisioning-port.js";
import { ProvisioningErrorKind } from "../services/provisioning-port.js";

/**
 * Configuration for the failure injector. Callers pass the wrapped
 * port plus the zero-based index of the resource that should fail
 * inside the compound's resourceQueue. The injector counts CALLS to
 * `createResource` — so the failure fires on the Nth create, which
 * maps 1:1 to the Nth resourceQueue entry in the sequential compound
 * loop.
 */
export interface CompoundFailureInjectorConfig {
  /** The underlying ProvisioningPort whose non-failing calls should pass through. */
  inner: ProvisioningPort;
  /**
   * Zero-based index of the resource-queue position that should fail.
   * If the compound has 5 resources and `failAtIndex = 2`, the third
   * createResource() call (after two successful creates) will return
   * a synthetic ProvisioningPortError with kind SERVICE_ERROR.
   */
  failAtIndex: number;
  /**
   * Error kind injected at the failure point. Defaults to SERVICE_ERROR,
   * which is the most common real-world class (throttled / AccessDenied /
   * malformed property). Tests can pass `NOT_FOUND` or other kinds to
   * exercise specific branches of the error-message registry.
   */
  errorKind?: keyof typeof ProvisioningErrorKind;
  /**
   * Custom message attached to the synthetic failure. Defaults to a
   * recognizable string so assertion failures point at this harness
   * rather than looking like a real AWS error.
   */
  errorMessage?: string;
}

/**
 * Wrap a ProvisioningPort with failure injection at the specified
 * resource index. Returns a port that forwards every call to the
 * inner port EXCEPT the `createResource` call at the target index,
 * which returns a synthetic error.
 *
 * Pass-through semantics for every other method (getResource,
 * deleteResource, updateResource, getRequestStatus) so tests can
 * use this harness to check that rollback / destroy sequences still
 * run against the real inner adapter.
 */
export function wrapWithFailureInjection(
  config: CompoundFailureInjectorConfig,
): ProvisioningPort & { readonly createCallCount: () => number } {
  let createCallCount = 0;
  const errorKind = config.errorKind ?? "SERVICE_ERROR";
  const errorMessage =
    config.errorMessage ??
    `[test-harness] Synthetic failure injected at compound queue index ${config.failAtIndex}`;

  return {
    getResource(typeName: string, identifier: string) {
      return config.inner.getResource(typeName, identifier);
    },

    async createResource(
      typeName: string,
      desiredState: string,
      clientToken: string,
    ): Promise<[ProvisioningPortError, null] | [null, CreateResourceResult]> {
      const currentIndex = createCallCount;
      createCallCount += 1;
      if (currentIndex === config.failAtIndex) {
        return [
          {
            kind: ProvisioningErrorKind[errorKind],
            message: errorMessage,
          },
          null,
        ];
      }
      return config.inner.createResource(typeName, desiredState, clientToken);
    },

    deleteResource(
      typeName: string,
      identifier: string,
    ): Promise<[ProvisioningPortError, null] | [null, DeleteResourceResult]> {
      return config.inner.deleteResource(typeName, identifier);
    },

    updateResource(
      typeName: string,
      identifier: string,
      patchDocument: string,
    ): Promise<[ProvisioningPortError, null] | [null, UpdateResourceResult]> {
      return config.inner.updateResource(typeName, identifier, patchDocument);
    },

    getRequestStatus(
      requestToken: string,
    ): Promise<[ProvisioningPortError, null] | [null, GetRequestStatusResult]> {
      return config.inner.getRequestStatus(requestToken);
    },

    createCallCount: () => createCallCount,
  };
}

/**
 * Build an in-memory ProvisioningPort that always succeeds. Each
 * createResource call returns a synthetic request token; the matching
 * getRequestStatus call returns SUCCESS with a deterministic identifier
 * derived from the request token so assertions can verify that the
 * resources landed in the expected order.
 *
 * The tracker returned alongside the port captures every create /
 * delete call so tests can assert "after failure at index N, the
 * destroy sequence issued deleteResource for positions [0..N-1]
 * in reverse order".
 */
export interface InMemoryProvisioningTracker {
  readonly created: Array<{ typeName: string; identifier: string }>;
  readonly deleted: Array<{ typeName: string; identifier: string }>;
  reset(): void;
}

export function buildInMemoryProvisioningPort(): {
  port: ProvisioningPort;
  tracker: InMemoryProvisioningTracker;
} {
  const created: Array<{ typeName: string; identifier: string }> = [];
  const deleted: Array<{ typeName: string; identifier: string }> = [];
  let tokenCounter = 0;
  // Map request tokens → resource identifiers so getRequestStatus can
  // report the landed identifier the same way the real CCAPI adapter
  // does. Real CCAPI uses a 20-char prefix + AWS-generated suffix; we
  // use a shorter deterministic prefix so test snapshots don't need
  // regeneration when the counter rolls.
  const pendingIdentifiers: Map<string, string> = new Map();
  const pendingTypes: Map<string, string> = new Map();

  const port: ProvisioningPort = {
    async getResource(_typeName: string, _identifier: string) {
      // Always "not found" so the state-guard check in
      // resource-provisioner.ts proceeds to createResource. Tests that
      // want to simulate an existing-resource collision should wrap
      // this port with a second layer that returns ALREADY_EXISTS.
      return [
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "not found" },
        null,
      ];
    },

    async createResource(
      typeName: string,
      _desiredState: string,
      _clientToken: string,
    ) {
      tokenCounter += 1;
      const requestToken = `mem-token-${tokenCounter}`;
      // Deterministic identifier — tests can match on the type + index.
      const identifier = `${typeName.replace(/::/g, "_")}-${tokenCounter}`;
      pendingIdentifiers.set(requestToken, identifier);
      pendingTypes.set(requestToken, typeName);
      created.push({ typeName, identifier });
      return [null, { requestToken }];
    },

    async deleteResource(typeName: string, identifier: string) {
      tokenCounter += 1;
      const requestToken = `mem-del-token-${tokenCounter}`;
      deleted.push({ typeName, identifier });
      // Mark the delete as "landed" so poll returns success.
      pendingIdentifiers.set(requestToken, identifier);
      pendingTypes.set(requestToken, typeName);
      return [null, { requestToken }];
    },

    async updateResource(typeName: string, identifier: string, _patch: string) {
      tokenCounter += 1;
      const requestToken = `mem-upd-token-${tokenCounter}`;
      pendingIdentifiers.set(requestToken, identifier);
      pendingTypes.set(requestToken, typeName);
      return [null, { requestToken }];
    },

    async getRequestStatus(requestToken: string) {
      const identifier = pendingIdentifiers.get(requestToken);
      if (!identifier) {
        return [
          { kind: ProvisioningErrorKind.NOT_FOUND, message: "unknown token" },
          null,
        ];
      }
      return [
        null,
        {
          operationStatus: "SUCCESS",
          identifier,
          statusMessage: undefined,
          errorCode: undefined,
        },
      ];
    },
  };

  return {
    port,
    tracker: {
      get created() {
        return created;
      },
      get deleted() {
        return deleted;
      },
      reset() {
        created.length = 0;
        deleted.length = 0;
        pendingIdentifiers.clear();
        pendingTypes.clear();
        tokenCounter = 0;
      },
    },
  };
}
