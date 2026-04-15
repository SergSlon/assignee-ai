/**
 * Internal barrel for the vpc-networking pattern folder.
 * The sibling vpc-networking.ts re-exports from here so existing imports
 * (`./patterns/vpc-networking.js`) keep resolving unchanged.
 */

export { vpcNetworkingPattern, vpcPublicOnlyPattern } from "./compose.js";
