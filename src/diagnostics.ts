/**
 * Диагностика VK-канала: три уровня вместо «есть/нет».
 *
 * Прежний `VK_VOICE_DEBUG_LOG` был всё-или-ничего и писал в файл целые пути,
 * ссылки и идентификаторы собеседников — включать его на живом канале было
 * нельзя. Отказываться от переключателя тоже неправильно: именно он позволил
 * найти, почему картинки приходили серой плашкой. Поэтому переключатель
 * остался, но стал уровнем:
 *
 * | уровень    | что видно |
 * |------------|-----------|
 * | `off`      | ничего (по умолчанию); отказы всё равно пишутся — см. ниже |
 * | `redacted` | ход дела без имён: вид вложения, размер, MIME, попытка, код |
 * | `full`     | то же плюс пути, ссылки, имена файлов и идентификаторы |
 *
 * **Обезличивание — свойство этого канала, а не дисциплина вызывающего.**
 * Вызывающий передаёт один словарь полей и не делит их на «можно» и «нельзя»:
 * решает `redactField` ниже, по форме значения и имени поля. Прежняя версия
 * требовала от каждого места вызова разложить поля на `safe`/`sensitive`, и
 * этого хватило ровно до первого невнимательного вызова — текст ошибки
 * считался безопасным, а `ENOENT` приносит в нём абсолютный путь.
 *
 * Отказы пишутся всегда, даже на `off`: они уже обезличены, а молчащий канал
 * об ошибке — та самая ловушка, из-за которой поломку VK однажды искали
 * полдня.
 *
 * Куда пишем: штатный логгер ядра (`runtime.logging.getChildLogger`) — он
 * умеет уровни, ротацию и не требует своего файла. Отдельный файл остаётся
 * необязательным дополнением через `VK_VOICE_DEBUG_LOG` для случая, когда
 * лента гейта слишком шумная.
 */
