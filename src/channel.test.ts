import { beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks (must be before channel.ts import) ─────────────────────────────

vi.mock("openclaw/plugin-sdk/compat", () => ({
  createScopedAccountConfigAccessors: ({ resolveAllowFrom, formatAllowFrom }: Record<string, unknown>) => ({
    resolveAllowFrom,
    formatAllowFrom,
  }),
  createScopedChannelConfigBase: ({ listAccountIds, resolveAccount, defaultAccountId }: Record<string, unknown>) => ({
    listAccountIds,
    resolveAccount,
    defaultAccountId,
  }),
  createScopedDmSecurityResolver: () => vi.fn(),
  collectAllowlistProviderRestrictSendersWarnings: vi.fn().mockReturnValue([]),
  buildChannelConfigSchema: (schema: unknown) => schema,
  buildComputedAccountStatusSnapshot: vi.fn(
    (params: Record<string, unknown>) => ({ ...params }),
  ),
  buildTokenChannelStatusSummary: vi.fn().mockReturnValue({}),
  DEFAULT_ACCOUNT_ID: "default",
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
}));

// ── Internal module mocks ────────────────────────────────────────────────────

const mockSendMessageVk = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "1", chatId: "0" }),
);
const mockSendPayloadVk = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "2", chatId: "0" }),
);
vi.mock("./send.js", () => ({
  sendMessageVk: mockSendMessageVk,
  sendPayloadVk: mockSendPayloadVk,
}));

const mockMonitorVkProvider = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./monitor.js", () => ({ monitorVkProvider: mockMonitorVkProvider }));

const mockProbeVkBot = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, groupName: "TestBot", groupId: 1 }),
);
vi.mock("./probe.js", () => ({ probeVkBot: mockProbeVkBot }));

const mockGetVkRuntime = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    config: { writeConfigFile: vi.fn() },
    logging: { shouldLogVerbose: vi.fn().mockReturnValue(false) },
    channel: {
      text: { chunkMarkdownText: vi.fn((text: string) => [text]) },
    },
  }),
);
vi.mock("./runtime.js", () => ({ getVkRuntime: mockGetVkRuntime }));

const mockResolveVkAccount = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: { dmPolicy: "pairing", groups: {} },
  }),
);
const mockListVkAccountIds = vi.hoisted(() => vi.fn().mockReturnValue(["default"]));
const mockResolveDefaultVkAccountId = vi.hoisted(() => vi.fn().mockReturnValue("default"));

vi.mock("./accounts.js", () => ({
  resolveVkAccount: mockResolveVkAccount,
  listVkAccountIds: mockListVkAccountIds,
  resolveDefaultVkAccountId: mockResolveDefaultVkAccountId,
}));

vi.mock("./config-schema.js", () => ({
  VkConfigSchema: {},
}));

import { vkPlugin } from "./channel.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSendMessageVk.mockReset().mockResolvedValue({ messageId: "1", chatId: "0" });
  mockSendPayloadVk.mockReset().mockResolvedValue({ messageId: "2", chatId: "0" });
  mockProbeVkBot.mockReset().mockResolvedValue({ ok: true, groupName: "TestBot", groupId: 1 });
  mockMonitorVkProvider.mockReset().mockResolvedValue(undefined);
  mockResolveVkAccount.mockReset().mockReturnValue({
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: { dmPolicy: "pairing", groups: {} },
  });
});

// ── Plugin metadata ──────────────────────────────────────────────────────────

describe("plugin metadata", () => {
  it("has id 'vk'", () => {
    expect(vkPlugin.id).toBe("vk");
  });

  it("declares direct and group chat types", () => {
    expect(vkPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
  });

  it("supports media", () => {
    expect(vkPlugin.capabilities.media).toBe(true);
  });

  it("does not support reactions or threads", () => {
    expect(vkPlugin.capabilities.reactions).toBe(false);
    expect(vkPlugin.capabilities.threads).toBe(false);
  });

  it("uses block streaming", () => {
    expect(vkPlugin.capabilities.blockStreaming).toBe(true);
  });

  it("watches channels.vk config prefix for reload", () => {
    expect(vkPlugin.reload?.configPrefixes).toEqual(["channels.vk"]);
  });
});

// ── Pairing ──────────────────────────────────────────────────────────────────

describe("pairing", () => {
  it("normalizeAllowEntry strips vk:user: prefix", () => {
    expect(vkPlugin.pairing!.normalizeAllowEntry("vk:user:123")).toBe("123");
  });

  it("normalizeAllowEntry strips vk: prefix", () => {
    expect(vkPlugin.pairing!.normalizeAllowEntry("vk:456")).toBe("456");
  });

  it("normalizeAllowEntry is case-insensitive", () => {
    expect(vkPlugin.pairing!.normalizeAllowEntry("VK:USER:789")).toBe("789");
  });

  it("normalizeAllowEntry passes through plain IDs", () => {
    expect(vkPlugin.pairing!.normalizeAllowEntry("111")).toBe("111");
  });

  it("notifyApproval sends message via sendMessageVk", async () => {
    await vkPlugin.pairing!.notifyApproval({ cfg: {}, id: "42" });

    expect(mockSendMessageVk).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("approved"),
      expect.objectContaining({ cfg: {} }),
    );
  });

  it("idLabel is vkUserId", () => {
    expect(vkPlugin.pairing!.idLabel).toBe("vkUserId");
  });
});

