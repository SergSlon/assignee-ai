/**
 * Tag injection utilities for Assignee.ai.
 * Ensures all provisioned resources carry mandatory governance tags.
 *
 * @see Story 2-5
 */

/**
 * Merges mandatory Assignee.ai tags into user-supplied tags.
 * Mandatory tags always overwrite user-supplied values with the same key.
 *
 * @param userTags - Tags provided by the user in desiredState
 * @param runId - The current run's UUID (used for correlation)
 * @returns Merged tag map with all mandatory tags guaranteed
 */
export function injectMandatoryTags(
  userTags: Record<string, string>,
  runId: string,
): Record<string, string> {
  const mandatory: Record<string, string> = {
    "managed-by": "assignee-ai",
    "assignee-run-id": runId,
    environment: "poc",
  };

  // Use Map to deduplicate; mandatory keys overwrite user-supplied
  const merged = new Map<string, string>([
    ...Object.entries(userTags),
    ...Object.entries(mandatory),
  ]);
  return Object.fromEntries(merged);
}