import { appendFile } from "node:fs/promises";
import { redactIdentifier, redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { RuntimeLogger } from "openclaw/plugin-sdk/core";
import { tryGetVkRuntime } from "./runtime.js";
import { VK_DIAG_LEVELS, type VkDiagLevel } from "./types.js";
import { readVkErrorCode, readVkErrorMessage } from "./vk-errors.js";
import { readCoreConfig } from "./sdk-compat.js";

export type { VkDiagLevel };

const VK_DIAG_LOG_BINDINGS = { module: "vk-diag" } as const;

/** Длина текстовых полей в логе: достаточно, чтобы узнать отказ, мало, чтобы утащить содержимое. */
const MAX_TEXT_FIELD = 120;

/**
 * Поля, значение которых называет собеседника или сообщение. На `redacted` они
 * не выбрасываются, а хэшируются: две неудачные отправки разным людям остаются
 * различимы в ленте, но кто это — по логу не узнать.
 */
const IDENTIFIER_FIELDS = new Set(["to", "peerId", "chatId", "messageId", "accountId"]);

function isVkDiagLevel(value: unknown): value is VkDiagLevel {
  return VK_DIAG_LEVELS.includes(value as VkDiagLevel);
}

/**
 * Уровень берём на каждый вызов, а не один раз при старте: правка конфига
 * подхватывается ядром на лету, и диагностику должно быть можно включить не
 * перезапуская гейт. Снимок конфига у ядра закреплён в памяти, так что это
 * чтение поля, а не диска.
 *
 * Переменная окружения перебивает конфиг — ей включают на пару минут, не трогая
 * `openclaw.json`.
 *
 * ⚠️ Читается только `channels.vk.diagnostics`, без разбора по аккаунтам — так
 * же, как рядом устроен `streaming`. На мультиаккаунтном гейте уровень общий.
 */
export function resolveVkDiagLevel(): VkDiagLevel {
  const fromEnv = process.env.VK_DIAG_LEVEL?.trim().toLowerCase();
  if (isVkDiagLevel(fromEnv)) {
    return fromEnv;
  }
  try {
    const channels = (readCoreConfig(tryGetVkRuntime()) as { channels?: unknown } | undefined)
      ?.channels as
      | { vk?: { diagnostics?: { level?: unknown } } }
      | undefined;
    const fromConfig = channels?.vk?.diagnostics?.level;
    if (isVkDiagLevel(fromConfig)) {
      return fromConfig;
    }
  } catch {
    /* диагностика никогда не должна ломать отправку */
  }
  return "off";
}

/**
 * Вид источника вместо самого источника: по нему видно, откуда бралось
 * вложение, но не что именно и не чьё. `file://` — это тоже локальный файл,
 * поэтому он попадает в `local`: набор видов намеренно совпадает со списком из
 * ревью (`local` / `remote` / `data`).
 */
export function describeVkSourceKind(
  source: unknown,
): "local" | "remote" | "data" | "buffer" | "none" {
  if (source === undefined || source === null) {
    return "none";
  }
  if (typeof source !== "string") {
    return "buffer";
  }
  if (source.startsWith("data:")) {
    return "data";
  }
  if (/^https?:\/\//i.test(source)) {
    return "remote";
  }
  return "local";
}

/**
 * Вычищает имена, спрятанные ВНУТРИ текста. Сообщения об ошибках — главный
 * канал утечки: `ENOENT: no such file or directory, open '/srv/renders/a.jpg'`
 * выглядит как описание проблемы, а несёт абсолютный путь. Целиком такую
 * строку выбросить нельзя — без неё непонятно, что случилось.
 */
function scrubNames(text: string): string {
  return (
    text
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
      // POSIX-пути.
      .replace(/(?:~|\.)?(?:\/[\w.@+-]+){2,}\/?/g, "<path>")
      // Windows-пути: `C:\Users\…` и UNC `\\host\share\…`. Раньше уходили
      // в лог целиком — регулярка знала только про слэш вперёд.
      .replace(/(?:[a-z]:)?(?:\\[\w.@+ -]+){2,}\\?/gi, "<path>")
      // Одиночное имя файла без пути: тоже имя, и по нему опознаётся вложение.
      .replace(/\b[\w.@+-]+\.(?:jpe?g|png|gif|webp|ogg|opus|mp3|m4a|wav|mp4|pdf|docx?|xlsx?|zip|json|md|txt)\b/gi, "<file>")
  );
}

/** Строка, которая называет файл или адрес, а не описывает происходящее. */
function namesSomething(value: string): boolean {
  return (
    value.startsWith("data:") ||
    value.includes("://") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./")
  );
}

/**
 * Единственное место, где решается, что попадёт в лог. Все поля проходят здесь,
 * поэтому новое место вызова не может «забыть» обезличить своё значение.
 */
function redactField(key: string, value: unknown, level: VkDiagLevel, depth = 0): unknown {
  // Ограничитель глубины стоит ДО разбора массивов: иначе массив, ссылающийся
  // сам на себя, уходит в бесконечную рекурсию и роняет отправку по стеку —
  // `vkDiag` вызывается прямо на пути отправки и ни во что не завёрнут.
  if (depth >= 4) {
    return "[глубже 4 уровней]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactField(key, item, level, depth + 1));
  }
  if (Buffer.isBuffer(value)) {
    // Содержимое вложения не пишем никогда, ни на одном уровне.
    return "buffer";
  }
  if (value instanceof Error) {
    // Ошибка как значение поля превращалась в `{}` — сообщение терялось.
    return redactField(key, `${value.name}: ${value.message}`, level, depth + 1);
  }
  if (value && typeof value === "object") {
    // Вложенные объекты раньше уходили в лог КАК ЕСТЬ, мимо редактора: любое
    // поле-объект с путём или peer id было утечкой. Разбираем рекурсивно и
    // ограничиваем глубину, чтобы циклическая ссылка не увела в бесконечность.
    if (value instanceof Map || value instanceof Set) {
      return `[${value.constructor.name}, ${value.size}]`;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = redactField(k, v, level, depth + 1);
      }
    }
    return out;
  }
  // Идентификаторы приходят и числами (`peerId: 12324712`), а не только
  // строками — проверку на них надо делать ДО отсечения нестрок, иначе peer id
  // уходит в лог сырым. На этом и попались: тесты подавали id строкой.
  if (typeof value === "number" && IDENTIFIER_FIELDS.has(key)) {
    return level === "full" ? value : redactIdentifier(String(value));
  }
  if (typeof value !== "string") {
    return value;
  }
  if (level === "full") {
    // Даже на полном уровне снимаем токены и ключи: они не нужны никогда.
    return redactSensitiveText(value);
  }
  if (namesSomething(value)) {
    return describeVkSourceKind(value);
  }
  if (IDENTIFIER_FIELDS.has(key)) {
    return redactIdentifier(value);
  }
  return scrubNames(redactSensitiveText(value)).slice(0, MAX_TEXT_FIELD);
}

