#!/usr/bin/env node
/**
 * Отчёт: какие подпути plugin-sdk, которые мы импортируем, ядро уже пометило
 * устаревшими или удалёнными.
 *
 * Ядро возит машиночитаемый реестр устареваний — записи вида
 * `{ code, subpath, status, removeAfter, replacement }`. Это тот же источник,
 * по которому ядро само планирует удаления, поэтому сверяться с ним надёжнее,
 * чем помнить. Реестр лежит во внутреннем бандле с хешем в имени, публичного
 * экспорта у него нет — поэтому ищем его перебором по dist. Если не нашли,
 * это НЕ ошибка: значит формат сменился, и список ниже надо сверить руками.
 *
 *   node scripts/report-core-deprecations.mjs [путь-к-пакету-openclaw]
 *
 * Отчёт не падает и не гейтит сборку: устаревший подпуть иногда единственное
 * место, где живёт нужный символ (так у нас с `createArmableStallWatchdog`).
 * Жёсткий запрет держится отдельно — в `forbiddenImports` в check-sdk-imports.mjs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Подпути plugin-sdk, которые импортирует наш код. */
function importedSubpaths() {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|mts|js|mjs)$/.test(entry.name) || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/["']openclaw\/plugin-sdk\/([a-z0-9-]+)["']/g)) {
        const list = found.get(m[1]) ?? [];
        list.push(path.slice(root.length + 1));
        found.set(m[1], list);
      }
    }
  };
  walk(join(root, "src"));
  return found;
}

/**
 * Где искать ядро. В самом репозитории его нет: `openclaw` — опциональный peer,
 * и `npm i` его не ставит. Поэтому берём первое, что найдём:
 *   1) путь аргументом или в `OPENCLAW_CORE_DIR`;
 *   2) обычный резолв (вдруг всё же установлено);
 *   3) песочницы, которые оставил `check-core-compat.mjs`;
 *   4) ядро работающего гейта.
 */
function coreDistDirs() {
  const dirs = [];
  const fromArg = process.argv[2] ?? process.env.OPENCLAW_CORE_DIR;
  if (fromArg) {
    dirs.push(join(fromArg, "dist"));
  }
  try {
    const require = createRequire(join(root, "package.json"));
    dirs.push(join(dirname(require.resolve("openclaw/package.json")), "dist"));
  } catch {
    // ядро не установлено рядом — это норма
  }
  const sandbox = join(tmpdir(), "vk-core-compat");
  try {
    for (const version of readdirSync(sandbox).sort().reverse()) {
      dirs.push(join(sandbox, version, "node_modules", "openclaw", "dist"));
    }
  } catch {
    // песочниц ещё не было
  }
  dirs.push(join(homedir(), ".openclaw", "npm", "node_modules", "openclaw", "dist"));
  return dirs;
}

/** Реестр устареваний из установленного ядра. */
function coreRegistry() {
  const coreDist = coreDistDirs().find((dir) => {
    try {
      return readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  });
  if (!coreDist) {
    return null;
  }
  const marker = "plugin-sdk-channel-message-subpath";
  for (const file of readdirSync(coreDist).filter((n) => n.endsWith(".js"))) {
    const text = readFileSync(join(coreDist, file), "utf8");
    if (!text.includes(marker)) {
      continue;
    }
    const entries = new Map();
    for (const m of text.matchAll(/code: "(plugin-sdk-[a-z-]+)",\s*\n\s*subpath: "([a-z0-9-]+)",([\s\S]{0,400}?)\n\t\}/g)) {
      const [, code, subpath, tail] = m;
      entries.set(subpath, {
        code,
        status: /status: "([a-z-]+)"/.exec(tail)?.[1] ?? "deprecated",
        removeAfter: /removeAfter: "([0-9-]+)"/.exec(tail)?.[1],
        removalGate: /removalGate: "([a-z-]+)"/.exec(tail)?.[1],
        replacement: /replacement: "([^"]+)"/.exec(tail)?.[1],
      });
    }
    if (entries.size) {
      return entries;
    }
  }
  return null;
}

const imported = importedSubpaths();
const registry = coreRegistry();

if (!registry) {
  console.log(
    "Реестр устареваний не найден: ядро не установлено рядом либо сменило формат.\n" +
      "Укажи путь к ядру: node scripts/report-core-deprecations.mjs <путь-к-openclaw>",
  );
  process.exit(0);
}

const flagged = [...imported.keys()].filter((s) => registry.has(s)).sort();
console.log(`Импортируем подпутей: ${imported.size}. Помечено ядром: ${flagged.length}.`);
for (const subpath of flagged) {
  const e = registry.get(subpath);
  const when = e.removeAfter ? `удаление после ${e.removeAfter}` : e.removalGate ?? "срок не назван";
  console.log(`\n  ⚠ ${subpath} — ${e.status}, ${when}`);
  console.log(`     код ядра: ${e.code}`);
  console.log(`     замена:   ${e.replacement ?? "не указана"}`);
  console.log(`     у нас:    ${imported.get(subpath).join(", ")}`);
}
if (!flagged.length) {
  console.log("Ни один импортируемый подпуть не помечен — вырезать нечего.");
}
