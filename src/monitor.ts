import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/core";
import { resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound";
import { vkPositiveSetting } from "./settings.js";
import { globalAgent } from "node:https";
import { PollingTransport, VK } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import { handleVkInbound, type VkTurnAdoptionLifecycle } from "./inbound.js";
import {
  extractVkInboundAttachments,
  resolveVkInboundReplyContext,
} from "./media.js";
import { redactVkId, vkDiag } from "./diagnostics.js";
import { getVkRuntime, readVkRuntimeConfig } from "./runtime.js";
import { createStallWatchdog } from "./stall-watchdog.js";
import { primeVkGroupId } from "./send.js";
import type { CoreConfig, VkInboundMessage } from "./types.js";

const FIRST_LONG_POLL_CHECK_TIMEOUT_MS = 35_000;
const FIRST_LONG_POLL_CHECK_ERROR = "VK Long Poll transport check failed";

/**
 * How long the transport may stay silent before we treat it as stalled.
 *
 * A long poll waits up to ~25 seconds for an event and then returns, so no
 * completed request for minutes is an anomaly rather than a quiet chat. The
 * gateway watches `lastTransportActivityAt` too, but with a half-hour default;
 * this only makes the same check faster.
 */
const TRANSPORT_SILENCE_MS = vkPositiveSetting({ env: "VK_TRANSPORT_SILENCE_MS", section: "transport", key: "silenceMs", fallback: 150_000 });

/**
 * Collapses a burst of inbound messages into one: texts joined by newlines,
 * identity taken from the last. Used by the debouncer when a person sends
 * several messages in a row.
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

/**
 * Uses the first real poll as the readiness check, then hands control back to
 * vk-io's normal retrying fetch loop. This avoids a second preflight consumer
 * and ensures updates returned by the readiness poll enter the normal
 * middleware pipeline.
 */
class ReadinessPollingTransport extends PollingTransport {
  private readinessSettled = false;
  private firstFetchController: AbortController | undefined;
  private activeFetch: Promise<void> | undefined;
  private readonly firstSuccessfulPoll: Promise<void>;
  private resolveFirstSuccessfulPoll!: () => void;
  private rejectFirstSuccessfulPoll!: (error: Error) => void;
  private readonly onSuccessfulPoll: () => void;

  constructor(
    options: ConstructorParameters<typeof PollingTransport>[0],
    onSuccessfulPoll: () => void,
  ) {
    super(options);
    this.onSuccessfulPoll = onSuccessfulPoll;
    this.firstSuccessfulPoll = new Promise<void>((resolve, reject) => {
      this.resolveFirstSuccessfulPoll = resolve;
      this.rejectFirstSuccessfulPoll = reject;
    });
    // The observer is attached after transport bootstrap succeeds. Keep an
    // immediate failed poll from becoming an unhandled rejection meanwhile.
    void this.firstSuccessfulPoll.catch(() => {});
  }

  waitForFirstSuccessfulPoll(timeoutMs = FIRST_LONG_POLL_CHECK_TIMEOUT_MS): Promise<void> {
    const timeout = setTimeout(() => {
      this.settleReadiness(new Error(FIRST_LONG_POLL_CHECK_ERROR));
      this.firstFetchController?.abort();
    }, timeoutMs);
    return this.firstSuccessfulPoll.finally(() => clearTimeout(timeout));
  }

  /** Settles the readiness promise once; `error` decides which way. */
  private settleReadiness(error?: Error): void {
    if (this.readinessSettled) {
      return;
    }
    this.readinessSettled = true;
    if (error) {
      this.rejectFirstSuccessfulPoll(error);
      return;
    }
    this.resolveFirstSuccessfulPoll();
  }

  private async fetchReadinessPoll(): Promise<void> {
    const controller = new AbortController();
    this.firstFetchController = controller;
    this.url.searchParams.set("ts", String(this.ts));
    this.url.searchParams.set("wait", "1");
    try {
      const response = await fetch(new URL(this.url), {
        method: "GET",
        signal: controller.signal,
        headers: { connection: "keep-alive" },
      });
      if (!response.ok) {
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      const result: unknown = await response.json();
      if (!result || typeof result !== "object") {
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      if ("failed" in result) {
        // `in` narrows to a record carrying `failed` only, so `ts` has to be
        // read off the payload explicitly rather than through the narrowed type.
        const failure = result as { failed?: unknown; ts?: unknown };
        if (
          failure.failed === 1
          && (typeof failure.ts === "string" || typeof failure.ts === "number")
        ) {
          this.ts = failure.ts;
          return;
        }
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      if (
        !("updates" in result)
        || !Array.isArray(result.updates)
        || !("ts" in result)
        || (typeof result.ts !== "string" && typeof result.ts !== "number")
      ) {
        throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
      }

      this.restarted = 0;
      this.ts = result.ts;
      if ("pts" in result && (typeof result.pts === "string" || typeof result.pts === "number")) {
        this.pts = Number(result.pts);
      }
      for (const update of result.updates) {
        this.pollingHandler(update as unknown[]);
      }
    } catch {
      // Fetch errors can include the Long Poll URL/key. Never surface them.
      throw new Error(FIRST_LONG_POLL_CHECK_ERROR);
    } finally {
      // Only the readiness check is shortened. Normal vk-io polling retains
      // its standard 25-second server wait after the first successful check.
      this.url.searchParams.set("wait", "25");
      if (this.firstFetchController === controller) {
        this.firstFetchController = undefined;
      }
    }
  }

  override async fetchUpdates(): Promise<void> {
    const isReadinessPoll = !this.readinessSettled;
    const activeFetch = isReadinessPoll ? this.fetchReadinessPoll() : super.fetchUpdates();
    this.activeFetch = activeFetch;
    try {
      await activeFetch;
      this.onSuccessfulPoll();
    } finally {
      if (this.activeFetch === activeFetch) {
        this.activeFetch = undefined;
      }
    }
  }

  override async stop(): Promise<void> {
    this.settleReadiness(new Error(FIRST_LONG_POLL_CHECK_ERROR));
    this.firstFetchController?.abort();
    await super.stop();
  }

  async stopAndDrain(): Promise<void> {
    const readinessFetch = this.readinessSettled ? undefined : this.activeFetch;
    await this.stop();
    // Drain only the abortable readiness request. After ready, preserve
    // vk-io's normal immediate stop semantics for its 25-second poll.
    await readinessFetch?.catch(() => {});
  }

  protected override async startFetchLoop(): Promise<void> {
    // vk-io recursively invokes this method after post-ready transport errors.
    // Only the initial invocation is a readiness probe; subsequent invocations
    // must retain vk-io's normal retry/restart behavior.
    if (this.readinessSettled) {
      await super.startFetchLoop();
      return;
    }

    try {
      await this.fetchUpdates();
      this.settleReadiness();
    } catch {
      this.settleReadiness(new Error(FIRST_LONG_POLL_CHECK_ERROR));
      return;
    }

    if (this.started) {
      await super.startFetchLoop();
    }
  }
}

export type VkMonitorOptions = {
  token: string;
  accountId: string;
  config: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
};

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

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Start monitoring VK community messages via Long Poll API.
 * Prefers Bots Long Poll when the token has the `manage` scope;
 * falls back to User Long Poll (messages.getLongPollServer) when only
 * the `messages` scope is available.
 */
export async function monitorVkProvider(opts: VkMonitorOptions): Promise<void> {
  const core = getVkRuntime();
  const account = resolveVkAccount({
    cfg: opts.config,
    accountId: opts.accountId,
  });

  const vk = new VK({ token: opts.token, apiLimit: 20 });
  // Our own stop signal: when the watchdog sees a stalled transport it ends the
  // account task, and the gateway brings the channel back with its own backoff.
  const localStop = new AbortController();
  const stopSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, localStop.signal])
    : localStop.signal;
  let stopRequested = false;
  let updatesStarted = false;
  let stopPromise: Promise<void> | undefined;
  let pollingTransport: ReadinessPollingTransport | undefined;
  let publishPollActivity = false;

  const stopUpdates = async (): Promise<void> => {
    stopRequested = true;
    if (!updatesStarted || !pollingTransport) {
      return;
    }
    if (!stopPromise) {
      stopPromise = pollingTransport.stopAndDrain().catch(() => {
        // ignore stop race/errors on shutdown
      });
    }
    await stopPromise;
  };

  // Ensure gateway stop triggers VK polling shutdown.
  opts.abortSignal?.addEventListener("abort", () => {
    void stopUpdates();
  }, { once: true });

  // Every other channel (telegram/whatsapp/feishu/…) funnels inbound through
  // the core debouncer; VK used to dispatch each message on its own. Two wins:
  //   1. a burst of quick messages becomes one coherent reply instead of N;
  //   2. per-key serialization means the core never dispatches two replies for
  //      the same conversation concurrently, which is exactly what triggers its
  //      reply-dispatch concurrency bugs.
  // The window comes from the core resolver, the same one every other channel
  // uses (`messages.inboundDebounceMs` plus per-channel overrides). VK used to
  // read a private env knob and so fell outside that path entirely; the knob
  // stays as an explicit override for a running gateway.
  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<VkInboundMessage>({
    debounceMs: resolveInboundDebounceMs({
      cfg: opts.config as OpenClawConfig,
      channel: "vk",
      overrideMs: parseStrictPositiveInteger(process.env.VK_INBOUND_DEBOUNCE_MS),
    }),
    serializeImmediate: true,
    buildKey: (msg) => `${account.accountId}:${msg.peerId}`,
    // Only merge plain-text messages; ones carrying attachments or a payload
    // flush on their own (immediately) but are still serialized per peer.
    shouldDebounce: (msg) =>
      msg.text.length > 0 &&
      (msg.attachments?.length ?? 0) === 0 &&
      msg.messagePayload === undefined,
    // The core hands a flush factory and expects `{ admission, completion }`
    // back: the lane frees on admission while completion is still running.
    // Returning a bare promise makes it fail on `flush.admission`, and the
    // message is lost silently — no handler call, nothing in the log.
    onFlush: (items, createFlush) => {
      vkDiag("inbound flush", { items: items.length });
      // The lifecycle goes down to the core: it frees this peer's lane the
      // moment the turn is adopted, not when the answer is finished. That is
      // what lets a follow-up sent mid-answer reach the core and be steered
      // into the running turn — natively, with no debounce window.
      const dispatch = async (lifecycle: VkTurnAdoptionLifecycle): Promise<void> => {
        vkDiag("inbound dispatch start", { items: items.length, stopped: stopRequested });
        if (stopRequested) {
          // Returning quietly here used to read as "the message vanished".
          opts.runtime.log?.("vk: dispatch skipped (monitor stopped)");
          return;
        }
        const message = combineVkInboundMessages(items);
        if (!message) {
          opts.runtime.log?.("vk: dispatch skipped (no message after combine)");
          return;
        }
        try {
          const currentCfg = readVkRuntimeConfig(core);
          const currentAccount = resolveVkAccount({
            cfg: currentCfg,
            accountId: account.accountId,
          });
          await handleVkInbound({
            message,
            account: currentAccount,
            config: currentCfg,
            runtime: opts.runtime,
            // A gateway stop must reach external send processes (ffmpeg).
            abortSignal: opts.abortSignal,
            turnAdoptionLifecycle: lifecycle,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          opts.runtime.error?.(
            `vk: message handler error for peerId=${redactVkId(message.peerId)}: ${errorMessage}`,
          );
        }
      };
      return createFlush({ dispatch });
    },
    onError: (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      opts.runtime.error?.(`vk: inbound debouncer error: ${errorMessage}`);
    },
  });

  // A probe on ALL updates: it shows whether events reach the plugin at all.
  // Without it "the channel is silent" is indistinguishable from "VK sends
  // nothing", and those are different faults.
  //
  // Installed unconditionally. The level is read per call everywhere else,
  // precisely so diagnostics can be switched on without restarting the gateway;
  // deciding it here once, at account start, made that half-true — the update
  // trace stayed missing until a restart. `vkDiag` returns immediately at `off`.
  {
    // vk-io types the middleware around its own Context, and its `next` resolves
    // to unknown rather than void — the probe only reads two optional fields, so
    // it is typed against that shape and handed over as vk-io expects.
    vk.updates.use((async (
      context: { type?: string; subTypes?: string[] },
      next: () => Promise<unknown>,
    ) => {
      vkDiag("update", {
        type: context?.type ?? "?",
        sub: (context?.subTypes ?? []).join(","),
      });
      await next();
    }) as Parameters<typeof vk.updates.use>[0]);
  }

  // Ingestion self-test (VK_SELFTEST=<peerId>): pushes a synthetic inbound
  // through the same debouncer live messages use. Needed because a broken
  // receive path cannot be reproduced from outside — only a human can send the
  // bot a message, and "channel running" proves nothing.
  const selftestPeer = Number(process.env.VK_SELFTEST ?? "");
  if (Number.isFinite(selftestPeer) && selftestPeer > 0) {
    setTimeout(() => {
      const probe: VkInboundMessage = {
        // The id must be a valid int32 AND exist in the conversation: VK puts
        // it into reply_to. A synthetic one only gets in the way, so take it
        // from VK_SELFTEST_MSGID, or send without a reply (0).
        messageId: process.env.VK_SELFTEST_MSGID ?? "0",
        peerId: selftestPeer,
        senderId: selftestPeer,
        text: process.env.VK_SELFTEST_TEXT ?? "channel self-test",
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

  // Register message handler
  vk.updates.on("message_new", async (context) => {
    // A probe at the very entrance: without it "the channel receives but does
    // not answer" is indistinguishable from "no event arrived at all", and
    // those are different faults with different fixes.
    vkDiag("inbound event", {
      // `messageId`, not `id`: identifier fields are redacted by name, and a
      // raw VK message id under the name `id` would reach the log unmasked.
      messageId: context.id,
      peerId: context.peerId,
      outbox: context.isOutbox,
      len: (context.text ?? "").length,
    });
    if (stopRequested) {
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
    opts.setStatus?.({ lastEventAt: Date.now() });

    // Hand off to the debouncer: it buffers a burst and serializes per peer,
    // then calls handleVkInbound once via onFlush, which owns error handling —
    // so one bad turn never breaks ingestion.
    try {
      await inboundDebouncer.enqueue(message);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      opts.runtime.error?.(
        `vk: inbound enqueue error for peerId=${redactVkId(peerId)}: ${errorMessage}`,
      );
    }
  });

  try {
    // Detect whether Bots LP is available; fall back to User LP otherwise
    const botsLp = await canUseBotsLongPoll(vk);
    if (stopRequested || opts.abortSignal?.aborted) {
      return;
    }
    if (botsLp.groupId !== undefined) {
      primeVkGroupId(opts.token, botsLp.groupId);
    }
    const useBotsLongPoll = botsLp.ok && botsLp.groupId !== undefined;
    // The only honest liveness signal is "a poll request came back". The cursor
    // is not one: it moves on EVENTS, so it sits still for hours on a quiet
    // channel; and `isStarted` stays true on a wedged transport.
    const stallWatchdog = createStallWatchdog({
      label: `vk:${opts.accountId} long-poll`,
      timeoutMs: TRANSPORT_SILENCE_MS,
      abortSignal: stopSignal,
      runtime: opts.runtime,
      onTimeout: ({ idleMs }) => {
        const silentSec = Math.round(idleMs / 1000);
        opts.setStatus?.(
          channelStoppedPatch({
            lastError: `no completed long-poll request for ${silentSec}s`,
            lastDisconnect: {
              at: Date.now(),
              error: `long poll silent for ${silentSec}s`,
            },
          }),
        );
        opts.runtime.log?.(
          `[${opts.accountId}] long poll silent for ${silentSec}s — handing restart to the gateway`,
        );
        localStop.abort();
      },
    });

    pollingTransport = new ReadinessPollingTransport(
      {
        api: vk.api,
        agent: globalAgent,
        pollingWait: 3_000,
        pollingRetryLimit: 3,
        ...(useBotsLongPoll ? { pollingGroupId: botsLp.groupId } : {}),
      },
      () => {
        stallWatchdog.touch();
        if (publishPollActivity) {
          opts.setStatus?.({ lastTransportActivityAt: Date.now() });
        }
      },
    );
    pollingTransport.subscribe((update) =>
      useBotsLongPoll
        ? vk.updates.handleWebhookUpdate(update as unknown as Record<string, unknown>)
        : vk.updates.handlePollingUpdate(update),
    );

    opts.runtime.log?.(
      useBotsLongPoll
        ? `[${opts.accountId}] using Bots Long Poll (group ${botsLp.groupId})`
        : `[${opts.accountId}] Bots Long Poll unavailable, falling back to User Long Poll`,
    );
    await pollingTransport.start();
    updatesStarted = true;

    // An abort may arrive while vk-io is awaiting its Long Poll server. Stop
    // the newly started transport before publishing a false-ready snapshot.
    if (stopRequested || opts.abortSignal?.aborted) {
      await stopUpdates();
      return;
    }

    try {
      await pollingTransport.waitForFirstSuccessfulPoll();
    } catch (error) {
      if (stopRequested || opts.abortSignal?.aborted) {
        return;
      }
      throw error;
    }

    if (stopRequested || opts.abortSignal?.aborted) {
      await stopUpdates();
      return;
    }

    const connectedAt = Date.now();
    publishPollActivity = true;
    opts.setStatus?.(
      channelReadyPatch({
        mode: "longpoll",
        lastConnectedAt: connectedAt,
        lastTransportActivityAt: connectedAt,
      }),
    );

    // Only arm once the transport is proven ready: before that, silence is
    // expected and would trip the watchdog on every start.
    stallWatchdog.arm(connectedAt);

    // Keep lifecycle alive until the gateway requests stop, or the watchdog
    // decides the transport is gone.
    await waitForAbort(stopSignal);
  } finally {
    await stopUpdates();
  }
}
