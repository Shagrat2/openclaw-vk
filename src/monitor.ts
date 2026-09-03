import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { VK } from "vk-io";
import {
  createAccountStatusSink,
  createArmableStallWatchdog,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-lifecycle";
import {
  channelReadyPatch,
  channelStoppedPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";
import { resolveVkAccount } from "./accounts.js";
import { instrumentPollingTransport } from "./transport-liveness.js";
import { redactVkId, resolveVkDiagLevel, vkDiag } from "./diagnostics.js";
import { handleVkInbound } from "./inbound.js";
import {
  extractVkInboundAttachments,
  resolveVkInboundReplyContext,
} from "./media.js";
import { getVkRuntime } from "./runtime.js";
import { coreAtLeast, loadCoreBridge } from "./sdk-compat.js";
import { primeVkGroupId } from "./send.js";
import type { CoreConfig, VkInboundMessage } from "./types.js";

// ── Inbound coalescing (debounce) ────────────────────────────────────────────
// Rapid same-conversation messages are buffered and flushed as ONE combined
// inbound, the way every other channel (whatsapp/telegram/feishu/msteams/…) uses
// the core inbound debouncer. VK was the odd one out that dispatched each message
// immediately. Two wins:
//   1. A burst of quick messages becomes a single coherent reply instead of N.
//   2. The debouncer's per-key serialization means core never dispatches two
//      replies for the same conversation concurrently — which is exactly the
//      trigger for the core reply-dispatch concurrency bugs (deadlock / #98562
//      "reply session initialization conflicted"). So this both improves UX and
//      sidesteps those core bugs, without a strict per-peer promise chain.
// Coalescing is opt-in: VK_INBOUND_DEBOUNCE_MS defaults to 0, which disables
// batching but keeps per-peer serialization (via serializeImmediate) — the safe
// sequential behavior with no added latency. Set it > 0 to enable coalescing.

/**
 * Merge a buffered burst of text messages into one inbound. Keeps the last
 * message's ids/timestamp so replies/reactions target the latest message.
 */
export function combineVkInboundMessages(
  items: VkInboundMessage[],
): VkInboundMessage | null {
  if (items.length === 0) {
    return null;
  }
  const last = items[items.length - 1];
  if (items.length === 1) {
    return last;
  }
  const combinedText = items
    .map((m) => m.text)
    .filter((t) => t.length > 0)
    .join("\n");
  return { ...last, text: combinedText };
}

export type VkMonitorOptions = {
  token: string;
  accountId: string;
  config: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  /**
   * Приём состояния канала ядром. С 2026.8.1 перезапуском, бэкоффом и
   * health-мониторингом владеет ядро — плагин только сообщает, что видит у
   * своего long-poll. Патчи собираем каноническими билдерами SDK, чтобы
   * значения совпадали с тем, что читает health-policy.
   */
  setStatus?: Parameters<typeof createAccountStatusSink>[0]["setStatus"];
};

// ── Long-poll watchdog tunables (env-overridable) ──────────────────────────
// vk-io's polling has internal retry but it is SILENT (debug-only) and can get
// wedged so that the long-poll request stops delivering updates while the API
// itself stays healthy — which manifests as "VK goes silent until the gateway
// is restarted" (commonly right after a gateway restart). The watchdog below
// supervises the poller via vk-io's internal `ts` event cursor plus an active
// token probe: a moving cursor proves liveness for free, while a static or
// unreadable cursor triggers a probe (never an immediate restart — VK's cursor
// does NOT advance on empty idle polls). When the token is genuinely
// unreachable, the poller is recreated in-place (no gateway restart), with a
// logged reason and backoff.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
// How often to inspect the poller heartbeat.
/**
 * Порог тишины транспорта. Ядро следит за `lastTransportActivityAt` и само,
 * но с дефолтом в 30 минут; здесь мы лишь УСКОРЯЕМ ту же проверку до пары
 * минут. Long poll ждёт события до ~25 с, поэтому 150 с — заведомо аномалия,
 * а не спокойный диалог.
 */
const TRANSPORT_SILENCE_MS = envInt("VK_LP_SILENCE_MS", 150_000);
// When the `ts` cursor is static or unreadable, probe the API after this much
// idle, and restart after this many consecutive probe failures. (VK_LP_TS_STALE_MS
// is retired: VK's `ts` is an event cursor that legitimately stays static on an
// idle channel, so cursor staleness alone must never trigger a restart.)
/**
 * Нужна ли per-peer сериализация входящих.
 *
 * Это был обход дедлока ядра при втором сообщении в диалоге; ядро чинит его
 * нативно с 2026.7.1 (fire-and-forget mirror, PR #99549), поэтому на свежем
 * ядре включать её незачем — она стоит параллелизма. На старом ядре она нужна.
 * Явный override: VK_SERIALIZE_INBOUND=true|false.
 */
export function resolveSerializeInbound(): boolean {
  const flag = process.env.VK_SERIALIZE_INBOUND;
  if (flag === "true") {
    return true;
  }
  if (flag === "false") {
    return false;
  }
  return !coreAtLeast(CORE_VERSION_WITH_MIRROR_FIX);
}

/** Ядро, начиная с которого дедлок mirror-transcript исправлен нативно. */
const CORE_VERSION_WITH_MIRROR_FIX = "2026.7.1";

// Inbound debounce window (opt-in, default OFF). When > 0, same-conversation
// messages arriving within this window are buffered and flushed as one combined
// inbound (coalesced reply). 0 = no batching, just per-peer serialization — the
// safe default: avoids the concurrent-dispatch deadlock without adding latency.
// Set VK_INBOUND_DEBOUNCE_MS>0 to enable coalescing (best paired with a core that
// has the reply-session reentrancy fix, so the flush after a turn can't hit
// #98562). ~1000-2000ms is a reasonable window for catching a quick follow-up.
const INBOUND_DEBOUNCE_MS = envInt("VK_INBOUND_DEBOUNCE_MS", 0);

/**
 * Check whether the Bots Long Poll API is accessible for this token.
 * Requires the `manage` scope; tokens with only `messages` scope will fail.
 */
async function canUseBotsLongPoll(vk: VK): Promise<{ ok: boolean; groupId?: number }> {
  try {
    const { groups } = await vk.api.groups.getById({});
    const groupId = groups[0]?.id;
    if (!groupId) {
      return { ok: false };
    }
    try {
      // Verify the token can actually start Bots LP
      await vk.api.groups.getLongPollServer({ group_id: groupId });
      return { ok: true, groupId };
    } catch {
      return { ok: false, groupId };
    }
  } catch {
    return { ok: false };
  }
}

/**
 * Start monitoring VK community messages via Long Poll API.
 * Prefers Bots Long Poll when the token has the `manage` scope; falls back to
 * User Long Poll (messages.getLongPollServer) when only `messages` is available.
 *
 * The poller is supervised: if it stalls (heartbeat frozen) or stops, it is
 * torn down and recreated in-place (with backoff) so VK ingress recovers
 * WITHOUT a gateway restart. Every restart is logged (vk-io's own retries are
 * debug-only/silent).
 */
export async function monitorVkProvider(opts: VkMonitorOptions): Promise<void> {
  const core = getVkRuntime();
  const account = resolveVkAccount({
    cfg: opts.config,
    accountId: opts.accountId,
  });
  const tag = `[${opts.accountId}]`;

  let stopped = false;
  const onAbort = () => {
    stopped = true;
  };
  if (opts.abortSignal?.aborted) {
    return;
  }
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  // One debouncer per monitor — buffers survive vk-io restarts (the `vk` client
  // is recreated inside the loop; the debouncer is not). Its per-key
  // serialization is what keeps core from dispatching two same-conversation
  // replies concurrently.
  const inboundDebouncer =
    core.channel.debounce.createInboundDebouncer<VkInboundMessage>({
      debounceMs: INBOUND_DEBOUNCE_MS,
      // Per-peer inbound serialization was the workaround for the core
      // transcript-mirror completion deadlock (the queueDepth>=2 session-lock
      // hang: stalled_agent_run, phase=running, recovery=none). Core 2026.7.1
      // fixes that deadlock natively (fire-and-forget mirror, PR #99549 /
      // b381559), so serialization is no longer needed for the mirror hang and we
      // default to true concurrency. Escape hatch: set VK_SERIALIZE_INBOUND=true
      // to force serialization back on if the separate session-init conflict
      // (#98562) resurfaces on a concurrent second message.
      // See doc/interrupt-restart-session-lock-hang.md.
      serializeImmediate: resolveSerializeInbound(),
      buildKey: (msg) => `${account.accountId}:${msg.peerId}`,
      // Only merge plain-text messages; ones carrying attachments or a payload
      // flush on their own (immediately) but are still serialized per peer.
      shouldDebounce: (msg) =>
        msg.text.length > 0 &&
        (msg.attachments?.length ?? 0) === 0 &&
        msg.messagePayload === undefined,
      // ⚠️ Контракт onFlush менялся: ядро ≥2026.8.1 передаёт вторым аргументом
      // фабрику и ждёт назад { admission, completion } — «полоса» освобождается
      // на admission, пока completion ещё идёт. Старое ядро ждало обычный
      // промис. Если вернуть промис новому ядру, оно падает на flush.admission,
      // и сообщение теряется МОЛЧА: канал показывает приём, обработчик не
      // зовётся, в логе ни строки (31.08 так «умер» VK после апдейта).
      onFlush: ((items: VkInboundMessage[], createFlush?: unknown) => {
        vkDiag("inbound flush", { items: items.length, createFlush: typeof createFlush });
        const dispatch = async () => {
          try {
            return await dispatchInner();
          } catch (err) {
            opts.runtime.error?.(
              `vk: dispatch threw: ${err instanceof Error ? `${err.message} | ${err.stack?.split("\n")[1]?.trim() ?? ""}` : String(err)}`,
            );
            throw err;
          }
        };
        const dispatchInner = async () => {
          vkDiag("inbound dispatch start", { items: items.length, stopped });
        if (stopped) {
          // Тихий выход здесь означал «сообщение исчезло без следа» — логируем.
          opts.runtime.log?.("vk: dispatch skipped (monitor stopped)");
          return;
        }
        const message = combineVkInboundMessages(items);
        if (!message) {
          opts.runtime.log?.("vk: dispatch skipped (no message after combine)");
          return;
        }
        try {
          const bridge = await loadCoreBridge(core);
          const currentCfg = bridge.loadConfig() as CoreConfig;
          const currentAccount = resolveVkAccount({
            cfg: currentCfg,
            accountId: account.accountId,
          });
          await handleVkInbound({
            message,
            account: currentAccount,
            config: currentCfg,
            runtime: opts.runtime,
            // Остановка гейта доходит до внешних процессов отправки (ffmpeg).
            abortSignal: opts.abortSignal,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          opts.runtime.error?.(
            `vk: message handler error for peerId=${redactVkId(message.peerId)}: ${errorMessage}`,
          );
        }
        };
        // Новое ядро: отдаём ему пару admission/completion. Старое: обычный промис.
        if (typeof createFlush === "function") {
          return (createFlush as (p: { dispatch: () => Promise<void> }) => unknown)({
            dispatch,
          });
        }
        return dispatch();
      }) as never,
      onError: (err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        opts.runtime.error?.(`vk: inbound debouncer error: ${errorMessage}`);
      },
    });

  try {
    {
      const vk = new VK({ token: opts.token, apiLimit: 20 });
      // Свой сигнал остановки: сторож тишины завершает задачу аккаунта, и
      // ядро поднимает канал заново со своим бэкоффом.
      const localStop = new AbortController();
      const stopSignal = opts.abortSignal
        ? AbortSignal.any([opts.abortSignal, localStop.signal])
        : localStop.signal;
      const publishStatus = opts.setStatus
        ? createAccountStatusSink({ accountId: opts.accountId, setStatus: opts.setStatus })
        : undefined;

      // Датчик на ВСЕ апдейты: показывает, доходят ли до плагина события
      // вообще. Без него «канал молчит» неотличимо от «VK не присылает
      // апдейты», а это разные поломки с разным лечением. Промежуточный слой
      // ставим только когда диагностика включена — на `off` он не нужен.
      if (resolveVkDiagLevel() !== "off") {
        vk.updates.use(async (context: { type?: string; subTypes?: string[] }, next: () => Promise<void>) => {
          vkDiag("update", {
            type: context?.type ?? "?",
            sub: (context?.subTypes ?? []).join(","),
          });
          await next();
        });
      }

      // Самопроверка цепочки (VK_SELFTEST=<peerId>): прогоняем синтетическое
      // входящее через тот же дебаунсер, что и живые сообщения. Нужна потому,
      // что поломку приёма нельзя воспроизвести снаружи — сообщение боту может
      // отправить только человек, а «канал running» ничего не доказывает.
      const selftestPeer = Number(process.env.VK_SELFTEST ?? "");
      if (Number.isFinite(selftestPeer) && selftestPeer > 0) {
        setTimeout(() => {
          const probe: VkInboundMessage = {
            // ⚠️ id должен быть валидным int32 И существовать в диалоге: VK
            // кладёт его в reply_to. Синтетика тут только мешает — берём id из
            // VK_SELFTEST_MSGID, а без него шлём без ответа-реплая (0).
            messageId: process.env.VK_SELFTEST_MSGID ?? "0",
            peerId: selftestPeer,
            senderId: selftestPeer,
            text: process.env.VK_SELFTEST_TEXT ?? "селф-тест канала",
            timestamp: Date.now(),
            isGroup: false,
            attachments: [],
          };
          opts.runtime.log?.(`vk: selftest enqueue peer=${redactVkId(selftestPeer)}`);
          void inboundDebouncer
            .enqueue(probe)
            .then(() => opts.runtime.log?.("vk: selftest enqueued ok"))
            .catch((err: unknown) =>
              opts.runtime.error?.(`vk: selftest enqueue failed: ${String(err)}`),
            );
        }, 8000);
      }

      vk.updates.on("message_new", async (context) => {
        // Датчик на самом входе: без него «канал принимает, но не отвечает»
        // неотличимо от «событие вообще не пришло» — а это разные поломки.
        vkDiag("inbound event", {
          id: context.id,
          peerId: context.peerId,
          outbox: context.isOutbox,
          len: (context.text ?? "").length,
        });
        if (stopped) {
          return;
        }
        // Skip outgoing messages
        if (context.isOutbox) {
          return;
        }

        const peerId = context.peerId;
        const senderId = context.senderId;
        const text = context.text ?? "";
        const isGroup = peerId >= 2_000_000_000;
        const attachments = extractVkInboundAttachments(context.attachments);
        const replyContext = resolveVkInboundReplyContext(context.replyMessage);
        const createdAtSeconds =
          typeof context.createdAt === "number" && Number.isFinite(context.createdAt)
            ? context.createdAt
            : undefined;

        const message: VkInboundMessage = {
          messageId: String(context.id),
          conversationMessageId:
            typeof context.conversationMessageId === "number" && Number.isFinite(context.conversationMessageId)
              ? context.conversationMessageId
              : undefined,
          peerId,
          senderId,
          text,
          timestamp: createdAtSeconds ? createdAtSeconds * 1000 : Date.now(),
          isGroup,
          messagePayload: context.messagePayload,
          attachments,
          replyToMessageId: replyContext.replyToMessageId,
          replyToText: replyContext.replyToText,
        };

        core.channel.activity.record({
          channel: "vk",
          accountId: account.accountId,
          direction: "inbound",
          at: message.timestamp,
        });

        // Hand off to the debouncer: it buffers/merges a burst and serializes
        // per peer, then calls handleVkInbound once via onFlush. onFlush owns
        // error handling, so a bad turn never breaks ingestion.
        try {
          await inboundDebouncer.enqueue(message);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          opts.runtime.error?.(
            `vk: inbound enqueue error for peerId=${redactVkId(peerId)}: ${errorMessage}`,
          );
        }
      });

      let groupId: number | undefined;
      const stopVk = async () => {
        try {
          await vk.updates.stop();
        } catch {
          // ignore stop race/errors on shutdown/restart
        }
      };

      try {
        // Detect whether Bots LP is available; fall back to User LP otherwise.
        const botsLp = await canUseBotsLongPoll(vk);
        groupId = botsLp.groupId;
        if (groupId !== undefined) {
          primeVkGroupId(opts.token, groupId);
        }
        if (botsLp.ok && groupId !== undefined) {
          opts.runtime.log?.(`${tag} using Bots Long Poll (group ${groupId})`);
          await vk.updates.start();
        } else {
          opts.runtime.log?.(
            `${tag} Bots Long Poll unavailable, falling back to User Long Poll`,
          );
          await vk.updates.startPolling();
        }

        // ── Живость транспорта вместо своего сторожа ───────────────────
        // Ядро с 2026.8.1 владеет перезапуском и бэкоффом, поэтому плагин
        // больше не перезапускается сам: он публикует состояние и завершает
        // задачу аккаунта, если long-poll залип.
        //
        // Честный признак живости один — HTTP-запрос за обновлениями вернулся.
        // Курсор для этого не годится: он двигается по СОБЫТИЯМ, поэтому на
        // тихом канале стоит часами, а `isStarted` остаётся true на залипшем
        // транспорте. Проба токена подтверждает лишь, что жив обычный API.
        //
        // ⚠️ Инструментировать можно только ПОСЛЕ старта: `updates.start()`
        // пересоздаёт транспорт, и обёртка, поставленная раньше, легла бы на
        // выброшенный объект.
        const stallWatchdog = createArmableStallWatchdog({
          label: `vk:${opts.accountId} long-poll`,
          timeoutMs: TRANSPORT_SILENCE_MS,
          abortSignal: stopSignal,
          runtime: opts.runtime,
          onTimeout: ({ idleMs }) => {
            const silentSec = Math.round(idleMs / 1000);
            publishStatus?.(
              channelStoppedPatch({
                lastError: `no completed long-poll request for ${silentSec}s`,
                lastDisconnect: {
                  at: Date.now(),
                  error: `long poll silent for ${silentSec}s`,
                },
              }),
            );
            opts.runtime.log(
              `${tag} long poll silent for ${silentSec}s — handing restart to the gateway`,
            );
            localStop.abort();
          },
        });

        const instrumented = instrumentPollingTransport(vk.updates, () => {
          stallWatchdog.touch();
          publishStatus?.(createTransportActivityStatusPatch());
        });

        const startedAt = Date.now();
        publishStatus?.(
          channelReadyPatch({
            lastConnectedAt: startedAt,
            ...createTransportActivityStatusPatch(startedAt),
            mode: "longpoll",
          }),
        );

        if (instrumented) {
          stallWatchdog.arm();
        } else {
          // Снять сигнал не вышло — говорим вслух, вместо того чтобы делать
          // вид, что канал под наблюдением. Ядро заметит застой по своему
          // порогу, просто позже.
          opts.runtime.log(
            `${tag} poll instrumentation unavailable — transport liveness will not be reported`,
          );
        }

        await waitUntilAbort(stopSignal);
      } catch (err) {
        // Ошибку публикуем и выходим: перезапуском владеет ядро.
        const msg = err instanceof Error ? err.message : String(err);
        publishStatus?.(
          channelStoppedPatch({
            lastError: msg,
            lastDisconnect: { at: Date.now(), error: msg },
          }),
        );
        opts.runtime.log(`${tag} VK long-poll failed — handing restart to the gateway: ${msg}`);
      } finally {
        await stopVk();
      }
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
  }
}
