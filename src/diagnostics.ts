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
 * below decides, from the name of the field and the type of the value.
 *
 * **Below `full`, nothing free-form survives.** The previous version tried to
 * recognise paths and addresses inside text and strip them, and that is a losing
 * game: a Unicode path, a relative one, a data URI in the middle of an error
 * message — each escaped one pattern or another. So the rule is an allowlist:
 * identifiers are hashed, numbers and booleans pass, a handful of named fields
 * may carry a short token (`kind=photo`, `mime=image/jpeg`), a source field is
 * replaced by its kind (`local` / `remote` / `data`), and any other string —
 * an error message included — becomes the constant `<text>`. An error is
 * reported by its class, its numeric code and its `errno`-style code, which is
 * enough to tell an `ENOENT` from an `APIError 100` without carrying the path
 * or the request parameters along.
 *
 * At `full`, text is kept but never attachment contents: the payload of every
 * data URI is replaced by its length, whether the URI is the whole value or
 * embedded in a message. The core's secret redactor runs over the rest, plus
 * our own pass for what it does not cover — a VK access token, bare or in a
 * URL's query string.
 *
 * Failures are always logged, even at `off`: they are redacted as at
 * `redacted`, and a channel that stays silent about an error is the very trap
 * that once turned a VK breakage into half a day of searching.
 *
 * Where it goes: the core logger (`runtime.logging.getChildLogger`) — it knows
 * levels, rotation and file permissions, and needs no sink of its own.
 */
import { redactIdentifier, redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { RuntimeLogger } from "openclaw/plugin-sdk/core";
import { tryGetVkRuntime } from "./runtime.js";
import { VK_DIAG_LEVELS, type VkDiagLevel } from "./types.js";
import { readVkErrorCode } from "./vk-errors.js";

export type { VkDiagLevel };

const VK_DIAG_LOG_BINDINGS = { module: "vk-diag" } as const;

/** Even at `full`, a text field is capped: the log is for reading, not for carrying a payload away. */
const MAX_FULL_TEXT = 2_000;

/**
 * Fields whose value names a peer or a message. Below `full` they are hashed
 * rather than dropped: two failed sends to different people stay distinguishable
 * in the feed, while the log never says who they are.
 */
const IDENTIFIER_FIELDS = new Set([
  "to",
  "peerId",
  "chatId",
  "senderId",
  "messageId",
  "conversationMessageId",
  "cmid",
  "accountId",
]);

/**
 * Fields that may carry a short token below `full`: an attachment kind, a MIME
 * type, a stage name, an error class. The value still has to look like a token;
 * a path or a sentence under one of these names is replaced like any other text.
 */
const TOKEN_FIELDS = new Set([
  "kind",
  "mime",
  "stage",
  "phase",
  "mode",
  "outcome",
  "status",
  "errorName",
  "errno",
]);
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,63}$/i;

/** Fields whose value is where an attachment comes from; only the kind of source is kept. */
const SOURCE_FIELDS = new Set([
  "source",
  "uploadSource",
  "mediaUrl",
  "url",
  "path",
  "file",
  "dir",
  "remote",
  "inline",
]);

/** What replaces a string that is neither an identifier, a token nor a source. */
const TEXT_PLACEHOLDER = "<text>";

/**
 * A data URI, standalone or embedded in a message. The payload is everything
 * after the first comma up to whitespace or a quote — that is what must never
 * reach the log, at any level.
 */
