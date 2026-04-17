/**
 * compound_dispatcher node — routes single-resource vs. compound provisioning paths.
 * Runs between option_elicitor and plan_generator.
 *
 * Single-resource path: passes through unchanged (state.resourcePattern is undefined).
 * Compound path: flattens pattern.dependencyOrder into a flat resourceQueue, sets
 * currentResourceIndex = 0, and sets resourceType for the first resource.
 * plan_generator then generates desiredState using pattern.defaultOptions (no Bedrock call).
 *
 * @see Story 8.2, ArchitecturePattern, dependencyOrder
 */
import type { ResourceSpec } from "../../pattern-templates/types.js";
import type { AgentState } from "../graph-state.js";

/**
 * Dispatches between single-resource and compound provisioning paths.
 * For compound intents, flattens the pattern's dependencyOrder into a sequential
 * resourceQueue and primes the first resource as the current target.
 */
export async function compoundDispatcherNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  // Single-resource path — pass through unchanged
  if (!state.resourcePattern) {
    return {};
  }

  // Compound path — flatten dependencyOrder into a sequential resourceQueue
  // dependencyOrder is an array of groups; flatten preserves dependency order
  const flatOrder = state.resourcePattern.dependencyOrder.flat();
  const resourceMap = new Map<string, ResourceSpec>(
    state.resourcePattern.resourceList.map((r) => [r.resourceId, r]),
  );

  const resourceQueue = flatOrder
    .map((id) => resourceMap.get(id))
    .filter((r): r is ResourceSpec => r !== undefined);

  if (resourceQueue.length === 0) {
    // Degenerate pattern — fall back with empty queue
    return { resourceQueue: [] };
  }

  const firstResource = resourceQueue[0];
  if (!firstResource) return { resourceQueue: [] };

  return {
    resourceQueue,
    currentResourceIndex: 0,
    completedResources: [],
    // Set first resource as current target (plan_generator + resource_provisioner use these)
    resourceType: firstResource.resourceType,
    desiredState: undefined, // plan_generator will build from defaultOptions
  };
}
