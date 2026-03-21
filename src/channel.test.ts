import { beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks (must be before channel.ts import) ─────────────────────────────

vi.mock("openclaw/plugin-sdk/compat", () => ({
  createScopedAccountConfigAccessors: ({ resolveAllowFrom, formatAllowFrom, resolveDefaultTo }: Record<string, unknown>) => ({
    resolveAllowFrom,
    formatAllowFrom,
    resolveDefaultTo,
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
const mockResolveVkDirectoryPeers = vi.hoisted(() =>
  vi.fn(({ account }: Record<string, any>) => {
    const raw = [...(account?.config?.allowFrom ?? []), ...(account?.config?.defaultTo ? [account.config.defaultTo] : [])];
    const ids = Array.from(
      new Set(
        raw
          .map((entry) => String(entry).trim().replace(/^vk:(?:user:)?/i, ""))
          .filter((entry) => Boolean(entry) && entry !== "*")
          .filter((entry) => !/^2\d{9,}$/.test(entry)),
      ),
    );
    return ids.map((id) => ({ kind: "user", id }));
  }),
);
const mockResolveVkDirectoryGroups = vi.hoisted(() =>
  vi.fn(({ account }: Record<string, any>) => {
    const raw = [
      ...Object.keys(account?.config?.groups ?? {}).filter((entry) => entry !== "*"),
      ...(account?.config?.defaultTo ? [account.config.defaultTo] : []),
    ];
    const ids = Array.from(
      new Set(
        raw
          .map((entry) => String(entry).trim().replace(/^vk:(?:chat:)?/i, ""))
          .filter((entry) => Boolean(entry) && /^2\d{9,}$/.test(entry)),
      ),
    );
    return ids.map((id) => ({ kind: "group", id }));
  }),
);
const mockReadVkAllowlistConfig = vi.hoisted(() => vi.fn((account: Record<string, any>) => ({
  dmAllowFrom: (account?.config?.allowFrom ?? []).map(String),
  groupAllowFrom: (account?.config?.groupAllowFrom ?? []).map(String),
})));
const mockApplyVkAllowlistConfigEdit = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    kind: "ok",
    changed: false,
    pathLabel: "channels.vk.allowFrom",
    writeTarget: { kind: "channel", scope: { channelId: "vk" } },
  }),
);
const mockIsVkGroupPeerId = vi.hoisted(() =>
  vi.fn((peerId: string | number) => {
    const n = typeof peerId === "number" ? peerId : Number(peerId);
    return Number.isFinite(n) && n >= 2_000_000_000;
  }),
);
vi.mock("./send.js", () => ({
  sendMessageVk: mockSendMessageVk,
  sendPayloadVk: mockSendPayloadVk,
  isVkGroupPeerId: mockIsVkGroupPeerId,
  resolveVkDirectoryPeers: mockResolveVkDirectoryPeers,
  resolveVkDirectoryGroups: mockResolveVkDirectoryGroups,
  readVkAllowlistConfig: mockReadVkAllowlistConfig,
  applyVkAllowlistConfigEdit: mockApplyVkAllowlistConfigEdit,
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
  mockResolveVkDirectoryPeers.mockClear();
  mockResolveVkDirectoryGroups.mockClear();
  mockReadVkAllowlistConfig.mockClear();
  mockApplyVkAllowlistConfigEdit.mockClear();
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

  describe("parseExplicitTarget", () => {
    it("parses numeric DM target", () => {
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "123456" })).toEqual({
        to: "123456",
        chatType: "direct",
      });
    });

    it("parses vk:-prefixed DM target", () => {
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "vk:123456" })).toEqual({
        to: "123456",
        chatType: "direct",
      });
    });

    it("parses vk:user: prefixed target", () => {
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "vk:user:123456" })).toEqual({
        to: "123456",
        chatType: "direct",
      });
    });

    it("parses group chat target (peerId >= 2_000_000_000)", () => {
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "vk:chat:2000000001" })).toEqual({
        to: "2000000001",
        chatType: "group",
      });
    });

    it("returns null for empty input", () => {
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "" })).toBeNull();
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "   " })).toBeNull();
    });

    it("returns null for non-numeric input", () => {
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "john" })).toBeNull();
      expect(vkPlugin.messaging!.parseExplicitTarget!({ raw: "vk:abc" })).toBeNull();
    });
  });

  describe("inferTargetChatType", () => {
    it("returns 'direct' for user peer ID", () => {
      expect(vkPlugin.messaging!.inferTargetChatType!({ to: "123456" })).toBe("direct");
    });

    it("returns 'group' for group peer ID", () => {
      expect(vkPlugin.messaging!.inferTargetChatType!({ to: "2000000001" })).toBe("group");
    });

    it("strips vk: prefix before inferring", () => {
      expect(vkPlugin.messaging!.inferTargetChatType!({ to: "vk:chat:2000000001" })).toBe("group");
    });

    it("returns undefined for non-numeric target", () => {
      expect(vkPlugin.messaging!.inferTargetChatType!({ to: "abc" })).toBeUndefined();
    });
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

  it("resolveDefaultTo returns the configured default target", () => {
    expect(
      vkPlugin.config.resolveDefaultTo?.({
        config: { defaultTo: "555000" },
      } as never),
    ).toBe("555000");
  });
});

