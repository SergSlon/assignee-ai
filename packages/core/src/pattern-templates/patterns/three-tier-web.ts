/**
 * three-tier-web pattern split into ./three-tier-web/ (W6d F3):
 * vpc-layer, app-layer, db-layer, alb-layer, compose, barrel. This
 * top-level file preserves the public import surface
 * (`./patterns/three-tier-web.js`).
 */

export { threeTierWebPattern } from "./three-tier-web/barrel.js";
