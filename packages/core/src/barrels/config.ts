// Barrel — config namespace. Split into 3 sub-barrels per Story 56-it2-01
// (L4-008) to keep each file ≤ 200 LOC and better reflect semantic layers:
//
//   - ./config/constants.ts — pure constants / enums / classifiers
//   - ./config/resources.ts — resource-type, ARN, IAM, and config loaders
//   - ./config/help-hints.ts — help-hint SSO renderers
//
// Public API (named exports) is preserved by re-exporting every symbol from
// the sub-barrels. Every existing `@assignee/core` importer (and every
// `../barrels/config.js` / `./barrels/config.js` in-package importer) keeps
// working with zero diff.
export * from "./config/constants.js";
export * from "./config/resources.js";
export * from "./config/help-hints.js";
