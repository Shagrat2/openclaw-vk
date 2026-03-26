import {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
} from "openclaw/plugin-sdk/channel-status";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { ChannelPlugin, ChannelStatusIssue, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  listVkAccountIds,
  resolveDefaultVkAccountId,
  resolveVkAccount,
  type ResolvedVkAccount,
} from "./accounts.js";
import { VkConfigSchema } from "./config-schema.js";
import { monitorVkProvider } from "./monitor.js";
import { probeVkBot } from "./probe.js";
import { getVkRuntime } from "./runtime.js";
import {
  applyVkAllowlistConfigEdit,
  isVkGroupPeerId,
  readVkAllowlistConfig,
  resolveVkDirectoryGroups,
  resolveVkDirectoryPeers,
  sendMessageVk,
  sendPayloadVk,
} from "./send.js";
import type { CoreConfig, VkConfig, VkProbe } from "./types.js";

const meta = {
  id: "vk",
  label: "VK",
  selectionLabel: "VK (VKontakte Bot)",
  detailLabel: "VK Bot",
  docsPath: "/channels/vk",
  docsLabel: "vk",
  blurb: "VK (VKontakte) community bot via Long Poll API.",
  systemImage: "message.fill",
};

const vkConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) =>
    resolveVkAccount({ cfg, accountId: accountId ?? undefined }),
  resolveAllowFrom: (account: ResolvedVkAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^vk:(?:user:)?/i, "")),
  resolveDefaultTo: (account: ResolvedVkAccount) => account.config.defaultTo,
});

const vkConfigBase = createScopedChannelConfigBase<ResolvedVkAccount, OpenClawConfig>({
  sectionKey: "vk",
  listAccountIds: (cfg) => listVkAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveVkAccount({ cfg, accountId: accountId ?? undefined }),
  defaultAccountId: (cfg) => resolveDefaultVkAccountId(cfg),
  clearBaseFields: ["tokenFile"],
});

const resolveVkDmPolicy = createScopedDmSecurityResolver<ResolvedVkAccount>({
  channelKey: "vk",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  approveHint: "openclaw pairing approve vk <code>",
  normalizeEntry: (raw) => raw.replace(/^vk:(?:user:)?/i, ""),
});

