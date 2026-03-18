import { beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks ────────────────────────────────────────────────────────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

const mockDispatch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("openclaw/plugin-sdk/compat", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
  createPluginRuntimeStore: (errorMsg: string) => {
    let runtime: unknown;
    return {
      setRuntime: (r: unknown) => { runtime = r; },
      getRuntime: () => {
        if (!runtime) throw new Error(errorMsg);
        return runtime;
      },
    };
  },
  createScopedPairingAccess: ({ core, channel, accountId }: Record<string, unknown>) => ({
    readStoreForDmPolicy: () =>
      (core as any).channel.pairing.readAllowFromStore({ channel, accountId }),
    upsertPairingRequest: (params: Record<string, unknown>) =>
      (core as any).channel.pairing.upsertPairingRequest({ ...params, accountId }),
  }),
  dispatchInboundReplyWithBase: mockDispatch,
  formatTextWithAttachmentLinks: (text: string) => text || "",
  issuePairingChallenge: async ({
    upsertPairingRequest,
    sendPairingReply,
    senderId,
    channel,
    onReplyError,
  }: Record<string, any>) => {
    const result = await upsertPairingRequest({ channel, id: senderId });
    if (result.created && sendPairingReply) {
      try {
        await sendPairingReply("pairing-reply-text");
      } catch (err) {
        onReplyError?.(err);
      }
    }
  },
  logInboundDrop: () => {},
  isDangerousNameMatchingEnabled: () => false,
  readStoreAllowFromForDmPolicy: async ({ readStore }: Record<string, any>) =>
    readStore ? await readStore() : [],
  resolveControlCommandGate: () => ({
    shouldBlock: false,
    commandAuthorized: false,
  }),
  resolveOutboundMediaUrls: () => [],
  resolveAllowlistProviderRuntimeGroupPolicy: ({ groupPolicy }: Record<string, unknown>) => ({
    groupPolicy: groupPolicy ?? "open",
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: () => "open",
  resolveEffectiveAllowFromLists: ({
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
  }: Record<string, unknown[]>) => ({
    effectiveAllowFrom: [...(allowFrom ?? []), ...(storeAllowFrom ?? [])],
    effectiveGroupAllowFrom: [...(groupAllowFrom ?? [])],
  }),
  GROUP_POLICY_BLOCKED_LABEL: { channel: "blocked" },
  warnMissingProviderGroupPolicyFallbackOnce: () => {},
}));

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockSendMessageVk = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "1", chatId: "0" }));
vi.mock("./send.js", () => ({ sendMessageVk: mockSendMessageVk }));

import { handleVkInbound } from "./inbound.js";
import { setVkRuntime } from "./runtime.js";
import {
  createVkRuntimeEnv,
  makeAccount,
  makeMessage,
  makeVkRuntime,
} from "./test-helpers.js";
import type { CoreConfig } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SENDER_ID = 555_000;
const GROUP_PEER_ID = 2_000_000_001; // >= 2_000_000_000 → group chat

function baseCfg(vkOverrides: Record<string, unknown> = {}): CoreConfig {
  return { channels: { vk: { token: "tok", ...vkOverrides } } };
}

beforeEach(() => {
  mockDispatch.mockReset().mockResolvedValue(undefined);
  mockSendMessageVk.mockReset().mockResolvedValue({ messageId: "1", chatId: "0" });
  setVkRuntime(makeVkRuntime());
});

// ── Empty body ────────────────────────────────────────────────────────────────

