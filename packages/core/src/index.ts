// Top-level barrel for @assignee/core.
// Split into domain-oriented sub-barrels under ./barrels/ for maintainability
// (SRP: each sub-barrel owns one domain; OCP: new exports go into the
// matching domain barrel without touching this file).
export * from "./barrels/schemas.js";
export * from "./barrels/config.js";
export * from "./barrels/types.js";
export * from "./barrels/plugins-patterns.js";
export * from "./barrels/utils.js";
export * from "./barrels/pricing.js";
export * from "./barrels/errors.js";
export * from "./barrels/ports-services.js";
export * from "./destroy-strategies/index.js";
export * from "./list-resources/index.js";
export * from "./aws/index.js";
