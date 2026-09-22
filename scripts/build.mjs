import { globSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const entryPoints = [
  "index.ts",
  "setup-entry.ts",
  "api.ts",
  "doctor-contract-api.ts",
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