const DATA_URI_RE = /data:([\w.+-]+\/[\w.+-]+)?((?:;[\w=+.-]+)*),([^\s'"<>]+)/gi;

/**
 * What the core's redactor does not cover, checked against the real
 * `plugin-sdk/logging-core` rather than assumed: it targets `KEY=value`
 * assignments, JSON secret fields and CLI flags, and leaves a credential in a
 * URL's query string (`?access_token=…`) and a bare VK token (`vk1.a.…`) as they
 * are. Both can appear in an error thrown by vk-io, so they are stripped here.
 */
const VK_TOKEN_RE = /\bvk1\.a\.[A-Za-z0-9_-]{8,}/g;
const CREDENTIAL_QUERY_RE =
  /([?&](?:access_token|token|secret|client_secret|api_key|apikey|key|password|passwd)=)[^&\s'"<>]+/gi;

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
 * diagnostics on for a couple of minutes without touching `openclaw.json`. It
 * fails closed: a set but unrecognised value resolves to `off` and does not
 * fall through to whatever the config says, so a typo in the override can never
 * widen what is logged.
 *
 * Only `channels.vk.diagnostics` is read, with no per-account split — the same
 * way `streaming` works next to it. On a multi-account gateway the level is
 * shared.
 */
export function resolveVkDiagLevel(): VkDiagLevel {
  const rawEnv = process.env.VK_DIAG_LEVEL;
  if (rawEnv !== undefined && rawEnv.trim() !== "") {
    const fromEnv = rawEnv.trim().toLowerCase();
    return isVkDiagLevel(fromEnv) ? fromEnv : "off";
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
  if (/^\s*data:/i.test(source)) {
    return "data";
  }
  if (/^\s*https?:\/\//i.test(source)) {
    return "remote";
  }
  return "local";
}

/**
 * Replaces the payload of every data URI in the text by its length; the MIME
 * type and parameters stay. Idempotent: the placeholder opens with `<`, which
 * the payload pattern excludes, so a second pass leaves it alone.
 */
function stripDataUriPayloads(text: string): string {
  return text.replace(
    DATA_URI_RE,
    (_match, mime: string | undefined, params: string | undefined, payload: string) =>
      `data:${mime ?? ""}${params ?? ""},<${payload.length} chars>`,
  );
}

/** Credentials the core's patterns leave alone; see `VK_TOKEN_RE`. */
function stripVkCredentials(text: string): string {
  return text
    .replace(CREDENTIAL_QUERY_RE, "$1<redacted>")
    .replace(VK_TOKEN_RE, "vk1.a.<redacted>");
}

/** Text at `full`: no attachment contents, no secrets, bounded length. */
function fullText(value: string): string {
  const stripped = stripVkCredentials(redactSensitiveText(stripDataUriPayloads(value)));
  return stripped.length > MAX_FULL_TEXT ? `${stripped.slice(0, MAX_FULL_TEXT)}…` : stripped;
}

/** Text below `full`: only what is an identifier, a token or a source kind, by field name. */
function redactedText(key: string, value: string): string {
  if (IDENTIFIER_FIELDS.has(key)) {
    return redactIdentifier(value);
  }
  if (SOURCE_FIELDS.has(key)) {
    return describeVkSourceKind(value);
  }
  if (TOKEN_FIELDS.has(key) && (key === "mime" ? MIME_RE : TOKEN_RE).test(value)) {
    return value;
  }
  // A data URI or an address under any other name still says what kind of
  // thing it was; everything else is text, and text is not metadata.
  const kind = describeVkSourceKind(value);
  return kind === "data" || kind === "remote" ? kind : TEXT_PLACEHOLDER;
}

/** An error by class and codes only — what is safe to log at every level. */
type VkErrorSummary = {
  errorName: string;
  code: number | null;
  errno?: string;
};

function summarizeError(error: unknown): VkErrorSummary {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const rawName =
    record && typeof record.name === "string"
      ? record.name
      : error === undefined || error === null
        ? "none"
        : typeof error;
  const summary: VkErrorSummary = {
    errorName: TOKEN_RE.test(rawName) ? rawName : "Error",
    code: readVkErrorCode(error) ?? null,
  };
  // Node's system errors carry `code: "ENOENT"`; vk-io's carry a number, read above.
  if (record && typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(record.code)) {
    summary.errno = record.code;
  }
  return summary;
}

/**
 * The error's raw text, for `full` only — every field vk-io puts it in, minus
 * the class name, which is its own field. Not sanitised here: it goes through
 * `redactField` like any other string, exactly once.
 */
function errorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? error : String(error ?? "");
  }
  const record = error as Record<string, unknown>;
  return [record.message, record.description]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
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
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    // Attachment content is never written, at any level.
    return "buffer";
  }
  if (value instanceof Error) {
    // An Error as a field value used to serialize to `{}` — the class was lost.
    const summary = summarizeError(value);
    return level === "full" ? `${summary.errorName}: ${fullText(errorText(value))}` : summary;
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
  // peer id reaches the log raw.
  if ((typeof value === "number" || typeof value === "bigint") && IDENTIFIER_FIELDS.has(key)) {
    return level === "full" ? value : redactIdentifier(String(value));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "string") {
    // Functions, symbols: nothing to log, and nothing that could leak.
    return `[${typeof value}]`;
  }
  return level === "full" ? fullText(value) : redactedText(key, value);
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
  if (!runtime) {
    // Before the plugin is registered there is nowhere to write, and nothing
    // here may throw on the send path.
    return;
  }
  const logger = diagLogger(runtime);
  if (failure) {
    logger.error(event, fields);
  } else {
    logger.info(event, fields);
  }
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
 * `logger.error`. The error is summarised here rather than at the call sites:
 * its class, numeric code and `errno`-style code at every level, its text only
 * at `full` — the text is where paths and request parameters travel.
 */
export function vkDiagFailure(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  const level = resolveVkDiagLevel();
  const effective: VkDiagLevel = level === "off" ? "redacted" : level;
  const summary = summarizeError(error);
  emit(
    event,
    redactFields(
      {
        ...fields,
        ...summary,
        ...(effective === "full" ? { reason: errorText(error) } : {}),
      },
      effective,
    ),
    true,
  );
}
