// Node module-register entry point: activates the resolver hook that
// aliases `vitest` imports to `_vitest-stub.mjs`. Used only by the
// drift script so it can import the fixture (which top-level-imports
// `vitest`) without crashing on the real vitest runtime.
//
// Activated via:
//   tsx --import ./scripts/_vitest-shim.mts scripts/check-mock-fixture-drift.mts

import { register } from "node:module";

register("./_vitest-alias-loader.mjs", import.meta.url);
