/**
 * Shim — the canonical implementation has moved to
 * `../utils/fs/ensure-assignee-home-dir.ts`.
 *
 * All existing importers that used the old path continue to work
 * without any caller-side changes.
 */
export {
  ensureAssigneeHomeDir,
  resolveAssigneeHomeDir,
  type EnsureAssigneeHomeDirFs,
} from "../utils/fs/ensure-assignee-home-dir.js";
