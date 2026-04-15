// Minimal stub for `vitest` — exposes only what the fixture file
// (apps/cli/src/test-fixtures/mcp-mock-responses.ts) reads at import
// time (`{ vi }`). The drift script never calls `vi.*`, so the
// implementations are no-ops; they exist only so property access
// doesn't throw if the fixture's factory helpers happen to reach for
// them during module initialisation.

const noop = () => undefined;
const chainable = new Proxy(
  {},
  {
    get: () => chainable,
    apply: () => chainable,
  },
);

export const vi = new Proxy(
  {},
  {
    get: () => chainable,
    apply: () => chainable,
  },
);

export default { vi };
