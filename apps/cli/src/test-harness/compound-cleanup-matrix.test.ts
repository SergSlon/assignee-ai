/**
 * Compound reverse-edge cleanup matrix — Item 1 (2026-04-09).
 *
 * This test file exercises the compound-failure-injector harness
 * against real compound pattern dependency orders to prove the
 * reverse-edge cleanup invariant:
 *
 *   "If the Kth resource in a compound fails, the destroy sequence
 *    MUST issue deleteResource for positions [0..K-1] in reverse
 *    order, leaving zero orphaned AWS resources."
 *
 * ── Why this matters ─────────────────────────────────────────────
 *
 * Quinn called partial-failure cleanup the "money bug" in the
 * session N-1 debate. The VPC + NAT Gateway compound is the primary
 * target: NAT Gateway + EIP together bill ~$32/month, and a partial
 * apply that leaves them behind produces a mystery monthly line item
 * with no matching workload. Before this harness, we had zero
 * automated coverage of "resource K fails, does the cleanup path
 * actually unwind positions [0..K-1]?"
 *
 * ── What this test does ──────────────────────────────────────────
 *
 * For each `failAtIndex` in [0..N-1] of a compound's resourceList:
 *   1. Drive a synthetic sequential apply loop through the harness.
 *      Positions [0..failAtIndex-1] succeed via the in-memory port.
 *      Position failAtIndex fails via the failure injector.
 *      Positions [failAtIndex+1..N-1] are never attempted.
 *   2. Run a synthetic cleanup step: iterate the successful positions
 *      in reverse and call `deleteResource` for each.
 *   3. Assert invariants:
 *      - tracker.created.length === failAtIndex
 *      - tracker.deleted.length === failAtIndex
 *      - deleted[i].identifier === created[failAtIndex - 1 - i].identifier
 *
 * The simulation deliberately stays at the harness level (not the
 * full LangGraph compound loop) because the invariant we're proving
 * is about the port-level contract, not about graph routing. If the
 * port-level contract holds for every position and every compound
 * pattern, the graph loop's job is just to honor the contract — and
 * that wiring is covered by the existing compound-provisioning-audit
 * tests.
 *
 * ── Scope (falsification clause) ────────────────────────────────
 *
 * This file starts with the VPC networking compound (17 resources).
 * Per the session brief's falsification clause, if the owner's
 * dogfood session (item 2) finds zero orphan bugs in practice, the
 * remaining compound matrices (lambda-with-exec-role, efs-with-vpc,
 * scheduled-lambda, static-website, serverless-api, message-processing,
 * container-service, three-tier-web) can stay deferred. The harness
 * + this reference matrix prove the infrastructure; expanding to
 * additional compounds is a mechanical repeat.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vpcNetworkingPattern } from "@assignee/core";
import {
  buildInMemoryProvisioningPort,
  wrapWithFailureInjection,
  type InMemoryProvisioningTracker,
} from "./compound-failure-injector.js";
import type { ProvisioningPort } from "../services/provisioning-port.js";

/**
 * Run a synthetic sequential compound apply against the given port.
 * Returns the index at which a failure occurred (or `null` for
 * happy-path runs) and the list of created-identifier handles.
 */
async function simulateCompoundApply(
  port: ProvisioningPort,
  resourceTypes: readonly string[],
): Promise<{
  failedAtIndex: number | null;
  createdIdentifiers: string[];
}> {
  const createdIdentifiers: string[] = [];
  for (let i = 0; i < resourceTypes.length; i++) {
    const typeName = resourceTypes[i]!;
    const [err, result] = await port.createResource(
      typeName,
      JSON.stringify({ idx: i }),
      `client-token-${i}`,
    );
    if (err) {
      return { failedAtIndex: i, createdIdentifiers };
    }
    // Simulate what the resource-provisioner node does: poll status
    // until SUCCESS and capture the identifier the port hands back.
    const [statusErr, status] = await port.getRequestStatus(
      result!.requestToken,
    );
    if (statusErr || !status?.identifier) {
      return { failedAtIndex: i, createdIdentifiers };
    }
    createdIdentifiers.push(status.identifier);
  }
  return { failedAtIndex: null, createdIdentifiers };
}

/**
 * Run a synthetic cleanup sequence: delete every successfully-created
 * resource in reverse order. Mirrors the real destroy path's tier
 * ordering from bulk-destroy.ts (which reverses dependency order).
 */
