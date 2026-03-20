import {
  createScopedPairingAccess,
  issuePairingChallenge,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveControlCommandGate,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveEffectiveAllowFromLists,
  GROUP_POLICY_BLOCKED_LABEL,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/compat";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk/channel-runtime";
import { resolveVkCommandFromPayload } from "./keyboard.js";
import { getVkRuntime } from "./runtime.js";
import { sendPayloadVk, sendTypingVk } from "./send.js";
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
}) {
  const result = await sendPayloadVk(String(params.peerId), params.payload, {
    accountId: params.accountId,
  });
  if (!result) {
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
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = resolveVkCommandFromPayload(message.messagePayload) ?? message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = String(message.senderId);
  const isGroup = message.isGroup;

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

  // Group access check
  if (isGroup) {
    if (groupPolicy === "disabled") {
      runtime.log?.(`vk: drop group peerId=${message.peerId} (groupPolicy=${groupPolicy})`);
      return;
    }
  }

  // Sender authorization
  if (isGroup) {
    if (groupPolicy === "allowlist") {
      const senderAllowed = resolveVkAllowlistMatch({
        allowFrom: effectiveGroupAllowFrom,
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
          await issuePairingChallenge({
            channel: CHANNEL_ID,
            senderId: senderDisplay,
            senderIdLine: `Your VK user id: ${senderDisplay}`,
            meta: {},
            upsertPairingRequest: pairing.upsertPairingRequest,
            sendPairingReply: async (text) => {
              await deliverVkReply({
                payload: { text },
                peerId: message.senderId,
                accountId: account.accountId,
                statusSink,
              });
            },
            onReplyError: (err) => {
              runtime.error?.(`vk: pairing reply failed for ${senderDisplay}: ${String(err)}`);
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
    allowFrom: isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    senderId: message.senderId,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
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

  const groupConfig = isGroup
    ? (account.config.groups?.[String(message.peerId)] ?? account.config.groups?.["*"])
    : undefined;
  const requireMention = isGroup ? (groupConfig?.requireMention ?? false) : false;

  if (isGroup && requireMention && !wasMentioned && !hasControlCommand) {
    runtime.log?.(`vk: drop group peerId=${message.peerId} (mention required)`);
    return;
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
  const storePath = core.channel.session.resolveStorePath(
    (config as Record<string, Record<string, unknown>>).session?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "VK",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
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
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    ctxPayload,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    onRecordError: (err) => {
      runtime.error?.(`vk: failed updating session meta: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      typingCallbacks,
      deliver: async (payload: unknown) => {
        const normalized =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as VkDispatchPayload)
            : {};
        await deliverVkReply({
          payload: normalized,
          peerId: message.peerId,
          accountId: account.accountId,
          statusSink,
        });
      },
      onError: onDispatchError,
    },
    replyOptions: {
      onModelSelected,
    },
  });
}