describe("security", () => {
  it("collectWarnings returns no warnings for properly configured account", () => {
    const warnings = vkPlugin.security!.collectWarnings!({
      account: mockResolveVkAccount({
        config: { groupPolicy: "allowlist", groupAllowFrom: [123] },
      }),
      cfg: { channels: { vk: { groupPolicy: "allowlist" } } },
    } as never);
    expect(warnings).toEqual([]);
  });
});

describe("allowlist", () => {
  it("supportsScope accepts dm, group, and all scopes", () => {
    expect(vkPlugin.allowlist!.supportsScope({ scope: "dm" } as never)).toBe(true);
    expect(vkPlugin.allowlist!.supportsScope({ scope: "group" } as never)).toBe(true);
    expect(vkPlugin.allowlist!.supportsScope({ scope: "all" } as never)).toBe(true);
  });

  it("supportsScope rejects unknown scopes", () => {
    expect(vkPlugin.allowlist!.supportsScope({ scope: "thread" } as never)).toBe(false);
  });

  it("reads configured DM and group allowlists", async () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: {
        allowFrom: ["111"],
        groupAllowFrom: ["222"],
      },
    });

    expect(await vkPlugin.allowlist!.readConfig!({ cfg: {}, accountId: "default" } as never)).toEqual({
      dmAllowFrom: ["111"],
      groupAllowFrom: ["222"],
    });
  });

  it("delegates allowlist edits through the config editor", () => {
    vkPlugin.allowlist!.applyConfigEdit!({
      cfg: {},
      parsedConfig: {},
      accountId: "default",
      scope: "dm",
      action: "add",
      entry: "123",
    } as never);

    expect(mockApplyVkAllowlistConfigEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "dm",
        action: "add",
        entry: "123",
      }),
    );
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

  it("resolveToolPolicy returns tools config for a specific group", () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: {
        groups: {
          "2000000001": { tools: { allow: ["search"], deny: ["exec"] } },
        },
      },
    });

    const result = vkPlugin.groups!.resolveToolPolicy!({
      cfg: {},
      accountId: "default",
      groupId: "2000000001",
    });
    expect(result).toEqual({ allow: ["search"], deny: ["exec"] });
  });

  it("resolveToolPolicy falls back to wildcard group", () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: {
        groups: { "*": { tools: { deny: ["exec"] } } },
      },
    });

    const result = vkPlugin.groups!.resolveToolPolicy!({
      cfg: {},
      accountId: "default",
      groupId: "2000000999",
    });
    expect(result).toEqual({ deny: ["exec"] });
  });

  it("resolveToolPolicy returns undefined when no groups config", () => {
    mockResolveVkAccount.mockReturnValueOnce({ config: {} });

    const result = vkPlugin.groups!.resolveToolPolicy!({
      cfg: {},
      accountId: "default",
      groupId: "2000000001",
    });
    expect(result).toBeUndefined();
  });

  it("resolveToolPolicy returns undefined when no groupId", () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: { groups: { "*": { tools: { deny: ["exec"] } } } },
    });

    const result = vkPlugin.groups!.resolveToolPolicy!({
      cfg: {},
      accountId: "default",
      groupId: undefined as never,
    });
    expect(result).toBeUndefined();
  });

  it("resolveToolPolicy returns undefined when group has no tools", () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: { groups: { "2000000001": { requireMention: true } } },
    });

    const result = vkPlugin.groups!.resolveToolPolicy!({
      cfg: {},
      accountId: "default",
      groupId: "2000000001",
    });
    expect(result).toBeUndefined();
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

  describe("formatCapabilitiesProbe", () => {
    it("shows group name and id when probe is ok", () => {
      const lines = vkPlugin.status!.formatCapabilitiesProbe!({
        probe: { ok: true, groupName: "TestBot", groupId: 12345, screenName: "testbot" },
      } as never);
      expect(lines).toEqual([
        { text: "Group: TestBot (12345)" },
        { text: "Screen name: testbot" },
      ]);
    });

    it("shows only group name when no groupId", () => {
      const lines = vkPlugin.status!.formatCapabilitiesProbe!({
        probe: { ok: true, groupName: "TestBot" },
      } as never);
      expect(lines).toEqual([{ text: "Group: TestBot" }]);
    });

    it("returns empty array when probe failed", () => {
      const lines = vkPlugin.status!.formatCapabilitiesProbe!({
        probe: { ok: false, error: "bad token" },
      } as never);
      expect(lines).toEqual([]);
    });

    it("returns empty array when probe is null", () => {
      const lines = vkPlugin.status!.formatCapabilitiesProbe!({
        probe: null,
      } as never);
      expect(lines).toEqual([]);
    });
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

  it("lists configured DM peers and ignores group targets", async () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: {
        allowFrom: ["vk:111", "222"],
        defaultTo: "2000000009",
      },
    });

    expect(await vkPlugin.directory!.listPeers({ cfg: {}, accountId: "default" } as never)).toEqual([
      { kind: "user", id: "111" },
      { kind: "user", id: "222" },
    ]);
  });

  it("lists configured groups and includes group defaultTo", async () => {
    mockResolveVkAccount.mockReturnValueOnce({
      config: {
        groups: {
          "2000000001": {},
          "*": {},
        },
        defaultTo: "2000000002",
      },
    });

    expect(await vkPlugin.directory!.listGroups({ cfg: {}, accountId: "default" } as never)).toEqual([
      { kind: "group", id: "2000000001" },
      { kind: "group", id: "2000000002" },
    ]);
  });
});

