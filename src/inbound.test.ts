import { beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks ────────────────────────────────────────────────────────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/compat", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
  createPluginRuntimeStore: (errorMsg: string) => {
    let runtime: unknown;
    return {
      setRuntime: (value: unknown) => {
        runtime = value;
      },
      getRuntime: () => {
        if (!runtime) {
          throw new Error(errorMsg);
        }
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
  logInboundDrop: vi.fn(),
  readStoreAllowFromForDmPolicy: async ({ readStore }: Record<string, any>) =>
    readStore ? await readStore() : [],
  resolveControlCommandGate: vi.fn(() => ({
    shouldBlock: false,
    commandAuthorized: false,
  })),
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
  warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

const mockCreateReplyPrefixOptions = vi.hoisted(() => vi.fn());
const mockCreateTypingCallbacks = vi.hoisted(() => vi.fn());
const mockLogTypingFailure = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-runtime", () => ({
  createReplyPrefixOptions: mockCreateReplyPrefixOptions,
  createTypingCallbacks: mockCreateTypingCallbacks,
  logTypingFailure: mockLogTypingFailure,
}));

// ── Internal module mocks ────────────────────────────────────────────────────

const mockSendPayloadVk = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "1", chatId: "0" }),
);
const mockSendTypingVk = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./send.js", () => ({
  sendPayloadVk: mockSendPayloadVk,
  sendTypingVk: mockSendTypingVk,
}));

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
const GROUP_PEER_ID = 2_000_000_001;
const PREFIX_OPTIONS = {
  responsePrefix: undefined,
  enableSlackInteractiveReplies: undefined,
  responsePrefixContextProvider: vi.fn().mockReturnValue({}),
  onModelSelected: vi.fn(),
};

function baseCfg(vkOverrides: Record<string, unknown> = {}): CoreConfig {
  return { channels: { vk: { token: "tok", ...vkOverrides } } };
}

function installRuntime(opts: Parameters<typeof makeVkRuntime>[0] = {}) {
  const runtime = makeVkRuntime(opts);
  setVkRuntime(runtime);
  return runtime;
}

function getDispatchCall(runtime: ReturnType<typeof makeVkRuntime>) {
  const call = vi
    .mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher)
    .mock
    .calls[0]?.[0];
  if (!call) {
    throw new Error("dispatchReplyWithBufferedBlockDispatcher was not called");
  }
  return call;
}

beforeEach(() => {
  mockSendPayloadVk.mockReset().mockResolvedValue({ messageId: "1", chatId: "0" });
  mockSendTypingVk.mockReset().mockResolvedValue(undefined);
  PREFIX_OPTIONS.responsePrefixContextProvider.mockReset().mockReturnValue({});
  PREFIX_OPTIONS.onModelSelected.mockReset();
  mockCreateReplyPrefixOptions.mockReset().mockReturnValue(PREFIX_OPTIONS);
  mockCreateTypingCallbacks.mockReset().mockImplementation(({ start }) => ({
    onReplyStart: vi.fn(async () => {
      await start();
    }),
    onIdle: vi.fn(),
    onCleanup: vi.fn(),
  }));
  mockLogTypingFailure.mockReset();
  installRuntime();
});

// ── Empty body ────────────────────────────────────────────────────────────────

describe("empty message body", () => {
  it("drops message with empty text immediately", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ text: "" }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
  });

  it("drops message with whitespace-only text when payload does not override it", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ text: "   \n  " }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
  });
});

// ── DM access control ─────────────────────────────────────────────────────────

