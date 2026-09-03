// Слой совместимости с plugin-sdk ядра.
//
// 8.1 перекроила публичный SDK: удалила `channel-runtime`, спрятала
// `issuePairingChallenge`, увела два типа во внутренние модули. Плагин при этом
// не падает громко — он просто не грузится, канал молча отсутствует, а причина
// видна лишь в строке `ERR_PACKAGE_PATH_NOT_EXPORTED` в логе загрузки.
//
// Поэтому импорты, которые ядро переносит от версии к версии, резолвим здесь —
// динамически и по факту наличия экспорта, а не по номеру версии: так плагин
// работает и на 8.x, и на 7.x, и переживёт следующий пересмотр экспортов.
import { createRequire } from "node:module";

// Сборка идёт с bundle:false, поэтому динамический import остаётся динамическим
// и резолвится Node уже на рантайме.

/** Тип, который 8.1 увела во внутренние модули (был в channel-message). */
export type StreamingCompatEntry = {
  streaming?: unknown;
};

/** То же самое: раньше приезжал из SDK, теперь держим свою копию. */
export type ChannelProgressDraftMode = "off" | "partial" | "block" | "progress";

// Типы берём статическим type-only импортом: сборщик их стирает, поэтому на
// рантайме этот путь не резолвится и на старом ядре ничего не ломает — зато
// вызовы остаются типизированными.

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
 * Мост к API ядра, которое 8.1 перекроила целиком: групп `core.channel.reply`,
 * `core.channel.session`, `core.channel.text` и объекта `core.config` больше
 * нет — те же функции переехали в подпути plugin-sdk.
 *
 * Диагностировать это было тяжело: вызов падал с «core.config.loadConfig is not
 * a function» внутри обработчика входящего, ошибка уходила в stderr, а stderr
 * gateway в нашем launchd-плисте был закрыт в /dev/null. Снаружи выглядело так,
 * будто VK принимает сообщения и молчит.
 *
 * Резолвим по наличию: сначала пробуем старое место (ядро 7.x отдаёт всё через
 * core), затем SDK-подпуть 8.x. Кэшируем — вызывается на каждое сообщение.
 */
