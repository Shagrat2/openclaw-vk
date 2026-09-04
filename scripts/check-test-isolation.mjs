#!/usr/bin/env node
/**
 * Runs the unit tests as CI runs them: without the `openclaw` peer installed.
 *
 * The peer is optional, so `npm ci` does not install it and CI's test job has no
 * SDK at all. A developer machine usually does — `check:types` installs one —
 * and that difference hides a whole class of breakage: a module that imports an
 * SDK subpath whose test forgot to mock it passes locally and fails in CI. That
 * happened, and the CI log is where it surfaced.
 *
 * This moves the installed core aside, runs the suite, and puts it back.
 */
import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = resolve(root, "node_modules/openclaw");
const parked = resolve(root, "node_modules/.openclaw-parked-for-isolation");

const hasCore = existsSync(installed);
if (hasCore) {
  if (existsSync(parked)) {
    console.error(`Leftover from an interrupted run: ${parked}\nMove it back to ${installed} first.`);
    process.exit(1);
  }
  renameSync(installed, parked);
}

let failed = false;
try {
  execFileSync("npx", ["vitest", "run"], { cwd: root, stdio: "inherit" });
} catch {
  failed = true;
} finally {
  if (hasCore) {
    renameSync(parked, installed);
  }
}

if (failed) {
  console.error(
    "\nThe suite fails without the openclaw peer — this is what CI sees.\n" +
      "Every SDK subpath a module under test imports needs a vi.mock, including\n" +
      "the ones reached transitively.",
  );
}
process.exit(failed ? 1 : 0);