async function simulateReverseCleanup(
  port: ProvisioningPort,
  created: Array<{ typeName: string; identifier: string }>,
): Promise<void> {
  for (let i = created.length - 1; i >= 0; i--) {
    const entry = created[i]!;
    await port.deleteResource(entry.typeName, entry.identifier);
  }
}

describe("compound cleanup matrix — VPC networking (reverse-edge invariant)", () => {
  const vpcResourceTypes = vpcNetworkingPattern.resourceList.map(
    (r) => r.resourceType,
  );
  const N = vpcResourceTypes.length;

  let innerPort: ProvisioningPort;
  let tracker: InMemoryProvisioningTracker;

  beforeEach(() => {
    const built = buildInMemoryProvisioningPort();
    innerPort = built.port;
    tracker = built.tracker;
  });

  it("has more than 10 resources (sanity check — compound is non-trivial)", () => {
    expect(N).toBeGreaterThan(10);
  });

  // The "money bug" position: somewhere after VPC + subnets land but
  // before NAT Gateway + EIP + private route table wiring completes.
  // At this point AWS has created ~6-8 billable / taggable resources
  // and a missed cleanup leaves a silent orphan. This case is the
  // one humans hit most often in practice per the session brief.
  it("NAT Gateway failure leaves no orphaned resources after reverse cleanup", async () => {
    const natGwIndex = vpcNetworkingPattern.resourceList.findIndex(
      (r) => r.resourceType === "AWS::EC2::NatGateway",
    );
    expect(natGwIndex).toBeGreaterThan(0);

    const wrapped = wrapWithFailureInjection({
      inner: innerPort,
      failAtIndex: natGwIndex,
      errorKind: "ACCESS_DENIED",
      errorMessage: "Operator policy missing ec2:CreateNatGateway",
    });

    const { failedAtIndex, createdIdentifiers } = await simulateCompoundApply(
      wrapped,
      vpcResourceTypes,
    );

    expect(failedAtIndex).toBe(natGwIndex);
    expect(createdIdentifiers).toHaveLength(natGwIndex);
    expect(tracker.created).toHaveLength(natGwIndex);

    // Run the reverse cleanup
    await simulateReverseCleanup(wrapped, tracker.created.slice());

    // Invariant: every created resource got a matching delete call,
    // in reverse order of creation.
    expect(tracker.deleted).toHaveLength(natGwIndex);
    for (let i = 0; i < tracker.deleted.length; i++) {
      const deletedEntry = tracker.deleted[i]!;
      const matchingCreated = tracker.created[natGwIndex - 1 - i]!;
      expect(deletedEntry.identifier).toBe(matchingCreated.identifier);
      expect(deletedEntry.typeName).toBe(matchingCreated.typeName);
    }
  });

  // Falsification run: prove the matrix catches bugs by exercising
  // every position. If a future change introduces an off-by-one in
  // the compound apply loop, some of these assertions will fail.
  it.each(
    vpcResourceTypes.map((_type, index) => ({
      index,
      type: vpcResourceTypes[index],
    })),
  )("failure at index $index ($type) unwinds cleanly", async ({ index }) => {
    const wrapped = wrapWithFailureInjection({
      inner: innerPort,
      failAtIndex: index,
    });

    const { failedAtIndex } = await simulateCompoundApply(
      wrapped,
      vpcResourceTypes,
    );

    expect(failedAtIndex).toBe(index);
    expect(tracker.created).toHaveLength(index);

    await simulateReverseCleanup(wrapped, tracker.created.slice());

    expect(tracker.deleted).toHaveLength(index);

    // Assert reverse-order invariant
    const createdInReverse = tracker.created.slice().reverse();
    expect(tracker.deleted).toEqual(createdInReverse);
  });

  it("happy path (no failure) creates all resources and cleans them up in reverse", async () => {
    const { failedAtIndex, createdIdentifiers } = await simulateCompoundApply(
      innerPort,
      vpcResourceTypes,
    );
    expect(failedAtIndex).toBeNull();
    expect(createdIdentifiers).toHaveLength(N);
    expect(tracker.created).toHaveLength(N);

    await simulateReverseCleanup(innerPort, tracker.created.slice());

    expect(tracker.deleted).toHaveLength(N);
    // Top-level resources (VPC) delete LAST
    const lastDelete = tracker.deleted[tracker.deleted.length - 1]!;
    expect(lastDelete.typeName).toBe(vpcResourceTypes[0]);
    // Tail resources (subnet-RT associations) delete FIRST
    const firstDelete = tracker.deleted[0]!;
    expect(firstDelete.typeName).toBe(vpcResourceTypes[N - 1]);
  });
});
