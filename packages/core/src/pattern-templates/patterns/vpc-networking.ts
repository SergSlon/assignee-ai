/**
 * vpc-networking pattern split into ./vpc-networking/ (W6d F3):
 * subnet-plan, route-table-plan, nat-gateway-plan, security-group-plan,
 * compose, barrel. This top-level file preserves the public import
 * surface (`./patterns/vpc-networking.js`).
 */

export {
  vpcNetworkingPattern,
  vpcPublicOnlyPattern,
} from "./vpc-networking/barrel.js";
