#!/usr/bin/env node
/**
 * Typechecks the shipped source against the real Plugin SDK.
 *
 * Why this exists: the build runs esbuild, which strips types without checking
 * them, and the unit tests mock every core surface. Between the two, an option
 * name that the core does not know — `keyOf` where it wants `buildKey` — builds
 * clean, passes 700 tests, and then drops every inbound message in production.
 * That happened. This check is the only thing that can catch that class.
 *
 * The codebase does not typecheck cleanly yet (zod version friction between the
 * plugin and the host, plus a few loose spots in code inherited from upstream),
 * so this is a ratchet rather than a wall: known errors are listed in
 * `scripts/typecheck-baseline.json` and anything new fails the run. Fix a
 * baseline entry and it must be removed from the file — the check rejects a
 * stale baseline too, so the list cannot quietly rot.
 *
 *   npm run check:types                 # uses the installed openclaw
 *   OPENCLAW_VERSION=2026.9.0 npm run check:types
 *
 * The `openclaw` peer is optional for consumers, so it may be absent; the script
 * says how to install it rather than pretending everything is fine.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "scripts/typecheck-baseline.json");

function coreVersion() {
  // Read the manifest by path: the package does not expose `./package.json`
  // through its `exports` map, so `require.resolve` cannot reach it.
  try {
    return JSON.parse(
      readFileSync(resolve(root, "node_modules/openclaw/package.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

const version = coreVersion();
if (!version) {
  console.error(
    "openclaw is not installed here, so the SDK contract cannot be checked.\n" +
      "Install the host version you are targeting without touching the lockfile:\n" +
      '  npm install --no-save --package-lock=false "openclaw@<version>"',
  );
  process.exit(1);
}

// Одна копия zod, а не две.
//
// Ядро тянет свою zod, плагин — свою. Если версии разошлись, npm держит два
// дерева, и типы из разных копий структурно несовместимы: проверка сыпет
// ошибками вида «$ZodCheck из node_modules/zod не присваивается $ZodCheck из
// node_modules/openclaw/node_modules/zod». Это артефакт раскладки, а не дефект
// кода — в обычной установке пакетный менеджер сводит их в одну копию.
// Поэтому перед проверкой подтягиваем ровно ту zod, против которой собрано ядро.
const hostZod = (() => {
  try {
    return JSON.parse(readFileSync(resolve(root, "node_modules/openclaw/package.json"), "utf8"))
      .dependencies?.zod;
  } catch {
    return undefined;
  }
})();
const localZod = (() => {
  try {
    return JSON.parse(readFileSync(resolve(root, "node_modules/zod/package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
})();
if (hostZod && localZod && hostZod !== localZod) {
  console.log(`Aligning zod with the host: ${localZod} → ${hostZod}`);
  // `openclaw` is installed without --save, so npm treats it as extraneous and
  // prunes it on any other install — taking the whole SDK contract with it.
  // Both go in one command for that reason.
  execFileSync(
    "npm",
    ["install", "--no-save", "--package-lock=false", "--silent", `zod@${hostZod}`, `openclaw@${version}`],
    { cwd: root, stdio: "inherit" },
  );
}

let output = "";
try {
  execFileSync("npx", ["tsc", "--noEmit"], { cwd: root, encoding: "utf8" });
} catch (error) {
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}

/** `src/file.ts(12,34): error TS2353: message` → a location-independent key. */
function parseErrors(text) {
  const found = new Map();
  for (const line of text.split("\n")) {
    const match = /^(\S+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, file, code, message] = match;
    // Line numbers are deliberately dropped: unrelated edits shift them, and a
    // baseline that churns on every commit stops being read.
    const key = `${file} ${code} ${message.slice(0, 120)}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  }
  return found;
}

const current = parseErrors(output);
const baseline = existsSync(baselinePath)
  ? new Map(Object.entries(JSON.parse(readFileSync(baselinePath, "utf8"))))
  : new Map();

const added = [...current].filter(([key, count]) => count > (baseline.get(key) ?? 0));
const fixed = [...baseline].filter(([key, count]) => count > (current.get(key) ?? 0));

console.log(`Typecheck against openclaw ${version}: ${current.size} known error kinds.`);

if (added.length) {
  console.error(`\n${added.length} NEW type error(s) — these are yours:\n`);
  for (const [key, count] of added) {
    console.error(`  ✗ ${key}${count > 1 ? ` (×${count})` : ""}`);
  }
}
if (fixed.length) {
  console.error(
    `\n${fixed.length} baseline entr(ies) no longer reported. Remove them from\n` +
      "scripts/typecheck-baseline.json so the ratchet keeps holding:\n",
  );
  for (const [key] of fixed) {
    console.error(`  · ${key}`);
  }
}

process.exit(added.length || fixed.length ? 1 : 0);
