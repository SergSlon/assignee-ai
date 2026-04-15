/**
 * Security-group layer for the vpc-networking pattern family.
 *
 * Split from vpc-networking.ts (W6d F3). The base vpc-networking pattern
 * ships NO security groups — downstream patterns (three-tier-web,
 * container-service, etc.) inject their own tier-specific SGs. This file
 * exists so new SG-bearing VPC variants can register resources without
 * reshaping the compose layer (OCP).
 */

import type { ResourceSpec } from "../../types.js";

/** No SGs in the base VPC pattern — kept as an explicit empty list so
 *  compose.ts can spread unconditionally. */
export const securityGroupResources: ResourceSpec[] = [];

/** No default options — empty object keeps compose spreads lossless. */
export const securityGroupDefaults = {} as const;
