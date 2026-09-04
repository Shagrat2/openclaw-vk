/**
 * VK channel diagnostics: three levels instead of on/off.
 *
 * The old `VK_VOICE_DEBUG_LOG` was all-or-nothing and wrote whole paths, URLs
 * and peer identifiers to a file, so it could not be turned on for a live
 * channel. Dropping the switch would be wrong too: it is what revealed why
 * pictures arrived as grey file cards. So the switch stayed and became a level:
 *
 * | level      | what is visible |
 * |------------|-----------------|
 * | `off`      | nothing (default); failures are still logged — see below |
 * | `redacted` | progress without names: attachment kind, size, MIME, attempt, code |
 * | `full`     | the same plus paths, URLs, file names and identifiers |
 *
 * **Redaction is a property of this channel, not caller discipline.** Callers
 * pass one field map and never split it into allowed and forbidden: `redactField`
 * below decides, from the shape of the value and the name of the field. The
 * previous version asked every call site to sort fields into `safe`/`sensitive`,
 * which held exactly until the first inattentive call — an error message counted
 * as safe, and `ENOENT` carries an absolute path inside it.
 *
 * Failures are always logged, even at `off`: they are already redacted, and a
 * channel that stays silent about an error is the very trap that once turned a
 * VK breakage into half a day of searching.
 *
 * Where it goes: the core logger (`runtime.logging.getChildLogger`) — it knows
 * levels and rotation and needs no file of its own. A separate file stays an
 * optional extra through `VK_VOICE_DEBUG_LOG`, for when the gateway feed is too
 * noisy.
 */
