import {
  issuePairingChallengeCompat,
  loadChannelMessageBits,
  loadCoreBridge,
  type StreamingCompatEntry,
} from "./sdk-compat.js";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import {
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
} from "openclaw/plugin-sdk/channel-policy";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  GROUP_POLICY_BLOCKED_LABEL,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveVkButtonsFromPayload, resolveVkCommandFromPayload } from "./keyboard.js";
import {
  resolveVkInboundBodyText,
  resolveVkInboundResolvedMedia,
  resolveVkInboundResolvedMediaPaths,
  resolveVkInboundResolvedMediaTypes,
  resolveVkInboundResolvedMediaUrls,
  resolveVkInboundMediaTypes,
  resolveVkInboundMediaUrls,
} from "./media.js";
import { getVkRuntime } from "./runtime.js";
import {
  clearVkInstances,
  editMessageVk,
  markMessageReadVk,
  sendPayloadVk,
  sendTypingVk,
  sendMessageVk,
} from "./send.js";
import { renderVkMarkdownChunks } from "./format.js";
import { createVkStatusReactionController } from "./reactions-controller.js";
import { createVkProgressDraftCompositor,
  resolveVkProgressLabel,
} from "./progress-draft.js";
import type { VkProgressDraftHandle } from "./progress-draft.js";
import { DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import type { StatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import {
  buildChannelProgressDraftLineForEntry,
  resolveChannelPreviewStreamMode,
} from "openclaw/plugin-sdk/channel-message";
import type { ResolvedVkAccount } from "./types.js";
import type { CoreConfig, VkInboundMessage } from "./types.js";

const CHANNEL_ID = "vk" as const;

// VK group chats have peerId >= 2000000000
const VK_GROUP_CHAT_OFFSET = 2_000_000_000;

function isVkGroupChat(peerId: number): boolean {
  return peerId >= VK_GROUP_CHAT_OFFSET;
}

function normalizeVkAllowlist(allowFrom: Array<string | number> | undefined): string[] {
  if (!allowFrom) {
    return [];
  }
  return allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

function resolveVkAllowlistMatch(params: { allowFrom: string[]; senderId: number }): {
  allowed: boolean;
} {
  const senderStr = String(params.senderId);
  if (params.allowFrom.length === 0) {
    return { allowed: false };
  }
  if (params.allowFrom.includes("*")) {
    return { allowed: true };
  }
  return {
    allowed: params.allowFrom.some((entry) => entry === senderStr || entry === `vk:${senderStr}`),
  };
}

type VkDispatchPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  channelData?: Record<string, unknown>;
};

async function deliverVkReply(params: {
  payload: VkDispatchPayload;
  peerId: number;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
  clearKeyboard?: boolean;
  log?: (msg: string) => void;
}) {
  const result = await sendPayloadVk(String(params.peerId), params.payload, {
    accountId: params.accountId,
    clearKeyboard: params.clearKeyboard,
  });
  if (!result) {
    // Silent send failure: sendPayloadVk produced no result for a reply we meant
    // to deliver. The cached VK client for this account can wedge (a stale/broken
    // long-poll connection) and then EVERY send drops silently until the gateway
    // is restarted by hand. Clear the client cache so the next send recreates a
    // fresh client — auto-recovery instead of a manual restart.
    params.log?.(
      `vk: reply delivery produced no result for peer=${params.peerId}; clearing VK client cache to recover`,
    );
    clearVkInstances();
    return;
  }
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleVkInbound(params: {
  message: VkInboundMessage;
  account: ResolvedVkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getVkRuntime();
  // Значения тянем через компат-слой: ядро переносит эти символы между
  // версиями SDK, и статический импорт молча ломает загрузку плагина целиком.
  if (process.env.VK_INBOUND_TRACE === "1") {
    runtime.log?.("vk: handleVkInbound entered, loading sdk bits");
  }
  const { createReplyPrefixOptions, createTypingCallbacks, logTypingFailure } =
    await loadChannelMessageBits();
  const bridge = await loadCoreBridge(core);
  if (process.env.VK_INBOUND_TRACE === "1") {
    runtime.log?.("vk: sdk bits loaded");
  }
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const payloadCommand = resolveVkCommandFromPayload(message.messagePayload);
  const visibleBody = resolveVkInboundBodyText({
    text: message.text,
    attachments: message.attachments,
  });
  const rawBody = payloadCommand ?? visibleBody;
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = String(message.senderId);
  const isGroup = message.isGroup;
  const groupConfig = isGroup
    ? (account.config.groups?.[String(message.peerId)] ?? account.config.groups?.["*"])
    : undefined;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.vk !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "vk",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (msg) => runtime.log?.(msg),
  });

  const configAllowFrom = normalizeVkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeVkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeVkAllowlist(storeAllowFrom);

  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: storeAllowList,
    dmPolicy,
    groupAllowFromFallbackToAllowFrom: false,
  });
  const groupAllowOverride =
    groupConfig && Object.hasOwn(groupConfig, "allowFrom")
      ? normalizeVkAllowlist(groupConfig.allowFrom)
      : undefined;
  const effectiveGroupSenderAllowFrom = groupAllowOverride ?? effectiveGroupAllowFrom;

  // Group access check
  if (isGroup) {
    if (groupConfig?.enabled === false) {
      runtime.log?.(`vk: drop group peerId=${message.peerId} (group disabled by config)`);
      return;
    }
    if (groupPolicy === "disabled") {
      runtime.log?.(`vk: drop group peerId=${message.peerId} (groupPolicy=${groupPolicy})`);
      return;
    }
  }

  // Sender authorization
  if (isGroup) {
    if (groupPolicy === "allowlist") {
      const senderAllowed = resolveVkAllowlistMatch({
        allowFrom: effectiveGroupSenderAllowFrom,
        senderId: message.senderId,
      });
      if (!senderAllowed.allowed) {
        runtime.log?.(`vk: drop group sender ${senderDisplay} (groupPolicy=allowlist)`);
        return;
      }
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`vk: drop DM sender=${senderDisplay} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveVkAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        senderId: message.senderId,
      });
      if (!dmAllowed.allowed) {
        if (dmPolicy === "pairing") {
          // 8.1 убрала issuePairingChallenge из публичного SDK: тот же вызов
          // теперь идёт через контроллер. На старом ядре контроллер метода не
          // имеет — компат-слой откатывается на прямой вызов.
          await issuePairingChallengeCompat({
            controller: pairing,
            channel: CHANNEL_ID,
            upsertPairingRequest: pairing.upsertPairingRequest,
            challenge: {
            senderId: senderDisplay,
            senderIdLine: `Your VK user id: ${senderDisplay}`,
            meta: {},
            sendPairingReply: async (text) => {
              await deliverVkReply({
                payload: { text },
                peerId: message.senderId,
                accountId: account.accountId,
                statusSink,
                log: runtime.log,
              });
            },
            onReplyError: (err) => {
              runtime.error?.(`vk: pairing reply failed for ${senderDisplay}: ${String(err)}`);
            },
            },
          });
        }
        runtime.log?.(`vk: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  // Command gating
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = (config as Record<string, unknown>).commands
    ? ((config as Record<string, Record<string, unknown>>).commands.useAccessGroups as
        | boolean
        | undefined) !== false
    : true;
  const senderAllowedForCommands = resolveVkAllowlistMatch({
    allowFrom: isGroup ? effectiveGroupSenderAllowFrom : effectiveAllowFrom,
    senderId: message.senderId,
  }).allowed;
  const hasControlCommand = bridge.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: (isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderDisplay,
    });
    return;
  }

  // Mention check for group chats
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);
  const requireMention = isGroup ? (groupConfig?.requireMention ?? false) : false;

  if (isGroup && requireMention && !wasMentioned && !hasControlCommand) {
    runtime.log?.(`vk: drop group peerId=${message.peerId} (mention required)`);
    return;
  }

  if (process.env.VK_INBOUND_TRACE === "1") {
    runtime.log?.(`vk: inbound passed gates, routing peer=${message.peerId}`);
  }

  // Build route and dispatch
  const peerId = String(message.peerId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = isGroup ? `vk:chat:${message.peerId}` : `vk:${message.senderId}`;
  const storePath = bridge.resolveStorePath(
    (config as Record<string, Record<string, unknown>>).session?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = bridge.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = bridge.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = bridge.formatAgentEnvelope({
    channel: "VK",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupConfig?.systemPrompt?.trim() || undefined;
  const resolvedMedia = await resolveVkInboundResolvedMedia({
    attachments: message.attachments,
    mediaRuntime: core.channel.media,
    logError: (line) => runtime.log?.(line),
  });
  const mediaPaths = resolveVkInboundResolvedMediaPaths(resolvedMedia);
  const downloadedMediaUrls = resolveVkInboundResolvedMediaUrls(resolvedMedia);
  const downloadedMediaTypes = resolveVkInboundResolvedMediaTypes(resolvedMedia);
  const mediaUrls =
    mediaPaths.length > 0 ? downloadedMediaUrls : resolveVkInboundMediaUrls(message.attachments);
  const mediaTypes =
    mediaPaths.length > 0 ? downloadedMediaTypes : resolveVkInboundMediaTypes(message.attachments);

  const ctxPayload = bridge.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: visibleBody || rawBody,
    CommandBody: rawBody,
    From: fromLabel,
    To: `vk:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: undefined,
    SenderId: senderDisplay,
    GroupSubject: isGroup ? `vk:chat:${message.peerId}` : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `vk:${peerId}`,
    CommandAuthorized: commandGate.commandAuthorized,
    MediaPath: mediaPaths[0],
    MediaUrl: mediaUrls[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    ReplyToId: message.replyToMessageId,
    ReplyToIdFull: message.replyToMessageId,
    ReplyToBody: message.replyToText,
  });

  const onDispatchError = (err: unknown, info: { kind: string }) => {
    runtime.error?.(`vk ${info.kind} reply failed: ${String(err)}`);
  };
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      await sendTypingVk(String(message.peerId), account);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        target: String(message.peerId),
        error: err,
      });
    },
  });
  let typingStarted = false;
  const startTypingOnce = async () => {
    if (typingStarted) {
      return;
    }
    typingStarted = true;
    await typingCallbacks.onReplyStart();
  };
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await bridge.recordInboundSession({
    storePath,
    ctx: ctxPayload,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    onRecordError: (err) => {
      runtime.error?.(`vk: failed updating session meta: ${String(err)}`);
    },
  });

  try {
    await markMessageReadVk(String(message.peerId), message.messageId, account);
  } catch (err) {
    runtime.log?.(
      `vk: mark read failed for peerId=${message.peerId} messageId=${message.messageId}: ${String(err)}`,
    );
  }

  const cfgRecord = config as Record<string, Record<string, unknown>>;
  const ackReactionScope =
    (cfgRecord.messages?.ackReactionScope as
      | "all"
      | "direct"
      | "group-all"
      | "group-mentions"
      | "off"
      | "none"
      | undefined) ?? undefined;
  const statusReactionsCfg = cfgRecord.messages?.statusReactions as
    | { enabled?: boolean; emojis?: Record<string, string>; timing?: Record<string, number> }
    | undefined;
  const statusReactionsEnabled =
    statusReactionsCfg?.enabled === true &&
    typeof message.conversationMessageId === "number" &&
    core.channel.reactions.shouldAckReaction({
      scope: ackReactionScope,
      isDirect: !isGroup,
      isGroup,
      isMentionableGroup: isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention: true,
      effectiveWasMentioned: isGroup ? wasMentioned : false,
    });
  const removeAckAfterReply =
    (cfgRecord.messages?.removeAckAfterReply as boolean | undefined) ?? false;

  // ── Step-progress draft (opt-in via channels.vk.streaming.mode:"progress") ──
  // Shows the live list of execution steps (🛠️ tool calls, 🔎 web search …) in
  // ONE message edited in place, mirroring Telegram's "progress" stream. It is
  // INDEPENDENT of status reactions — both can run together (as Telegram does):
  // the reaction tracks the coarse state on the user's message, the draft shows
  // the steps. Each progress callback below fans out to whichever is enabled.
  const vkStreamingEntry = cfgRecord.channels?.vk as StreamingCompatEntry | undefined;
  const progressStreamMode = resolveChannelPreviewStreamMode(vkStreamingEntry, "off");
  const progressDraftEnabled =
    progressStreamMode === "progress" &&
    typeof message.conversationMessageId === "number";

  let statusReactions: StatusReactionController | null = null;
  if (statusReactionsEnabled && typeof message.conversationMessageId === "number") {
    statusReactions = createVkStatusReactionController({
      peerId: message.peerId,
      cmid: message.conversationMessageId,
      account,
      emojiOverrides: statusReactionsCfg?.emojis,
      timing: statusReactionsCfg?.timing,
      onError: (err) => {
        runtime.log?.(`vk: status-reaction error for cmid=${message.conversationMessageId}: ${String(err)}`);
      },
    });
    void statusReactions.setQueued();
  }

  let progressDraft: VkProgressDraftHandle | null = null;
  if (progressDraftEnabled) {
    progressDraft = createVkProgressDraftCompositor({
      to: String(message.peerId),
      account,
      accountId: account.accountId,
      cfg: config as CoreConfig,
      entry: vkStreamingEntry,
      mode: progressStreamMode,
      seed: String(message.conversationMessageId),
      log: runtime.log,
      onError: (err) => {
        runtime.log?.(
          `vk: progress-draft error for cmid=${message.conversationMessageId}: ${String(err)}`,
        );
      },
    });
    runtime.log?.(
      `vk: step-progress draft enabled (mode=${progressStreamMode}) cmid=${message.conversationMessageId}`,
    );
  }

  await startTypingOnce();

  let dispatchError = false;
  // Defensive guard mirroring the bundled channels' isProcessAborted() check
  // (see core message-handler.process / telegram bot). VK has no abortSignal in
  // this scope, so we use a local "settled" flag: once the turn finalizes
  // (setDone/setError in finally), late-arriving progress callbacks become
  // no-ops. The SDK controller already guards on `finished`, so this is
  // belt-and-suspenders — but it keeps intent explicit and avoids redundant
  // setReaction churn after the turn is done.
  let turnSettled = false;
  try {
    if (process.env.VK_INBOUND_TRACE === "1") {
      runtime.log?.(`vk: dispatching to core peer=${message.peerId}`);
    }
    await bridge.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config as OpenClawConfig,
      dispatcherOptions: {
        ...prefixOptions,
        onReplyStart: async () => {
          await startTypingOnce();
          if (statusReactions) await statusReactions.setThinking();
          // NB: the step draft is intentionally NOT seeded here. Telegram seeds
          // its draft only from real tool/reasoning events, so a text-only turn
          // never spawns an empty placeholder message. We do the same — the draft
          // is created lazily on the first onToolStart below.
        },
        typingCallbacks,
        deliver: async (payload: unknown, info?: { kind?: string }) => {
          // Отладка потока доставки (VK_DELIVER_TRACE=1): показывает, какие
          // куски ядро отдаёт по ходу хода и что приходит финалом. Нужна,
          // чтобы понять, можно ли показывать рассказ в черновике, а в финале
          // оставлять только итог.
          if (process.env.VK_DELIVER_TRACE === "1") {
            const p = payload as { text?: string; mediaUrl?: string } | null;
            const t = (p?.text ?? "").replace(/\s+/g, " ");
            runtime.log?.(
              `vk: deliver kind=${info?.kind ?? "?"} len=${t.length} media=${Boolean(p?.mediaUrl)} head=${JSON.stringify(t.slice(0, 70))}`,
            );
          }
          const normalized =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as VkDispatchPayload)
              : {};
          const resolvedButtons = resolveVkButtonsFromPayload(normalized);
          const isFinal = info?.kind === "final";
          let draftHandled = false;

          // ── Промежуточный блок → в черновик, а не отдельным сообщением ────
          // С включённым блочным стримингом ядро отдаёт рассказ о работе
          // кусками (kind=block), а итог — отдельно (kind=final). Раньше
          // каждый кусок уходил своим сообщением, и в чате росла простыня.
          // Теперь кусок переписывает черновик: ход виден в одном пузыре и
          // сменяется по мере работы, а в конце этот же пузырь становится
          // ответом. Медиа и кнопки идут прежним путём — их в черновик не
          // положишь.
          if (
            progressDraft &&
            !isFinal &&
            normalized.text?.trim() &&
            !normalized.mediaUrl &&
            !(normalized.mediaUrls?.length ?? 0) &&
            !resolvedButtons
          ) {
            const chunks = renderVkMarkdownChunks(normalized.text);
            // Метку добавляет сам черновик (единственная точка записи).
            const draftText = chunks[0]?.text ?? normalized.text;
            try {
              await progressDraft.overwrite(draftText);
              if (process.env.VK_INBOUND_TRACE === "1") {
                runtime.log?.(
                  `vk: block → draft len=${draftText.length}`,
                );
              }
              return;
            } catch (err) {
              runtime.log?.(`vk: block → draft failed: ${String(err)}`);
              // не смогли переписать черновик — пусть уходит обычным путём
            }
          }

          // ── Промежуточный блок С МЕДИА → своим сообщением, но с меткой ────
          // Картинку в черновик не положишь: это одно текстовое сообщение,
          // которое мы правим через messages.edit, вложение туда не подставить.
          // Убирать подпись в черновик тоже нельзя — она относится к самому
          // снимку и читается вместе с ним. Поэтому помечаем такие сообщения
          // той же меткой, что и черновик: тогда ход отличим от ответа, даже
          // когда ход состоит из картинок.
          if (progressDraft && !isFinal && normalized.text?.trim()) {
            const label = resolveVkProgressLabel(config);
            if (label && !normalized.text.startsWith(label)) {
              normalized.text = `${label} ${normalized.text}`;
            }
          }

          // ── Edit-in-place finalize (Telegram-style single bubble) ──────────
          // When a step draft is live and the final answer is a plain text reply
          // (no media, no buttons, fits one VK message), edit the draft message
          // INTO the answer instead of dropping it and sending a new one. Any
          // richer answer falls through to the normal, proven delivery path so
          // media / buttons / long multi-chunk replies keep full fidelity.
          if (progressDraft && isFinal) {
            const draftMsgId = progressDraft.currentMessageId();
            const hasMedia =
              Boolean(normalized.mediaUrl) || (normalized.mediaUrls?.length ?? 0) > 0;
            const finalText = normalized.text?.trim();
            // Медиа больше не отменяет замену: черновик с ходом работы
            // переписываем текстом ответа, а голосовые уходят следом
            // отдельными сообщениями. Раньше любой озвученный ответ шёл мимо
            // замены — черновик просто удалялся, и ход работы пропадал, а
            // ответ приходил новым сообщением.
            if (draftMsgId !== undefined && finalText && !resolvedButtons) {
              const chunks = renderVkMarkdownChunks(normalized.text ?? "");
              // Раньше замена работала только для ответа в одно сообщение, и
              // длинный вывод («ход мыслей» + итог) вместо замены оставлял
              // черновик простынёй, а ответ приходил отдельно. Теперь первым
              // куском переписываем черновик, остальные дописываем следом —
              // пузырь один и тот же, хвост идёт продолжением.
              if (chunks.length >= 1) {
                progressDraft.compositor.markFinalReplyStarted();
                let edited = false;
                try {
                  edited = await editMessageVk(
                    String(message.peerId),
                    draftMsgId,
                    chunks[0].text,
                    account,
                    { formatData: chunks[0].formatData },
                  );
                } catch (err) {
                  runtime.log?.(`vk: step-progress edit-into-final failed: ${String(err)}`);
                }
                progressDraft.compositor.markFinalReplyDelivered();
                progressDraft.close();
                if (edited) {
                  runtime.log?.(
                    `vk: step-progress draft edited INTO final msgId=${draftMsgId} len=${chunks[0].text.length} chunks=${chunks.length}`,
                  );
                  // Хвост длинного ответа досылаем обычными сообщениями: VK не
                  // умеет держать больше ~4096 символов в одном пузыре.
                  for (const chunk of chunks.slice(1)) {
                    try {
                      await sendMessageVk(String(message.peerId), chunk.text, {
                        accountId: account.accountId,
                      });
                    } catch (err) {
                      runtime.error?.(
                        `vk: step-progress tail chunk failed: ${String(err)}`,
                      );
                    }
                  }
                  // Голосовые — последними и без текста: текст уже в
                  // заменённом черновике, дублировать его подписью незачем.
                  if (hasMedia) {
                    const mediaList = normalized.mediaUrls?.length
                      ? normalized.mediaUrls
                      : normalized.mediaUrl
                        ? [normalized.mediaUrl]
                        : [];
                    for (const media of mediaList) {
                      try {
                        await deliverVkReply({
                          payload: { ...normalized, text: "", mediaUrl: media, mediaUrls: undefined },
                          peerId: message.peerId,
                          accountId: account.accountId,
                          statusSink,
                          log: runtime.log,
                        });
                      } catch (err) {
                        runtime.error?.(`vk: step-progress voice tail failed: ${String(err)}`);
                      }
                    }
                  }
                  statusSink?.({ lastOutboundAt: Date.now() });
                  return;
                }
                // Edit failed — drop the draft and deliver the answer normally so
                // the reply is never lost.
                await progressDraft.remove();
                draftHandled = true;
              }
            }
            if (!draftHandled) {
              // Stop the step draft before the answer lands so it can't race it.
              progressDraft.compositor.markFinalReplyStarted();
            }
          }
          await deliverVkReply({
            payload: normalized,
            peerId: message.peerId,
            accountId: account.accountId,
            statusSink,
            log: runtime.log,
            clearKeyboard:
              payloadCommand && info?.kind === "final" && !resolvedButtons ? true : undefined,
          });
          if (progressDraft && isFinal && !draftHandled) {
            progressDraft.compositor.markFinalReplyDelivered();
            progressDraft.close();
            await progressDraft.remove();
          }
        },
        onError: onDispatchError,
      },
      replyOptions: {
        onModelSelected,
        // Reactions and the step draft are independent surfaces — fan each
        // progress event out to whichever is enabled (both, when both are on).
        ...(progressDraft || statusReactions
          ? {
              // Without these, the core gates onToolStart/onCompactionStart
              // behind tool-summary visibility (requiresToolSummaryVisibility),
              // so neither the 👌/🙏 reactions nor the step draft fire in DMs
              // even though onReasoningStream (🤔) does. These flags enable the
              // "quiet direct native progress" path: the callbacks run without
              // emitting default tool-progress text messages.
              suppressDefaultToolProgressMessages: true,
              allowProgressCallbacksWhenSourceDeliverySuppressed: true,
              onReasoningStream: async () => {
                if (turnSettled) return;
                // Reasoning drives only the reaction (🤔). The step draft shows
                // execution steps, not reasoning (thinking is off), so it is fed
                // exclusively from onToolStart below — mirroring Telegram, which
                // never seeds the draft from reply-start/reasoning.
                if (statusReactions) await statusReactions.setThinking();
              },
              onToolStart: async (payload: {
                name?: string;
                phase?: string;
                args?: Record<string, unknown>;
                itemId?: string;
                toolCallId?: string;
              }) => {
                if (turnSettled) return;
                const toolName = payload?.name?.trim();
                if (statusReactions) await statusReactions.setTool(toolName);
                if (progressDraft) {
                  runtime.log?.(
                    `vk: step-progress tool name=${toolName ?? "?"} phase=${payload?.phase ?? "?"} cmid=${message.conversationMessageId}`,
                  );
                  // Build the full draft line (like Telegram). Passing undefined
                  // leaves the compositor with nothing to render; startImmediately
                  // shows the step at once instead of waiting out the start gate.
                  await progressDraft.compositor.pushToolProgress(
                    buildChannelProgressDraftLineForEntry(vkStreamingEntry, {
                      event: "tool",
                      itemId: payload?.itemId,
                      toolCallId: payload?.toolCallId,
                      name: toolName,
                      phase: payload?.phase,
                      args: payload?.args,
                    }),
                    { toolName, startImmediately: true },
                  );
                }
              },
              onCompactionStart: async () => {
                if (turnSettled) return;
                if (statusReactions) await statusReactions.setCompacting();
              },
              onCompactionEnd: async () => {
                if (turnSettled) return;
                if (statusReactions) {
                  statusReactions.cancelPending();
                  await statusReactions.setThinking();
                }
              },
            }
          : {}),
      },
    });
  } catch (err) {
    dispatchError = true;
    throw err;
  } finally {
    turnSettled = true;
    if (progressDraft) {
      try {
        progressDraft.compositor.cancel();
        progressDraft.close();
        // On a failed turn no final deliver ran, so drop the dangling step draft.
        if (dispatchError) {
          await progressDraft.remove();
        }
      } catch (err) {
        runtime.log?.(`vk: progress-draft finalize failed: ${String(err)}`);
      }
    }
    if (statusReactions) {
      try {
        if (dispatchError) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
      } catch (err) {
        runtime.log?.(`vk: status-reaction finalize failed: ${String(err)}`);
      }
      if (removeAckAfterReply) {
        const holdMs = dispatchError
          ? DEFAULT_TIMING.errorHoldMs
          : DEFAULT_TIMING.doneHoldMs;
        void (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
          try {
            await statusReactions!.clear();
          } catch (err) {
            runtime.log?.(`vk: status-reaction clear failed: ${String(err)}`);
          }
        })();
      }
      // NB: we intentionally do NOT call statusReactions.restoreInitial()
      // here. The Discord/bundled flow uses restoreInitial after setDone
      // to peel away intermediate reactions on platforms that support a
      // stack of reactions. VK lets the bot keep at most one reaction
      // per message, so setDone/setError already *replaced* the previous
      // emoji — calling restoreInitial would just overwrite the final
      // state with the initial "queued" emoji again (👍 instead of 🎉).
    }
  }
}