// ── Messaging ────────────────────────────────────────────────────────────────

describe("messaging", () => {
  it("normalizeTarget strips vk: prefix", () => {
    expect(vkPlugin.messaging!.normalizeTarget("vk:123")).toBe("123");
  });

  it("normalizeTarget strips vk:user: prefix", () => {
    expect(vkPlugin.messaging!.normalizeTarget("vk:user:456")).toBe("456");
  });

  it("normalizeTarget strips vk:chat: prefix", () => {
    expect(vkPlugin.messaging!.normalizeTarget("vk:chat:789")).toBe("789");
  });

  it("normalizeTarget returns undefined for empty/whitespace", () => {
    expect(vkPlugin.messaging!.normalizeTarget("")).toBeUndefined();
    expect(vkPlugin.messaging!.normalizeTarget("   ")).toBeUndefined();
  });

  it("normalizeTarget passes through plain IDs", () => {
    expect(vkPlugin.messaging!.normalizeTarget("123456")).toBe("123456");
  });

  it("targetResolver.looksLikeId matches numeric IDs", () => {
    expect(vkPlugin.messaging!.targetResolver!.looksLikeId("123")).toBe(true);
  });

  it("targetResolver.looksLikeId matches vk: prefixed IDs", () => {
    expect(vkPlugin.messaging!.targetResolver!.looksLikeId("vk:123")).toBe(true);
  });

  it("targetResolver.looksLikeId rejects non-numeric non-prefixed", () => {
    expect(vkPlugin.messaging!.targetResolver!.looksLikeId("john")).toBe(false);
  });

  it("targetResolver.looksLikeId rejects empty/null", () => {
    expect(vkPlugin.messaging!.targetResolver!.looksLikeId("")).toBe(false);
    expect(vkPlugin.messaging!.targetResolver!.looksLikeId(null as never)).toBe(false);
  });
});

// ── Config ───────────────────────────────────────────────────────────────────

describe("config", () => {
  it("isConfigured returns true when token is non-empty", () => {
    expect(vkPlugin.config.isConfigured({ token: "tok" } as never)).toBe(true);
  });

  it("isConfigured returns false when token is empty", () => {
    expect(vkPlugin.config.isConfigured({ token: "" } as never)).toBe(false);
  });

  it("isConfigured returns false when token is whitespace", () => {
    expect(vkPlugin.config.isConfigured({ token: "   " } as never)).toBe(false);
  });

  it("describeAccount returns correct shape", () => {
    const account = {
      accountId: "sales",
      name: "Sales Bot",
      enabled: true,
      token: "tok",
      tokenSource: "config" as const,
      config: {},
    };
    const desc = vkPlugin.config.describeAccount(account as never);
    expect(desc).toEqual({
      accountId: "sales",
      name: "Sales Bot",
      enabled: true,
      configured: true,
      tokenSource: "config",
    });
  });

  it("describeAccount marks unconfigured when no token", () => {
    const account = { accountId: "x", enabled: true, token: "", config: {} };
    const desc = vkPlugin.config.describeAccount(account as never);
    expect(desc.configured).toBe(false);
  });
});

// ── Groups ───────────────────────────────────────────────────────────────────

describe("groups", () => {
  it("resolveRequireMention returns value for specific group", () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: { groups: { "2000000001": { requireMention: true } } },
    });

    const result = vkPlugin.groups!.resolveRequireMention({
      cfg: {},
      accountId: "default",
      groupId: "2000000001",
    });
    expect(result).toBe(true);
  });

  it("resolveRequireMention falls back to wildcard", () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: { groups: { "*": { requireMention: true } } },
    });

    const result = vkPlugin.groups!.resolveRequireMention({
      cfg: {},
      accountId: "default",
      groupId: "2000000999",
    });
    expect(result).toBe(true);
  });

  it("resolveRequireMention defaults to false when no groups config", () => {
    mockResolveVkAccount.mockReturnValueOnce({ config: {} });

    const result = vkPlugin.groups!.resolveRequireMention({
      cfg: {},
      accountId: "default",
      groupId: "2000000001",
    });
    expect(result).toBe(false);
  });

  it("resolveRequireMention defaults to false when no groupId", () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: { groups: { "*": { requireMention: true } } },
    });

    const result = vkPlugin.groups!.resolveRequireMention({
      cfg: {},
      accountId: "default",
      groupId: undefined as never,
    });
    expect(result).toBe(false);
  });
});