describe("empty message body", () => {
  it("drops message with empty text immediately", async () => {
    const message = makeMessage({ text: "" });

    await handleVkInbound({
      message,
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockSendMessageVk).not.toHaveBeenCalled();
  });

  it("drops message with whitespace-only text", async () => {
    const message = makeMessage({ text: "   \n  " });

    await handleVkInbound({
      message,
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ── DM access control ─────────────────────────────────────────────────────────

describe("DM access control", () => {
  it("drops DM when dmPolicy=disabled", async () => {
    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "disabled" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches DM when dmPolicy=open", async () => {
    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("dispatches DM when sender is in allowFrom list (dmPolicy=allowlist)", async () => {
    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [SENDER_ID],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("drops DM when sender is not in allowFrom list (dmPolicy=allowlist)", async () => {
    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [999_999],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockSendMessageVk).not.toHaveBeenCalled();
  });

  it("dispatches DM when sender matches string allowFrom entry (dmPolicy=allowlist)", async () => {
    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [String(SENDER_ID)],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("issues pairing challenge to unknown sender when dmPolicy=pairing", async () => {
    const upsertPairingRequest = vi
      .fn()
      .mockResolvedValue({ code: "PAIR99", created: true });

    setVkRuntime(makeVkRuntime({ upsertPairingRequest }));

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    // Should not dispatch to agent
    expect(mockDispatch).not.toHaveBeenCalled();
    // Should upsert the pairing request in the store
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "vk",
        id: String(SENDER_ID),
        accountId: "default",
      }),
    );
    // Should send the pairing challenge reply back to the sender
    expect(mockSendMessageVk).toHaveBeenCalledOnce();
  });

  it("does not re-send pairing challenge when request already exists", async () => {
    const upsertPairingRequest = vi
      .fn()
      .mockResolvedValue({ code: "PAIR99", created: false }); // existing request

    setVkRuntime(makeVkRuntime({ upsertPairingRequest }));

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockSendMessageVk).not.toHaveBeenCalled();
  });

  it("dispatches DM when sender is in the pairing store (dmPolicy=pairing)", async () => {
    // Store contains the sender's ID → they've been approved
    setVkRuntime(
      makeVkRuntime({
        readAllowFromStore: vi
          .fn()
          .mockResolvedValue([String(SENDER_ID)]),
      }),
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("dispatches DM when sender is in the config allowFrom (dmPolicy=pairing)", async () => {
    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: { dmPolicy: "pairing", allowFrom: [SENDER_ID] },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

// ── Group access control ──────────────────────────────────────────────────────

describe("group access control", () => {
  it("drops group message when groupPolicy=disabled", async () => {
    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "disabled" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches group message when groupPolicy=open", async () => {
    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("dispatches group message when sender is in groupAllowFrom (groupPolicy=allowlist)", async () => {
    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
          groupAllowFrom: [SENDER_ID],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("drops group message when sender is not in groupAllowFrom (groupPolicy=allowlist)", async () => {
    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
          groupAllowFrom: [999_999],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ── Mention gating ────────────────────────────────────────────────────────────

describe("group mention gating", () => {
  it("drops group message when requireMention=true and bot was not mentioned", async () => {
    setVkRuntime(
      makeVkRuntime({
        buildMentionRegexes: vi.fn().mockReturnValue([/\@bot/i]),
        matchesMentionPatterns: vi.fn().mockReturnValue(false),
      }),
    );

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "hi everyone",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches group message when requireMention=true and bot was mentioned", async () => {
    setVkRuntime(
      makeVkRuntime({
        buildMentionRegexes: vi.fn().mockReturnValue([/\@bot/i]),
        matchesMentionPatterns: vi.fn().mockReturnValue(true),
      }),
    );

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "@bot help",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("dispatches group message when requireMention=false regardless of mention", async () => {
    setVkRuntime(
      makeVkRuntime({
        matchesMentionPatterns: vi.fn().mockReturnValue(false),
      }),
    );

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "no mention here",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("uses per-group config before wildcard config", async () => {
    // Per-group requireMention=false overrides wildcard requireMention=true
    setVkRuntime(
      makeVkRuntime({
        matchesMentionPatterns: vi.fn().mockReturnValue(false),
      }),
    );

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "message without mention",
      }),
      account: makeAccount({
        config: {
          dmPolicy: "open",
          groupPolicy: "open",
          groups: {
            "*": { requireMention: true },
            [String(GROUP_PEER_ID)]: { requireMention: false },
          },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

// ── Dispatch payload ──────────────────────────────────────────────────────────

describe("dispatch payload", () => {
  it("dispatches with correct channel and accountId", async () => {
    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        accountId: "my-account",
        config: { dmPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "vk",
        accountId: "my-account",
      }),
    );
  });

  it("sets ChatType=direct for DM messages", async () => {
    const core = makeVkRuntime();
    setVkRuntime(core);

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, isGroup: false }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(core.channel.reply.finalizeInboundContext),
    ).toHaveBeenCalledWith(
      expect.objectContaining({ ChatType: "direct" }),
    );
  });

  it("sets ChatType=group for group messages", async () => {
    const core = makeVkRuntime();
    setVkRuntime(core);

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(core.channel.reply.finalizeInboundContext),
    ).toHaveBeenCalledWith(
      expect.objectContaining({ ChatType: "group" }),
    );
  });

  it("records inbound activity before dispatching", async () => {
    const core = makeVkRuntime();
    setVkRuntime(core);

    const statusSink = vi.fn();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
      statusSink,
    });

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lastInboundAt: expect.any(Number) }),
    );
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});
