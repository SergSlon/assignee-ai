// Node module resolver hook: redirect any `import ... from "vitest"` to
// the local shim at `_vitest-stub.mjs`. Used only by the drift script
// (see `_vitest-shim.mts`). Loading the real vitest runtime outside the
// vitest worker throws "Vitest failed to access its internal state".
//
// Spec: https://nodejs.org/api/module.html#customization-hooks

import { pathToFileURL } from "node:url";
import * as path from "node:path";

const STUB_URL = pathToFileURL(
  path.resolve(new URL(".", import.meta.url).pathname, "_vitest-stub.mjs"),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vitest") {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
