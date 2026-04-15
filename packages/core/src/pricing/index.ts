// Top-level pricing barrel.
// Split into domain sub-barrels under ./barrels/ for maintainability
// (SRP: strategies vs decomposers vs types vs constants; OCP: new
// strategy/decomposer registration goes into the matching sub-barrel).
export * from "./barrels/strategies.js";
export * from "./barrels/decomposers.js";
export * from "./barrels/types.js";
export * from "./barrels/constants.js";
