import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { VK } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import { handleVkInbound } from "./inbound.js";
import {
  extractVkInboundAttachments,
  resolveVkInboundReplyContext,
} from "./media.js";
import { getVkRuntime } from "./runtime.js";
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
};

// ── Long-poll watchdog tunables (env-overridable) ──────────────────────────
// vk-io's polling has internal retry but it is SILENT (debug-only) and can get
// wedged so that the long-poll request stops delivering updates while the API
// itself stays healthy — which manifests as "VK goes silent until the gateway
// is restarted" (commonly right after a gateway restart). The watchdog below
// supervises the poller via vk-io's internal `ts` cursor — it advances on EVERY
// long-poll cycle (~every 25s) even when no one is messaging, so a frozen `ts`
// is an unambiguous "poller is dead" signal that does NOT false-positive during
// legitimate idle. When dead, the poller is recreated in-place (no gateway
// restart), with a logged reason and backoff.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
// How often to inspect the poller heartbeat.
const WATCHDOG_INTERVAL_MS = envInt("VK_LP_WATCHDOG_INTERVAL_MS", 30_000);
// Restart if the `ts` cursor has not advanced for this long (≈3× the 25s
// long-poll wait) — that means no poll cycle has completed.
const TS_STALE_MS = envInt("VK_LP_TS_STALE_MS", 80_000);
// Fallback only (when the `ts` cursor can't be read): probe the API after this
// much idle, and restart after this many consecutive probe failures.
const IDLE_BEFORE_PROBE_MS = envInt("VK_LP_IDLE_PROBE_MS", 90_000);
const PROBE_FAIL_LIMIT = envInt("VK_LP_PROBE_FAIL_LIMIT", 3);
// Inbound debounce window (opt-in, default OFF). When > 0, same-conversation
// messages arriving within this window are buffered and flushed as one combined
// inbound (coalesced reply). 0 = no batching, just per-peer serialization — the
// safe default: avoids the concurrent-dispatch deadlock without adding latency.
// Set VK_INBOUND_DEBOUNCE_MS>0 to enable coalescing (best paired with a core that
// has the reply-session reentrancy fix, so the flush after a turn can't hit
// #98562). ~1000-2000ms is a reasonable window for catching a quick follow-up.
const INBOUND_DEBOUNCE_MS = envInt("VK_INBOUND_DEBOUNCE_MS", 0);
const RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

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
 * Read vk-io's internal long-poll cursor (`ts`). It is bumped after every
 * completed long-poll request (including empty ones), so it is a reliable
 * liveness heartbeat. Returns undefined when the field is not accessible
 * (e.g. webhook mode or a vk-io version that renames it).
 */
function readPollingTs(vk: VK): number | undefined {
  const transport = (vk.updates as unknown as { pollingTransport?: { ts?: unknown } })
    ?.pollingTransport;
  const ts = transport?.ts;
  return typeof ts === "number" ? ts : undefined;
}

/**
 * Fallback liveness probe (used only when the `ts` cursor is unreadable):
 * confirms the token can still reach VK. Uses groups.getById, which does NOT
 * touch the active long-poll key.
 */
async function probeTokenAlive(vk: VK): Promise<boolean> {
  try {
    await vk.api.groups.getById({});
    return true;
  } catch {
    return false;
  }
}

/** Resolve after `ms`, or immediately when the abort signal fires. */
function interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

  let restartAttempt = 0;

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
      serializeImmediate: process.env.VK_SERIALIZE_INBOUND === "true",
      buildKey: (msg) => `${account.accountId}:${msg.peerId}`,
      // Only merge plain-text messages; ones carrying attachments or a payload
      // flush on their own (immediately) but are still serialized per peer.
      shouldDebounce: (msg) =>
        msg.text.length > 0 &&
        (msg.attachments?.length ?? 0) === 0 &&
        msg.messagePayload === undefined,
      onFlush: async (items) => {
        if (stopped) {
          return;
        }
        const message = combineVkInboundMessages(items);
        if (!message) {
          return;
        }
        try {
          const currentCfg = core.config.loadConfig() as CoreConfig;
          const currentAccount = resolveVkAccount({
            cfg: currentCfg,
            accountId: account.accountId,
          });
          await handleVkInbound({
            message,
            account: currentAccount,
            config: currentCfg,
            runtime: opts.runtime,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          opts.runtime.error?.(
            `vk: message handler error for peerId=${message.peerId}: ${errorMessage}`,
          );
        }
      },
      onError: (err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        opts.runtime.error?.(`vk: inbound debouncer error: ${errorMessage}`);
      },
    });

  try {
    while (!stopped) {
      const vk = new VK({ token: opts.token, apiLimit: 20 });
      let needRestart = false;
      let restartReason = "";

      const requestRestart = (reason: string) => {
        if (needRestart) return;
        needRestart = true;
        restartReason = reason;
      };

      vk.updates.on("message_new", async (context) => {
        if (stopped || needRestart) {
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
            `vk: inbound enqueue error for peerId=${peerId}: ${errorMessage}`,
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

        // Poller started successfully — reset backoff.
        restartAttempt = 0;

        // ── Watchdog loop (heartbeat via vk-io `ts` cursor) ─────────────
        let lastTs = readPollingTs(vk);
        let lastBeatAt = Date.now();
        let probeFailures = 0;
        while (!stopped && !needRestart) {
          await interruptibleDelay(WATCHDOG_INTERVAL_MS, opts.abortSignal);
          if (stopped || needRestart) break;

          // The polling transport stopped entirely.
          if (!vk.updates.isStarted) {
            requestRestart("polling transport stopped (isStarted=false)");
            break;
          }

          const ts = readPollingTs(vk);
          if (ts !== undefined) {
            // Primary signal: the long-poll cursor must keep advancing.
            if (ts !== lastTs) {
              lastTs = ts;
              lastBeatAt = Date.now();
              probeFailures = 0;
            } else if (Date.now() - lastBeatAt >= TS_STALE_MS) {
              requestRestart(
                `long-poll heartbeat frozen for ${Math.round((Date.now() - lastBeatAt) / 1000)}s (ts=${ts})`,
              );
              break;
            }
          } else {
            // Fallback: ts unreadable — probe the token after a long idle.
            if (Date.now() - lastBeatAt >= IDLE_BEFORE_PROBE_MS) {
              const alive = await probeTokenAlive(vk);
              lastBeatAt = Date.now();
              if (alive) {
                probeFailures = 0;
              } else {
                probeFailures += 1;
                opts.runtime.log?.(
                  `${tag} VK token probe failed (${probeFailures}/${PROBE_FAIL_LIMIT})`,
                );
                if (probeFailures >= PROBE_FAIL_LIMIT) {
                  requestRestart("VK token unreachable");
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        requestRestart(`poller error: ${msg}`);
      } finally {
        await stopVk();
      }

      if (stopped) {
        break;
      }

      // Backoff before recreating the poller.
      const backoff =
        RESTART_BACKOFF_MS[Math.min(restartAttempt, RESTART_BACKOFF_MS.length - 1)];
      restartAttempt += 1;
      opts.runtime.log?.(
        `${tag} VK long-poll restarting in ${Math.round(backoff / 1000)}s — ${restartReason || "unknown reason"}`,
      );
      await interruptibleDelay(backoff, opts.abortSignal);
    }
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
  }
}
