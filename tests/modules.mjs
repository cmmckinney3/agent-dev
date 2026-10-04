import { readdirSync } from "node:fs";

// Every non-component module in src/, for the test files that transpile them
// into a temp folder. Transpiling one a test never imports costs nothing, and
// a module that gains an import can no longer break a test file whose
// hand-kept list forgot it.
export const pureModules = () =>
  readdirSync(new URL("../src/", import.meta.url))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => file.slice(0, -3));
