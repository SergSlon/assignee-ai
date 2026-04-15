/**
 * Merged service-action map — composes all per-service shards into
 * a single lookup consumed by `getRequiredIamActions()`.
 *
 * Adding a new service: create a new `<service>.ts` shard that
 * exports a `Record<string, string[]>`, then add it to the spread
 * below. Open/Closed: no need to touch the dispatcher.
 */

import { S3_ACTIONS } from "./s3.js";
import { COMPUTE_ACTIONS } from "./compute.js";
import { DATABASE_ACTIONS } from "./database.js";
import { NETWORK_ACTIONS } from "./network.js";
import { SECURITY_ACTIONS } from "./security.js";
import { MESSAGING_ACTIONS } from "./messaging.js";
import { OBSERVABILITY_ACTIONS } from "./observability.js";
import { STORAGE_ACTIONS } from "./storage.js";

export const SERVICE_ACTION_MAP: Record<string, string[]> = {
  ...S3_ACTIONS,
  ...COMPUTE_ACTIONS,
  ...DATABASE_ACTIONS,
  ...NETWORK_ACTIONS,
  ...SECURITY_ACTIONS,
  ...MESSAGING_ACTIONS,
  ...OBSERVABILITY_ACTIONS,
  ...STORAGE_ACTIONS,
};
