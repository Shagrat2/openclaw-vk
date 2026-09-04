#!/usr/bin/env node
/**
 * Проверка плагина против нескольких версий ядра.
 *
 * Зачем: несовместимость с версией ядра проявляется не падением сборки, а
 * молчаливым отсутствием канала — Node отказывается связать модуль, у которого
 * именованный импорт не найден, а плагин просто не грузится. Сборка этого не
 * ловит (esbuild не проверяет типы), юнит-тесты тоже (там моки).
 *
 * Что делает: на каждую версию поднимает песочницу с настоящим ядром и нашими
 * зависимостями (разрешает npm, поэтому версии транзитивных пакетов честные) и
 * импортирует КАЖДЫЙ собранный модуль по отдельности.
 *
 *   node scripts/check-core-compat.mjs                 # версии по умолчанию
 *   node scripts/check-core-compat.mjs 2026.7.1 2026.9.0
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const versions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["2026.7.1", "2026.8.1", "2026.8.2"];

const cache = join(tmpdir(), "vk-core-compat");
mkdirSync(cache, { recursive: true });

let failed = false;
for (const version of versions) {
  const sandbox = join(cache, version);
  const marker = join(sandbox, "node_modules", "openclaw", "package.json");
  let installed = false;
  try {
    installed = JSON.parse(readFileSync(marker, "utf8")).version === version;
  } catch {
    installed = false;
  }
  if (!installed) {
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(
      join(sandbox, "package.json"),
      // Зависимости плагина + ядро нужной версии: пусть npm сам сведёт
      // транзитивные версии, иначе легко подсунуть ядру чужую копию пакета и
      // получить отказ, не имеющий отношения к плагину.
      `${JSON.stringify(
        { name: "vk-core-compat", private: true, dependencies: { ...pkg.dependencies, openclaw: version } },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`  ${version}: ставлю ядро и зависимости…\n`);
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: sandbox, stdio: "inherit" });
  }

  const plugin = join(sandbox, "plugin");
  rmSync(plugin, { recursive: true, force: true });
  mkdirSync(plugin, { recursive: true });
  cpSync(join(root, "dist"), join(plugin, "dist"), { recursive: true });
  writeFileSync(join(plugin, "package.json"), `${JSON.stringify({ name: "vk-under-test", type: "module" }, null, 2)}\n`);

  const modules = [];
  for (const dir of [join(plugin, "dist"), join(plugin, "dist", "src")]) {
    for (const file of readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
      modules.push(join(dir, file));
    }
  }

  const probe = join(sandbox, "probe.mjs");
  writeFileSync(
    probe,
    `const mods = ${JSON.stringify(modules)};
let ok = 0;
const bad = [];
for (const m of mods) {
  try { await import(m); ok += 1; }
  catch (e) { bad.push(m.split("/").pop() + ": " + String(e.message).split("\\n")[0].slice(0, 160)); }
}
console.log("  загрузилось " + ok + ", отказов " + bad.length);
for (const b of bad) console.log("    ✗ " + b);
process.exit(bad.length ? 1 : 0);
`,
  );

  process.stdout.write(`════ ядро ${version} ════\n`);
  try {
    execFileSync(process.execPath, [probe], { cwd: sandbox, stdio: "inherit" });
  } catch {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