export const vkPlugin: ChannelPlugin<ResolvedVkAccount, VkProbe> = {
  id: "vk",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "vkUserId",
    normalizeAllowEntry: (entry) => {
      return entry.replace(/^vk:(?:user:)?/i, "");
    },
    notifyApproval: async ({ cfg, id }) => {
      await sendMessageVk(id, "OpenClaw: your access has been approved.", {
        cfg,
      });
    },
  },
  allowlist: {
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
    readConfig: ({ cfg, accountId }) =>
      readVkAllowlistConfig(resolveVkAccount({ cfg: cfg as CoreConfig, accountId })),
    applyConfigEdit: ({ cfg, parsedConfig, accountId, scope, action, entry }) =>
      applyVkAllowlistConfigEdit({
        cfg: cfg as CoreConfig,
        parsedConfig,
        accountId,
        scope,
        action,
        entry,
      }),
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.vk"] },
  configSchema: buildChannelConfigSchema(VkConfigSchema),
  config: {
    ...vkConfigBase,
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource ?? undefined,
    }),
    ...vkConfigAccessors,
  },
  security: {
    resolveDmPolicy: resolveVkDmPolicy,
    collectWarnings: ({ account, cfg }) => {
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent:
          (cfg.channels as Record<string, unknown> | undefined)?.vk !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        surface: "VK group chats",
        openScope: "any member in group chats",
        groupPolicyPath: "channels.vk.groupPolicy",
        groupAllowFromPath: "channels.vk.groupAllowFrom",
        mentionGated: false,
      });
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = resolveVkAccount({
        cfg,
        accountId: accountId ?? undefined,
      });
      const groups = account.config.groups;
      if (!groups || !groupId) {
        return false;
      }
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? false;
    },
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      const account = resolveVkAccount({
        cfg,
        accountId: accountId ?? undefined,
      });
      const groups = account.config.groups;
      if (!groups || !groupId) {
        return undefined;
      }
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.tools ?? undefined;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) {
        return undefined;
      }
      return trimmed.replace(/^vk:(?:user:|chat:)?/i, "");
    },
    parseExplicitTarget: ({ raw }) => {
      const normalized = raw.trim().replace(/^vk:(?:user:|chat:)?/i, "");
      if (!normalized) {
        return null;
      }
      const peerId = Number(normalized);
      if (Number.isNaN(peerId)) {
        return null;
      }
      return {
        to: normalized,
        chatType: isVkGroupPeerId(peerId) ? ("group" as const) : ("direct" as const),
      };
    },
    inferTargetChatType: ({ to }) => {
      const normalized = to.trim().replace(/^vk:(?:user:|chat:)?/i, "");
      const peerId = Number(normalized);
      if (Number.isNaN(peerId)) {
        return undefined;
      }
      return isVkGroupPeerId(peerId) ? ("group" as const) : ("direct" as const);
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        return /^\d+$/.test(trimmed) || /^vk:/i.test(trimmed);
      },
      hint: "<userId|peerId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async (params) =>
      resolveVkDirectoryPeers({
        account: resolveVkAccount({
          cfg: ((params?.cfg as CoreConfig | undefined) ?? {}) as CoreConfig,
          accountId: params?.accountId,
        }),
        query: params?.query,
        limit: params?.limit,
      }),
    listGroups: async (params) =>
      resolveVkDirectoryGroups({
        account: resolveVkAccount({
          cfg: ((params?.cfg as CoreConfig | undefined) ?? {}) as CoreConfig,
          accountId: params?.accountId,
        }),
        query: params?.query,
        limit: params?.limit,
      }),
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getVkRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4096,
    shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
    resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
      typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
    sendPayload: async ({ to, payload, accountId, cfg, mediaLocalRoots, replyToId, forceDocument }) => {
      const result = await sendPayloadVk(to, payload, {
        cfg,
        accountId: accountId ?? undefined,
        mediaLocalRoots,
        replyTo: replyToId ?? undefined,
        forceDocument: forceDocument ?? undefined,
      });
      return result
        ? { channel: "vk", ...result }
        : { channel: "vk", messageId: "", chatId: to };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const result =
        (await sendPayloadVk(
          to,
          {
            text,
            replyToId: replyToId ?? undefined,
          },
          {
            cfg,
            accountId: accountId ?? undefined,
          },
        )) ??
        (await sendMessageVk(to, text, {
          cfg,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        }));
      return { channel: "vk", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, forceDocument }) => {
      const result =
        (await sendPayloadVk(
          to,
          {
            text,
            mediaUrl,
            replyToId: replyToId ?? undefined,
          },
          {
            cfg,
            accountId: accountId ?? undefined,
            mediaLocalRoots,
            forceDocument: forceDocument ?? undefined,
          },
        )) ??
        (await sendMessageVk(to, text, {
          cfg,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        }));
      return { channel: "vk", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];
      for (const account of accounts) {
        const accountId = account.accountId ?? DEFAULT_ACCOUNT_ID;
        if (!account.configured) {
          issues.push({
            channel: "vk",
            accountId,
            kind: "config",
            message: "VK community access token not configured",
          });
        }
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    formatCapabilitiesProbe: ({ probe }) => {
      const lines: Array<{ text: string }> = [];
      if (probe?.ok) {
        if (probe.groupName) {
          const groupId = probe.groupId ? ` (${probe.groupId})` : "";
          lines.push({ text: `Group: ${probe.groupName}${groupId}` });
        }
        if (probe.screenName) {
          lines.push({ text: `Screen name: ${probe.screenName}` });
        }
      }
      return lines;
    },
    probeAccount: async ({ account, timeoutMs }) => probeVkBot(account.token, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.token?.trim());
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        runtime,
        probe,
      });
      return {
        ...base,
        tokenSource: account.tokenSource,
        mode: "longpoll",
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      if (!token) {
        throw new Error(
          `VK long poll mode requires a non-empty community access token for account "${account.accountId}".`,
        );
      }

      let vkBotLabel = "";
      try {
        const probe = await probeVkBot(token, 2500);
        const displayName = probe.ok ? probe.groupName?.trim() : null;
        if (displayName) {
          vkBotLabel = ` (${displayName})`;
        }
      } catch (err) {
        if (getVkRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] VK bot probe failed: ${String(err)}`);
        }
      }

      ctx.log?.info(`[${account.accountId}] starting VK provider${vkBotLabel}`);

      const monitor = await monitorVkProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg as CoreConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });

      return monitor;
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const vkConfig = ((cfg.channels as Record<string, unknown>)?.vk ?? {}) as VkConfig;
      const nextVk = { ...vkConfig };
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (nextVk.token || nextVk.tokenFile) {
          delete nextVk.token;
          delete nextVk.tokenFile;
          cleared = true;
          changed = true;
        }
      }

      if (accountId !== DEFAULT_ACCOUNT_ID && nextVk.accounts?.[accountId]) {
        const nextAccounts = { ...nextVk.accounts };
        delete nextAccounts[accountId];
        if (Object.keys(nextAccounts).length > 0) {
          nextVk.accounts = nextAccounts;
        } else {
          delete nextVk.accounts;
        }
        cleared = true;
        changed = true;
      }

      if (changed) {
        if (Object.keys(nextVk).length > 0) {
          (nextCfg.channels as Record<string, unknown>) = {
            ...nextCfg.channels,
            vk: nextVk,
          };
        } else {
          const nextChannels = {
            ...nextCfg.channels,
          } as Record<string, unknown>;
          delete nextChannels.vk;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await getVkRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = resolveVkAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";

      return {
        cleared,
        envToken: Boolean(process.env.VK_TOKEN?.trim()),
        loggedOut,
      };
    },
  },
};