function redactFields(
  fields: Record<string, unknown>,
  level: VkDiagLevel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    out[key] = redactField(key, value, level);
  }
  return out;
}

/**
 * Дочерний логгер ядра не кэшируется само́й функцией `getChildLogger` — она
 * клонирует настройки и создаёт объект на каждый вызов. Держим один на процесс
 * и пересоздаём, только если сменился сам рантайм (перерегистрация плагина).
 */
let cachedLogger: { runtime: unknown; logger: RuntimeLogger } | null = null;

function diagLogger(runtime: NonNullable<ReturnType<typeof tryGetVkRuntime>>): RuntimeLogger {
  if (cachedLogger?.runtime !== runtime) {
    cachedLogger = { runtime, logger: runtime.logging.getChildLogger(VK_DIAG_LOG_BINDINGS) };
  }
  return cachedLogger.logger;
}

function emit(event: string, fields: Record<string, unknown>, failure: boolean): void {
  const runtime = tryGetVkRuntime();
  if (runtime) {
    const logger = diagLogger(runtime);
    if (failure) {
      logger.error(event, fields);
    } else {
      logger.info(event, fields);
    }
  }
  appendVkDiagFile(event, fields);
}

/**
 * Идентификатор для строки штатного лога.
 *
 * Не всё в плагине проходит через `vkDiag`: часть сообщений — не диагностика,
 * а рабочие предупреждения («сообщение отброшено политикой», «не удалось
 * пометить прочитанным»), и они должны быть видны всегда. Печатать в них peer id
 * сырым нельзя, а выбрасывать — значит потерять возможность связать строки
 * между собой. Хэшируем так же, как поля диагностики; на `full` оставляем как
 * есть.
 */
export function redactVkId(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return resolveVkDiagLevel() === "full" ? String(value) : redactIdentifier(String(value));
}

/** Ход дела. Молчит на `off`; поля обезличиваются по уровню. */
export function vkDiag(event: string, fields: Record<string, unknown> = {}): void {
  const level = resolveVkDiagLevel();
  if (level === "off") {
    return;
  }
  emit(event, redactFields(fields, level), false);
}

/**
 * Отказ. Пишется на любом уровне, включая `off`, и всегда через `logger.error`.
 * Код и текст ошибки достаются здесь, а не в местах вызова: раньше их читали
 * тремя разными способами, и ветка голосовых теряла `description`.
 */
export function vkDiagFailure(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  const level = resolveVkDiagLevel();
  emit(
    event,
    redactFields(
      {
        ...fields,
        code: readVkErrorCode(error) ?? null,
        reason: readVkErrorMessage(error) || String(error ?? ""),
      },
      level === "off" ? "redacted" : level,
    ),
    true,
  );
}

/**
 * Необязательный отдельный файл: удобно, когда лента гейта слишком шумная.
 *
 * Записи выстроены в цепочку, а не отправлены параллельно: замер показал, что
 * несвязанные `appendFile` ложатся в файл не в порядке вызова (55 строк из 200),
 * а ценность этого файла ровно в том, что он хронологический. Ждать запись
 * вызывающий не должен — отправка не может зависеть от диска.
 */
let diagFileTail: Promise<void> = Promise.resolve();

function appendVkDiagFile(event: string, fields: Record<string, unknown>): void {
  const target = process.env.VK_VOICE_DEBUG_LOG;
  if (!target) {
    return;
  }
  // Сериализация в try: циклическая ссылка в поле роняла `JSON.stringify`, а он
  // стоит на пути отправки сообщения — диагностика не имеет права уронить ответ.
  let rendered: string;
  try {
    rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
  } catch {
    rendered = "[поля не сериализуются]";
  }
  const line = `[${new Date().toISOString()}] ${event}${rendered ? ` ${rendered}` : ""}\n`;
  diagFileTail = diagFileTail.then(
    () => appendFile(target, line).catch(() => undefined),
    () => appendFile(target, line).catch(() => undefined),
  );
}