import { appendFile } from "node:fs/promises";
import { redactIdentifier, redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { RuntimeLogger } from "openclaw/plugin-sdk/core";
import { tryGetVkRuntime } from "./runtime.js";
import { VK_DIAG_LEVELS, type VkDiagLevel } from "./types.js";
import { vkStringSetting } from "./settings.js";
import { readVkErrorCode, readVkErrorMessage } from "./vk-errors.js";

export type { VkDiagLevel };

const VK_DIAG_LOG_BINDINGS = { module: "vk-diag" } as const;

/** Text field length in the log: enough to recognize a failure, too little to carry content away. */
const MAX_TEXT_FIELD = 120;

/**
 * Fields whose value names a peer or a message. At `redacted` they are hashed
 * rather than dropped: two failed sends to different people stay distinguishable
 * in the feed, while the log never says who they are.
 */
const IDENTIFIER_FIELDS = new Set(["to", "peerId", "chatId", "messageId", "accountId"]);

function isVkDiagLevel(value: unknown): value is VkDiagLevel {
  return VK_DIAG_LEVELS.includes(value as VkDiagLevel);
}

/**
 * The level is read on every call rather than once at startup: the core picks
 * up config edits live, and it must be possible to turn diagnostics on without
 * restarting the gateway. The core keeps the config snapshot in memory, so this
 * is a field read, not a disk read.
 *
 * The environment variable overrides the config — it is what you use to switch
 * diagnostics on for a couple of minutes without touching `openclaw.json`.
 *
 * Only `channels.vk.diagnostics` is read, with no per-account split — the same
 * way `streaming` works next to it. On a multi-account gateway the level is
 * shared.
 */
export function resolveVkDiagLevel(): VkDiagLevel {
  const fromEnv = process.env.VK_DIAG_LEVEL?.trim().toLowerCase();
  if (isVkDiagLevel(fromEnv)) {
    return fromEnv;
  }
  try {
    const channels = tryGetVkRuntime()?.config.current()?.channels as
      | { vk?: { diagnostics?: { level?: unknown } } }
      | undefined;
    const fromConfig = channels?.vk?.diagnostics?.level;
    if (isVkDiagLevel(fromConfig)) {
      return fromConfig;
    }
  } catch {
    /* diagnostics must never break a send */
  }
  return "off";
}

/**
 * The kind of source instead of the source itself: it shows where an attachment
 * came from, but not which one or whose. `file://` is a local file too, so it
 * maps to `local`: the set of kinds deliberately matches the review's list
 * (`local` / `remote` / `data`).
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
 * Scrubs names hidden INSIDE text. Error messages are the main leak channel:
 * `ENOENT: no such file or directory, open '/srv/renders/a.jpg'` looks like a
 * description of the problem while carrying an absolute path. The string cannot
 * simply be dropped — without it there is no telling what happened.
 */
function scrubNames(text: string): string {
  return (
    text
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
      // POSIX paths.
      .replace(/(?:~|\.)?(?:\/[\w.@+-]+){2,}\/?/g, "<path>")
      // Windows paths: `C:\Users\…` and UNC `\\host\share\…`. These used to
      // reach the log intact — the pattern only knew about forward slashes.
      .replace(/(?:[a-z]:)?(?:\\[\w.@+ -]+){2,}\\?/gi, "<path>")
      // A bare file name with no path: still a name, and it identifies the attachment.
      .replace(/\b[\w.@+-]+\.(?:jpe?g|png|gif|webp|ogg|opus|mp3|m4a|wav|mp4|pdf|docx?|xlsx?|zip|json|md|txt)\b/gi, "<file>")
  );
}

/** A string that names a file or an address rather than describing what happens. */
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
 * The single place that decides what reaches the log. Every field passes through
 * here, so a new call site cannot forget to redact its value.
 */
function redactField(key: string, value: unknown, level: VkDiagLevel, depth = 0): unknown {
  // The depth guard comes BEFORE the array branch: otherwise a self-referencing
  // array recurses forever and takes the send down with a stack overflow —
  // `vkDiag` is called straight from the send path and is wrapped in nothing.
  if (depth >= 4) {
    return "[deeper than 4 levels]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactField(key, item, level, depth + 1));
  }
  if (Buffer.isBuffer(value)) {
    // Attachment content is never written, at any level.
    return "buffer";
  }
  if (value instanceof Error) {
    // An Error as a field value used to serialize to `{}` — the message was lost.
    return redactField(key, `${value.name}: ${value.message}`, level, depth + 1);
  }
  if (value && typeof value === "object") {
    // Nested objects used to reach the log AS IS, bypassing redaction: any
    // object field holding a path or a peer id was a leak. We walk them
    // recursively and cap the depth so a cycle cannot run away.
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
  // Identifiers also arrive as numbers (`peerId: 12324712`), not only strings,
  // so they must be checked BEFORE non-strings are returned early — otherwise a
  // peer id reaches the log raw. That is exactly what slipped through: the tests
  // passed ids as strings.
  if (typeof value === "number" && IDENTIFIER_FIELDS.has(key)) {
    return level === "full" ? value : redactIdentifier(String(value));
  }
  if (typeof value !== "string") {
    return value;
  }
  if (level === "full") {
    // Even at full level, tokens and keys are stripped: they are never needed.
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
 * The core does not cache child loggers inside `getChildLogger` — it clones the
 * settings and builds an object on every call. We keep one per process and
 * rebuild it only when the runtime itself changes (plugin re-registration).
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
 * An identifier for a regular log line.
 *
 * Not everything in the plugin goes through `vkDiag`: some messages are not
 * diagnostics but operational warnings ("message dropped by policy", "failed to
 * mark as read"), and they must always be visible. Printing a raw peer id in
 * them is not acceptable, and dropping it would make lines impossible to
 * correlate. So they are hashed the same way diagnostic fields are; at `full`
 * they are left as they are.
 */
export function redactVkId(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return resolveVkDiagLevel() === "full" ? String(value) : redactIdentifier(String(value));
}

/** Progress. Silent at `off`; fields are redacted according to the level. */
export function vkDiag(event: string, fields: Record<string, unknown> = {}): void {
  const level = resolveVkDiagLevel();
  if (level === "off") {
    return;
  }
  emit(event, redactFields(fields, level), false);
}

/**
 * A failure. Logged at every level, including `off`, and always through
 * `logger.error`. The error code and message are extracted here rather than at
 * the call sites: they used to be read in three different ways, and the voice
 * branch lost `description`.
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
 * An optional separate file: useful when the gateway feed is too noisy.
 *
 * Writes are chained rather than issued in parallel: measurement showed that
 * unrelated `appendFile` calls land out of call order (55 lines out of 200), and
 * the whole value of this file is that it is chronological. The caller must not
 * await the write — a send cannot depend on the disk.
 */
let diagFileTail: Promise<void> = Promise.resolve();

function appendVkDiagFile(event: string, fields: Record<string, unknown>): void {
  const target = vkStringSetting({ env: "VK_VOICE_DEBUG_LOG", section: "diagnostics", key: "file" });
  if (!target) {
    return;
  }
  // Serialization inside try: a cycle in a field used to crash `JSON.stringify`,
  // which sits on the message send path — diagnostics may never take a reply
  // down.
  let rendered: string;
  try {
    rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
  } catch {
    rendered = "[fields not serializable]";
  }
  const line = `[${new Date().toISOString()}] ${event}${rendered ? ` ${rendered}` : ""}\n`;
  // The same continuation for both outcomes: a previous failed append must not
  // stop the next line from being written.
  diagFileTail = diagFileTail
    .catch(() => undefined)
    .then(() => appendFile(target, line).catch(() => undefined));
}
