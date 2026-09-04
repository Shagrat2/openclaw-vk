import { globSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { build } from "esbuild";

// Entry points are derived, not listed.
//
// The set used to be maintained by hand here AND in package.json "files", and
// both restate what tsconfig already declares. A new `src/*.ts` added to one
// list and forgotten in the other ships broken — that has happened.
const entryPoints = [
  "index.ts",
  "setup-entry.ts",
  "api.ts",
  ...globSync("src/*.ts", { cwd: root }).filter(
    (file) => !file.endsWith(".test.ts") && file !== "src/test-helpers.ts",
  ).sort(),
];

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints,
  outbase: ".",
  outdir: "dist",
  bundle: false,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "info",
});