describe("DM access control", () => {
  it("drops DM when dmPolicy=disabled", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "disabled" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
  });

  it("dispatches DM when dmPolicy=open", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.channel.session.recordInboundSession)).toHaveBeenCalledOnce();
  });

  it("dispatches DM when sender is in allowFrom list", async () => {
    const runtime = installRuntime();

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("drops DM when sender is not in allowFrom list", async () => {
    const runtime = installRuntime();

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
  });

  it("issues pairing challenge to unknown sender when dmPolicy=pairing", async () => {
    const upsertPairingRequest = vi
      .fn()
      .mockResolvedValue({ code: "PAIR99", created: true });

    const runtime = installRuntime({ upsertPairingRequest });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "vk",
        id: String(SENDER_ID),
        accountId: "default",
      }),
    );
    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      { text: "pairing-reply-text" },
      { accountId: "default" },
    );
    expect(mockCreateTypingCallbacks).not.toHaveBeenCalled();
    expect(mockSendTypingVk).not.toHaveBeenCalled();
  });

  it("does not re-send pairing challenge when request already exists", async () => {
    const upsertPairingRequest = vi
      .fn()
      .mockResolvedValue({ code: "PAIR99", created: false });

    const runtime = installRuntime({ upsertPairingRequest });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
  });

  it("dispatches DM when sender is in the pairing store", async () => {
    const runtime = installRuntime({
      readAllowFromStore: vi.fn().mockResolvedValue([String(SENDER_ID)]),
    });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });
});

// ── Group access control ──────────────────────────────────────────────────────

describe("group access control", () => {
  it("drops group message when groupPolicy=disabled", async () => {
    const runtime = installRuntime();

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("dispatches group message when groupPolicy=open", async () => {
    const runtime = installRuntime();

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
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("dispatches group message when sender is in groupAllowFrom", async () => {
    const runtime = installRuntime();

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("drops group message when sender is not in groupAllowFrom", async () => {
    const runtime = installRuntime();

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });
});

// ── Mention gating ────────────────────────────────────────────────────────────

describe("group mention gating", () => {
  it("drops group message when requireMention=true and bot was not mentioned", async () => {
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/\@bot/i]),
      matchesMentionPatterns: vi.fn().mockReturnValue(false),
    });

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("dispatches group message when requireMention=true and bot was mentioned", async () => {
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/\@bot/i]),
      matchesMentionPatterns: vi.fn().mockReturnValue(true),
    });

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("dispatches group message when requireMention=false regardless of mention", async () => {
    const runtime = installRuntime({
      matchesMentionPatterns: vi.fn().mockReturnValue(false),
    });

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("uses per-group config before wildcard config", async () => {
    const runtime = installRuntime({
      matchesMentionPatterns: vi.fn().mockReturnValue(false),
    });

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

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });
});

// ── Dispatch payload ──────────────────────────────────────────────────────────

describe("dispatch payload", () => {
  it("uses hidden OpenClaw command payload instead of visible button text", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "OpenAI",
        messagePayload: { oc: "/models openai" },
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "/models openai",
        CommandBody: "/models openai",
      }),
    );
  });

  it("passes typing callbacks into reply dispatch and start() sends typing", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockCreateReplyPrefixOptions).toHaveBeenCalledWith({
      cfg: baseCfg(),
      agentId: "default",
      channel: "vk",
      accountId: "default",
    });

    const dispatchCall = getDispatchCall(runtime);
    expect(dispatchCall.dispatcherOptions.typingCallbacks).toBeDefined();

    await dispatchCall.dispatcherOptions.typingCallbacks.onReplyStart();

    expect(mockSendTypingVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("forwards full reply payloads to sendPayloadVk without stripping channelData", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver({
          text: "Providers:",
          replyToId: "77",
          channelData: {
            vk: {
              buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
            },
          },
        });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      {
        text: "Providers:",
        replyToId: "77",
        channelData: {
          vk: {
            buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
          },
        },
      },
      { accountId: "default" },
    );
  });

  it("sets ChatType=direct for DM messages", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, isGroup: false }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({ ChatType: "direct" }),
    );
  });

  it("sets ChatType=group for group messages", async () => {
    const runtime = installRuntime();

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

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({ ChatType: "group" }),
    );
  });

  it("records inbound activity before dispatching", async () => {
    const runtime = installRuntime();
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
    expect(vi.mocked(runtime.channel.session.recordInboundSession)).toHaveBeenCalledOnce();
  });
});