// ── Outbound ─────────────────────────────────────────────────────────────────

describe("outbound", () => {
  it("sendPayload passes replyToId and mediaLocalRoots through to VK", async () => {
    const result = await vkPlugin.outbound!.sendPayload({
      cfg: {},
      to: "123",
      payload: { text: "test" },
      accountId: "sales",
      mediaLocalRoots: ["/tmp"],
      replyToId: "77",
      forceDocument: true,
    } as never);

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      "123",
      { text: "test" },
      expect.objectContaining({
        accountId: "sales",
        mediaLocalRoots: ["/tmp"],
        replyTo: "77",
        forceDocument: true,
      }),
    );
    expect(result.channel).toBe("vk");
  });

  it("sendText passes replyToId through to VK", async () => {
    const result = await vkPlugin.outbound!.sendText({
      cfg: {},
      to: "123",
      text: "hello",
      accountId: "default",
      replyToId: "55",
    } as never);

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      "123",
      { text: "hello", replyToId: "55" },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(result.channel).toBe("vk");
  });

  it("sendMedia passes forceDocument and mediaLocalRoots through to VK", async () => {
    await vkPlugin.outbound!.sendMedia({
      cfg: {},
      to: "123",
      text: "caption",
      mediaUrl: "https://example.com/img.png",
      accountId: "default",
      mediaLocalRoots: ["/data"],
      forceDocument: true,
      replyToId: "88",
    } as never);

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      "123",
      { text: "caption", mediaUrl: "https://example.com/img.png", replyToId: "88" },
      expect.objectContaining({
        mediaLocalRoots: ["/data"],
        forceDocument: true,
      }),
    );
  });

  it("sendText falls back to sendMessageVk when sendPayloadVk returns null", async () => {
    mockSendPayloadVk.mockResolvedValueOnce(null);

    const result = await vkPlugin.outbound!.sendText({
      cfg: {},
      to: "123",
      text: "hello",
      accountId: "default",
    } as never);

    expect(mockSendMessageVk).toHaveBeenCalledWith("123", "hello", {
      cfg: {},
      accountId: "default",
      replyTo: undefined,
    });
    expect(result.channel).toBe("vk");
  });

  it("sendMedia falls back to sendMessageVk when sendPayloadVk returns null", async () => {
    mockSendPayloadVk.mockResolvedValueOnce(null);

    const result = await vkPlugin.outbound!.sendMedia({
      cfg: {},
      to: "123",
      text: "caption",
      mediaUrl: "https://example.com/img.png",
      accountId: "default",
    } as never);

    expect(mockSendMessageVk).toHaveBeenCalledWith("123", "caption", {
      cfg: {},
      accountId: "default",
      replyTo: undefined,
    });
    expect(result.channel).toBe("vk");
  });

  it("sendPayload returns empty messageId when sendPayloadVk returns null", async () => {
    mockSendPayloadVk.mockResolvedValueOnce(null);

    const result = await vkPlugin.outbound!.sendPayload({
      cfg: {},
      to: "123",
      payload: { text: "" },
      accountId: "default",
    } as never);

    expect(result).toEqual({ channel: "vk", messageId: "", chatId: "123" });
  });

  it("textChunkLimit is 4096", () => {
    expect(vkPlugin.outbound!.textChunkLimit).toBe(4096);
  });

  it("deliveryMode is direct", () => {
    expect(vkPlugin.outbound!.deliveryMode).toBe("direct");
  });

  it("chunkerMode is markdown", () => {
    expect(vkPlugin.outbound!.chunkerMode).toBe("markdown");
  });

  it("shouldSkipPlainTextSanitization returns true when channelData is present", () => {
    expect(
      vkPlugin.outbound!.shouldSkipPlainTextSanitization!({
        payload: { channelData: { vk: {} } },
      } as never),
    ).toBe(true);
  });

  it("shouldSkipPlainTextSanitization returns false when channelData is absent", () => {
    expect(
      vkPlugin.outbound!.shouldSkipPlainTextSanitization!({
        payload: { text: "hello" },
      } as never),
    ).toBe(false);
  });

  it("resolveEffectiveTextChunkLimit caps at 4096", () => {
    expect(
      vkPlugin.outbound!.resolveEffectiveTextChunkLimit!({ fallbackLimit: 8000 } as never),
    ).toBe(4096);
  });

  it("resolveEffectiveTextChunkLimit uses smaller fallback when below 4096", () => {
    expect(
      vkPlugin.outbound!.resolveEffectiveTextChunkLimit!({ fallbackLimit: 2000 } as never),
    ).toBe(2000);
  });

  it("resolveEffectiveTextChunkLimit defaults to 4096 when no fallback", () => {
    expect(
      vkPlugin.outbound!.resolveEffectiveTextChunkLimit!({ fallbackLimit: undefined } as never),
    ).toBe(4096);
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

    it("logs probe failure in verbose mode", async () => {
      mockProbeVkBot.mockRejectedValueOnce(new Error("timeout"));
      mockGetVkRuntime.mockReturnValue({
        config: { writeConfigFile: vi.fn() },
        logging: { shouldLogVerbose: vi.fn().mockReturnValue(true) },
        channel: { text: { chunkMarkdownText: vi.fn((text: string) => [text]) } },
      });

      const debugFn = vi.fn();
      const ctx = {
        account: { accountId: "default", token: "tok" },
        cfg: {},
        runtime: {},
        abortSignal: undefined,
        log: { info: vi.fn(), debug: debugFn },
      };

      await vkPlugin.gateway!.startAccount(ctx as never);
      expect(debugFn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    });

    it("includes group name in log when probe succeeds", async () => {
      const infoFn = vi.fn();
      const ctx = {
        account: { accountId: "default", token: "tok" },
        cfg: {},
        runtime: {},
        abortSignal: undefined,
        log: { info: infoFn, debug: vi.fn() },
      };

      await vkPlugin.gateway!.startAccount(ctx as never);
      expect(infoFn).toHaveBeenCalledWith(expect.stringContaining("TestBot"));
    });
  });
});