// ── Status ───────────────────────────────────────────────────────────────────

describe("status", () => {
  it("collectStatusIssues reports unconfigured account", () => {
    const issues = vkPlugin.status!.collectStatusIssues([
      { accountId: "default", configured: false } as never,
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("config");
    expect(issues[0].channel).toBe("vk");
  });

  it("collectStatusIssues returns empty for configured account", () => {
    const issues = vkPlugin.status!.collectStatusIssues([
      { accountId: "default", configured: true } as never,
    ]);
    expect(issues).toEqual([]);
  });

  it("buildAccountSnapshot includes tokenSource and mode", () => {
    const snapshot = vkPlugin.status!.buildAccountSnapshot({
      account: {
        accountId: "default",
        name: "Bot",
        enabled: true,
        token: "tok",
        tokenSource: "config",
      } as never,
      runtime: {} as never,
      probe: undefined as never,
    });
    expect(snapshot.tokenSource).toBe("config");
    expect(snapshot.mode).toBe("longpoll");
  });
});

// ── Directory ────────────────────────────────────────────────────────────────

describe("directory", () => {
  it("self returns null", async () => {
    expect(await vkPlugin.directory!.self()).toBeNull();
  });

  it("listPeers returns empty array", async () => {
    expect(await vkPlugin.directory!.listPeers()).toEqual([]);
  });

  it("listGroups returns empty array", async () => {
    expect(await vkPlugin.directory!.listGroups()).toEqual([]);
  });
});

// ── Outbound ─────────────────────────────────────────────────────────────────

describe("outbound", () => {
  it("sendPayload delegates to sendPayloadVk", async () => {
    const payload = {
      text: "Providers:",
      channelData: {
        vk: {
          buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
        },
      },
    };

    const result = await vkPlugin.outbound!.sendPayload({
      cfg: {},
      to: "123",
      payload,
      accountId: "default",
    } as never);

    expect(mockSendPayloadVk).toHaveBeenCalledWith("123", payload, {
      cfg: {},
      accountId: "default",
    });
    expect(result).toEqual({ channel: "vk", messageId: "2", chatId: "0" });
  });

  it("sendText delegates to sendMessageVk", async () => {
    const result = await vkPlugin.outbound!.sendText({
      cfg: {},
      to: "123",
      text: "hello",
      accountId: "default",
    } as never);

    expect(mockSendMessageVk).toHaveBeenCalledWith("123", "hello", {
      cfg: {},
      accountId: "default",
    });
    expect(result.channel).toBe("vk");
  });

  it("sendMedia combines text and mediaUrl", async () => {
    await vkPlugin.outbound!.sendMedia({
      cfg: {},
      to: "123",
      text: "caption",
      mediaUrl: "https://example.com/img.png",
      accountId: "default",
    } as never);

    expect(mockSendMessageVk).toHaveBeenCalledWith(
      "123",
      "caption\nhttps://example.com/img.png",
      expect.anything(),
    );
  });

  it("sendMedia sends only URL when no text", async () => {
    await vkPlugin.outbound!.sendMedia({
      cfg: {},
      to: "123",
      text: "",
      mediaUrl: "https://example.com/img.png",
      accountId: "default",
    } as never);

    expect(mockSendMessageVk).toHaveBeenCalledWith(
      "123",
      "https://example.com/img.png",
      expect.anything(),
    );
  });

  it("textChunkLimit is 4096", () => {
    expect(vkPlugin.outbound!.textChunkLimit).toBe(4096);
  });

  it("deliveryMode is direct", () => {
    expect(vkPlugin.outbound!.deliveryMode).toBe("direct");
  });
});

// ── Gateway ──────────────────────────────────────────────────────────────────

describe("gateway", () => {
  describe("logoutAccount", () => {
    it("clears token for default account", async () => {
      const mockWriteConfigFile = vi.fn();
      mockGetVkRuntime.mockReturnValue({
        config: { writeConfigFile: mockWriteConfigFile },
        logging: { shouldLogVerbose: vi.fn().mockReturnValue(false) },
      });
      mockResolveVkAccount.mockReturnValue({
        accountId: "default",
        token: "",
        tokenSource: "none",
        config: {},
      });

      const result = await vkPlugin.gateway!.logoutAccount({
        accountId: "default",
        cfg: { channels: { vk: { token: "old-tok" } } },
      } as never);

      expect(result.cleared).toBe(true);
      expect(mockWriteConfigFile).toHaveBeenCalledOnce();
    });

    it("removes named account from accounts section", async () => {
      const mockWriteConfigFile = vi.fn();
      mockGetVkRuntime.mockReturnValue({
        config: { writeConfigFile: mockWriteConfigFile },
        logging: { shouldLogVerbose: vi.fn().mockReturnValue(false) },
      });
      mockResolveVkAccount.mockReturnValue({
        accountId: "sales",
        token: "",
        tokenSource: "none",
        config: {},
      });

      const result = await vkPlugin.gateway!.logoutAccount({
        accountId: "sales",
        cfg: {
          channels: {
            vk: {
              token: "base",
              accounts: {
                sales: { token: "sales-tok" },
                support: { token: "support-tok" },
              },
            },
          },
        },
      } as never);

      expect(result.cleared).toBe(true);
      const writtenCfg = mockWriteConfigFile.mock.calls[0][0] as Record<string, unknown>;
      const vk = (writtenCfg.channels as Record<string, Record<string, unknown>>).vk;
      const accounts = vk.accounts as Record<string, unknown>;
      expect(accounts.sales).toBeUndefined();
      expect(accounts.support).toBeDefined();
    });

    it("removes accounts section when last named account is deleted", async () => {
      const mockWriteConfigFile = vi.fn();
      mockGetVkRuntime.mockReturnValue({
        config: { writeConfigFile: mockWriteConfigFile },
        logging: { shouldLogVerbose: vi.fn().mockReturnValue(false) },
      });
      mockResolveVkAccount.mockReturnValue({
        accountId: "sales",
        token: "",
        tokenSource: "none",
        config: {},
      });

      await vkPlugin.gateway!.logoutAccount({
        accountId: "sales",
        cfg: {
          channels: {
            vk: {
              token: "base",
              accounts: { sales: { token: "tok" } },
            },
          },
        },
      } as never);

      const writtenCfg = mockWriteConfigFile.mock.calls[0][0] as Record<string, unknown>;
      const vk = (writtenCfg.channels as Record<string, Record<string, unknown>>).vk;
      expect(vk.accounts).toBeUndefined();
    });

    it("does not write config when nothing to clear", async () => {
      const mockWriteConfigFile = vi.fn();
      mockGetVkRuntime.mockReturnValue({
        config: { writeConfigFile: mockWriteConfigFile },
        logging: { shouldLogVerbose: vi.fn().mockReturnValue(false) },
      });
      mockResolveVkAccount.mockReturnValue({
        accountId: "default",
        token: "",
        tokenSource: "none",
        config: {},
      });

      const result = await vkPlugin.gateway!.logoutAccount({
        accountId: "default",
        cfg: { channels: { vk: { dmPolicy: "open" } } },
      } as never);

      expect(result.cleared).toBe(false);
      expect(mockWriteConfigFile).not.toHaveBeenCalled();
    });

    it("reports loggedOut=true when tokenSource is none after clearing", async () => {
      mockGetVkRuntime.mockReturnValue({
        config: { writeConfigFile: vi.fn() },
        logging: { shouldLogVerbose: vi.fn().mockReturnValue(false) },
      });
      mockResolveVkAccount.mockReturnValue({
        accountId: "default",
        token: "",
        tokenSource: "none",
        config: {},
      });

      const result = await vkPlugin.gateway!.logoutAccount({
        accountId: "default",
        cfg: { channels: { vk: { token: "tok" } } },
      } as never);

      expect(result.loggedOut).toBe(true);
    });
  });

  describe("startAccount", () => {
    it("calls probeVkBot and monitorVkProvider", async () => {
      const ctx = {
        account: {
          accountId: "default",
          token: "test-token",
        },
        cfg: { channels: { vk: { token: "test-token" } } },
        runtime: {},
        abortSignal: undefined,
        log: { info: vi.fn(), debug: vi.fn() },
      };

      await vkPlugin.gateway!.startAccount(ctx as never);

      expect(mockProbeVkBot).toHaveBeenCalledWith("test-token", 2500);
      expect(mockMonitorVkProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "test-token",
          accountId: "default",
        }),
      );
    });

    it("throws when token is empty", async () => {
      const ctx = {
        account: { accountId: "default", token: "" },
        cfg: {},
        runtime: {},
        log: { info: vi.fn() },
      };

      await expect(vkPlugin.gateway!.startAccount(ctx as never)).rejects.toThrow(
        "non-empty community access token",
      );
    });

    it("continues if probe fails", async () => {
      mockProbeVkBot.mockRejectedValueOnce(new Error("network error"));

      const ctx = {
        account: { accountId: "default", token: "tok" },
        cfg: {},
        runtime: {},
        abortSignal: undefined,
        log: { info: vi.fn(), debug: vi.fn() },
      };

      await vkPlugin.gateway!.startAccount(ctx as never);
      expect(mockMonitorVkProvider).toHaveBeenCalledOnce();
    });
  });
});
