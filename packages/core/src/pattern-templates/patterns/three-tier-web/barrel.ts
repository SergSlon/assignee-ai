/**
 * Internal barrel for the three-tier-web pattern folder.
 * The sibling three-tier-web.ts re-exports from here so existing imports
 * (`./patterns/three-tier-web.js`) keep resolving unchanged.
 */

export { threeTierWebPattern } from "./compose.js";
