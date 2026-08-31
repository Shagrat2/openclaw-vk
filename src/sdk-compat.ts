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
import type * as ChannelMessageModule from "openclaw/plugin-sdk/channel-message";
import type * as ChannelFeedbackModule from "openclaw/plugin-sdk/channel-feedback";

type ChannelMessageBits = {
  createReplyPrefixOptions: typeof ChannelMessageModule.createReplyPrefixOptions;
  createTypingCallbacks: typeof ChannelMessageModule.createTypingCallbacks;
  logTypingFailure: typeof ChannelFeedbackModule.logTypingFailure;
};

let channelBitsPromise: Promise<ChannelMessageBits> | null = null;

/**
 * `createReplyPrefixOptions` / `createTypingCallbacks` / `logTypingFailure`:
 * на 8.x лежат в channel-message + channel-feedback, на 7.x — в channel-runtime.
 */
export function loadChannelMessageBits(): Promise<ChannelMessageBits> {
  channelBitsPromise ??= (async () => {
    try {
      const [message, feedback] = await Promise.all([
        import("openclaw/plugin-sdk/channel-message"),
        import("openclaw/plugin-sdk/channel-feedback"),
      ]);
      return {
        createReplyPrefixOptions: message.createReplyPrefixOptions,
        createTypingCallbacks: message.createTypingCallbacks,
        logTypingFailure: feedback.logTypingFailure,
      };
    } catch {
      // Ядро 7.x и старше: всё лежало одним модулем.
      const legacy = (await import(
        "openclaw/plugin-sdk/channel-runtime" as string
      )) as ChannelMessageBits;
      return legacy;
    }
  })();
  return channelBitsPromise;
}

/**
 * Выдача pairing-челленджа. На 8.x публичной функции больше нет — тот же вызов
 * делает контроллер, сам подставляя channel/accountId/upsertPairingRequest.
 * На 7.x контроллер метода не имел, и звали `issuePairingChallenge` напрямую.
 */
export async function issuePairingChallengeCompat(params: {
  controller: { issueChallenge?: (input: object) => Promise<unknown> };
  channel: string;
  upsertPairingRequest: unknown;
  challenge: Record<string, unknown>;
}): Promise<unknown> {
  const { controller, channel, upsertPairingRequest, challenge } = params;
  if (typeof controller.issueChallenge === "function") {
    return await controller.issueChallenge(challenge);
  }
  const legacy = (await import(
    "openclaw/plugin-sdk/conversation-runtime" as string
  )) as {
    issuePairingChallenge: (input: object) => Promise<unknown>;
  };
  return await legacy.issuePairingChallenge({
    ...challenge,
    channel,
    upsertPairingRequest,
  });
}

/**
 * Версия ядра для поведенческих развилок (не для импортов — те решаются по
 * факту экспорта). Возвращает строку вида "2026.8.1" или null, если прочитать
 * не удалось; вызывающий код в этом случае обязан выбрать безопасное поведение.
 */
let cachedCoreVersion: string | null | undefined;

export function resolveCoreVersion(): string | null {
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
