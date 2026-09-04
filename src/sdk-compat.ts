// Слой совместимости с plugin-sdk ядра: версия ядра, сравнение версий и то,
// что ядро переименовало между поддерживаемыми версиями.
//
// Модуль намеренно ничего не импортирует из SDK — тогда его можно звать из
// любого места, не втягивая за собой подпуть, которого на этой версии может не
// быть. Развилки по отсутствующим символам живут рядом с их местом
// использования (`status-patches.ts`, `inbound.ts`).
//
// Полный перечень версионных развилок и условия их снятия — doc/core-compat.md.
import { createRequire } from "node:module";

/** Тип, который 8.1 увела во внутренние модули (был в channel-message). */
export type StreamingCompatEntry = {
  streaming?: unknown;
};

/** То же самое: раньше приезжал из SDK, теперь держим свою копию. */
export type ChannelProgressDraftMode = "off" | "partial" | "block" | "progress";

/**
 * Версия ядра для поведенческих развилок (не для импортов — те решаются по
 * факту экспорта). Возвращает строку вида "2026.8.1" или null, если прочитать
 * не удалось; вызывающий код в этом случае обязан выбрать безопасное поведение.
 */
let cachedCoreVersion: string | null | undefined;

function resolveCoreVersion(): string | null {
  if (cachedCoreVersion !== undefined) {
    return cachedCoreVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("openclaw/package.json") as { version?: string };
    cachedCoreVersion = pkg.version ?? null;
  } catch {
    cachedCoreVersion = null;
  }
  return cachedCoreVersion;
}

/** Сравнение версий вида YYYY.M.P (с необязательным -N суффиксом). */
export function compareCoreVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

/** true, если ядро не старше указанной версии. null-версия трактуется как «новое». */
export function coreAtLeast(version: string): boolean {
  const current = resolveCoreVersion();
  if (!current) {
    return true;
  }
  return compareCoreVersions(current, version) >= 0;
}

/**
 * Текущий конфиг ядра.
 *
 * Группа `config` переименовала свой основной метод: 2026.7 отдаёт конфиг через
 * `loadConfig()`, 2026.8 — через `current()`, и ни одна из версий не знает
 * метода другой. Промах здесь не диагностируется по логу: `current is not a
 * function` вылетает внутри обработчика входящего, а stderr гейта в проде
 * когда-то был закрыт — снаружи это выглядело как «VK принимает и молчит».
 *
 * Резолвим по факту наличия метода, а не по номеру версии: так переживём и
 * следующее переименование.
 *
 * core-compat: 2026.7 · ветка `loadConfig` · снять, когда
 * `openclaw.compat.minGatewayVersion` станет >= 2026.8.1 — тогда тело сводится к
 * одной строке `return source?.config?.current?.()`.
 */
type CoreConfigGroup = {
  current?: () => unknown;
  loadConfig?: () => unknown;
};

export function readCoreConfig(source: { config?: CoreConfigGroup } | null | undefined): unknown {
  const group = source?.config;
  if (typeof group?.current === "function") {
    return group.current();
  }
  if (typeof group?.loadConfig === "function") {
    return group.loadConfig();
  }
  return undefined;
}
