import { beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks ────────────────────────────────────────────────────────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/account-id", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
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
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingController: ({ core, channel, accountId }: Record<string, unknown>) => ({
    readStoreForDmPolicy: () =>
      (core as any).channel.pairing.readAllowFromStore({ channel, accountId }),
    upsertPairingRequest: (params: Record<string, unknown>) =>
      (core as any).channel.pairing.upsertPairingRequest({ ...params, accountId }),
  }),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
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
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  logInboundDrop: vi.fn(),
}));

const mockStatusReactionCtrl = vi.hoisted(() => ({
  setQueued: vi.fn(),
  setThinking: vi.fn(),
  setTool: vi.fn(),
  setCompacting: vi.fn(),
  setDone: vi.fn().mockResolvedValue(undefined),
  setError: vi.fn().mockResolvedValue(undefined),
  cancelPending: vi.fn(),
  clear: vi.fn().mockResolvedValue(undefined),
  restoreInitial: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  DEFAULT_EMOJIS: {
    queued: "👀",
    thinking: "🧠",
    tool: "🛠️",
    coding: "🛠️",
    web: "🛠️",
    deploy: "🛠️",
    build: "🛠️",
    concierge: "🛠️",
    done: "✅",
    error: "❌",
    stallSoft: "⏳",
    stallHard: "⏱️",
    compacting: "🗜️",
  },
  DEFAULT_TIMING: {
    debounceMs: 250,
    stallSoftMs: 10000,
    stallHardMs: 30000,
    doneHoldMs: 1500,
    errorHoldMs: 2500,
  },
  createStatusReactionController: vi.fn(() => mockStatusReactionCtrl),
}));

vi.mock("openclaw/plugin-sdk/channel-policy", () => ({
  readStoreAllowFromForDmPolicy: async ({ readStore }: Record<string, any>) =>
    readStore ? await readStore() : [],
  resolveEffectiveAllowFromLists: ({
    allowFrom,
    groupAllowFrom,
    storeAllowFrom,
  }: Record<string, unknown[]>) => ({
    effectiveAllowFrom: [...(allowFrom ?? []), ...(storeAllowFrom ?? [])],
    effectiveGroupAllowFrom: [...(groupAllowFrom ?? [])],
  }),
}));

vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  resolveControlCommandGate: vi.fn(() => ({
    shouldBlock: false,
    commandAuthorized: false,
  })),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  resolveAllowlistProviderRuntimeGroupPolicy: ({ groupPolicy }: Record<string, unknown>) => ({
    groupPolicy: groupPolicy ?? "open",
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: () => "open",
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

// Step-progress: default mode "off" keeps the existing (reactions/plain) paths;
// individual tests flip resolveChannelPreviewStreamMode to "progress".
const mockResolveStreamMode = vi.hoisted(() => vi.fn(() => "off"));
const mockProgressCompositor = vi.hoisted(() => ({
  noteActivity: vi.fn().mockResolvedValue(true),
  pushToolProgress: vi.fn().mockResolvedValue(true),
  pushReasoningProgress: vi.fn().mockResolvedValue(true),
  markFinalReplyStarted: vi.fn(),
  markFinalReplyDelivered: vi.fn(),
  cancel: vi.fn(),
}));
const mockCreateProgressCompositor = vi.hoisted(() =>
  vi.fn(() => mockProgressCompositor),
);

vi.mock("openclaw/plugin-sdk/channel-message", () => ({
  resolveChannelPreviewStreamMode: mockResolveStreamMode,
  createChannelProgressDraftCompositor: mockCreateProgressCompositor,
  // Return the raw input as the "line" so tests can assert what was built.
  buildChannelProgressDraftLineForEntry: (_entry: unknown, input: unknown) => input,
}));

// ── Internal module mocks ────────────────────────────────────────────────────

const mockSendPayloadVk = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "1", chatId: "0" }),
);
const mockMarkMessageReadVk = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSendTypingVk = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./send.js", () => ({
  markMessageReadVk: mockMarkMessageReadVk,
  sendPayloadVk: mockSendPayloadVk,
  sendTypingVk: mockSendTypingVk,
  // Used transitively by progress-draft.ts; harmless no-ops here since the
  // mocked compositor never drives update()/deleteCurrent().
  sendMessageVk: vi.fn().mockResolvedValue({ messageId: "9", chatId: "0" }),
  editMessageVk: vi.fn().mockResolvedValue(true),
  deleteMessageVk: vi.fn().mockResolvedValue(undefined),
  clearVkInstances: vi.fn(),
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
  mockMarkMessageReadVk.mockReset().mockResolvedValue(undefined);
  mockSendPayloadVk.mockReset().mockResolvedValue({ messageId: "1", chatId: "0" });
  mockSendTypingVk.mockReset().mockResolvedValue(undefined);
  mockResolveStreamMode.mockReset().mockReturnValue("off");
  mockCreateProgressCompositor.mockClear();
  mockProgressCompositor.noteActivity.mockClear();
  mockProgressCompositor.pushToolProgress.mockClear();
  mockProgressCompositor.pushReasoningProgress.mockClear();
  mockProgressCompositor.markFinalReplyStarted.mockClear();
  mockProgressCompositor.markFinalReplyDelivered.mockClear();
  mockProgressCompositor.cancel.mockClear();
  Object.values(mockStatusReactionCtrl).forEach((fn) => fn.mockClear());
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
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
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
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
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
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
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
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
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
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
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
    expect(mockMarkMessageReadVk).not.toHaveBeenCalled();
    expect(mockSendPayloadVk).not.toHaveBeenCalled();
  });

  it("dispatches DM when allowFrom contains wildcard '*'", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: 999_999, peerId: 999_999 }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["*"],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("dispatches DM when sender matches via vk: prefix in allowFrom", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [`vk:${SENDER_ID}`],
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
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

  it("drops group message when the group is explicitly disabled", async () => {
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
          groupPolicy: "open",
          groups: {
            [String(GROUP_PEER_ID)]: { enabled: false },
          },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("uses per-group allowFrom override instead of the account-wide group allowlist", async () => {
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
          groups: {
            [String(GROUP_PEER_ID)]: { allowFrom: [SENDER_ID] },
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
        RawBody: "OpenAI",
        BodyForAgent: "/models openai",
        CommandBody: "/models openai",
      }),
    );
  });

  it("starts typing before dispatch and passes callbacks into reply dispatch", async () => {
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
    const typingCallbacks = dispatchCall.dispatcherOptions.typingCallbacks as
      | { onReplyStart: unknown }
      | undefined;
    const onReplyStart = dispatchCall.dispatcherOptions.onReplyStart as (() => Promise<void>) | undefined;
    expect(typingCallbacks?.onReplyStart).toBeTypeOf("function");
    expect(onReplyStart).toBeTypeOf("function");
    expect(dispatchCall.dispatcherOptions.typingCallbacks).toBe(
      mockCreateTypingCallbacks.mock.results[0]?.value,
    );

    expect(mockSendTypingVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      expect.objectContaining({ accountId: "default" }),
    );

    const callsBeforeSecondStart = mockSendTypingVk.mock.calls.length;
    await onReplyStart?.();
    expect(mockSendTypingVk).toHaveBeenCalledTimes(callsBeforeSecondStart);
  });

  it("marks the inbound message as read before dispatching", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        messageId: "77",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockMarkMessageReadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      "77",
      expect.objectContaining({ accountId: "default" }),
    );

    expect(mockMarkMessageReadVk.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
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

  it("clears the old keyboard after a button-triggered final reply with no new choices", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver(
          {
            text: "Thinking level set to high.",
          },
          { kind: "final" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "high",
        messagePayload: { oc: "/think high" },
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      {
        text: "Thinking level set to high.",
      },
      { accountId: "default", clearKeyboard: true },
    );
  });

  it("keeps the keyboard when a button-triggered final reply still has choices", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      async ({ dispatcherOptions }: any) => {
        await dispatcherOptions.deliver(
          {
            text: [
              "Current thinking level: high.",
              "Options: off, minimal, low, medium, high, adaptive.",
            ].join("\n"),
          },
          { kind: "final" },
        );
      },
    );

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "high",
        messagePayload: { oc: "/think high" },
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockSendPayloadVk).toHaveBeenCalledWith(
      String(SENDER_ID),
      {
        text: [
          "Current thinking level: high.",
          "Options: off, minimal, low, medium, high, adaptive.",
        ].join("\n"),
      },
      { accountId: "default" },
    );
  });

  it("dispatches attachment-only messages with media placeholders and media context", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          {
            type: "photo",
            kind: "image",
            url: "https://example.com/photo.png",
            title: "photo.png",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        MediaUrl: "https://example.com/photo.png",
        MediaUrls: ["https://example.com/photo.png"],
        MediaType: "image",
        MediaTypes: ["image"],
      }),
    );
  });

  it("prefers attachment mime types in MediaType/MediaTypes when available", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          {
            type: "doc",
            kind: "image",
            url: "https://example.com/phone-photo",
            mimeType: "image/heic",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        MediaUrl: "https://example.com/phone-photo",
        MediaUrls: ["https://example.com/phone-photo"],
        MediaType: "image/heic",
        MediaTypes: ["image/heic"],
      }),
    );
  });

  it("adds MediaPath and MediaPaths when inbound media is materialized locally", async () => {
    const runtime = installRuntime();
    vi.mocked(runtime.channel.media.fetchRemoteMedia).mockResolvedValueOnce({
      buffer: Buffer.from("heic"),
      contentType: "image/heic",
    } as Awaited<ReturnType<typeof runtime.channel.media.fetchRemoteMedia>>);
    vi.mocked(runtime.channel.media.saveMediaBuffer).mockResolvedValueOnce({
      path: "/tmp/openclaw/media/inbound/IMG_0001.HEIC",
      contentType: "image/heic",
      size: 4,
      name: "IMG_0001.HEIC",
    } as Awaited<ReturnType<typeof runtime.channel.media.saveMediaBuffer>>);

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          {
            type: "doc",
            kind: "image",
            url: "https://example.com/phone-photo",
            title: "IMG_0001.HEIC",
            mimeType: "image/heic",
          },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        MediaPath: "/tmp/openclaw/media/inbound/IMG_0001.HEIC",
        MediaPaths: ["/tmp/openclaw/media/inbound/IMG_0001.HEIC"],
        MediaUrl: "https://example.com/phone-photo",
        MediaUrls: ["https://example.com/phone-photo"],
        MediaType: "image/heic",
        MediaTypes: ["image/heic"],
      }),
    );
  });

  it("passes multiple image URLs in MediaUrls for multi-photo messages", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          { type: "photo", kind: "image", url: "https://example.com/1.jpg" },
          { type: "photo", kind: "image", url: "https://example.com/2.jpg" },
          { type: "photo", kind: "image", url: "https://example.com/3.jpg" },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrl: "https://example.com/1.jpg",
        MediaUrls: [
          "https://example.com/1.jpg",
          "https://example.com/2.jpg",
          "https://example.com/3.jpg",
        ],
        MediaType: "image",
        MediaTypes: ["image"],
      }),
    );
  });

  it("uses text as body when message has both text and attachments", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "Look at this photo",
        attachments: [
          { type: "photo", kind: "image", url: "https://example.com/photo.jpg" },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: "Look at this photo",
        BodyForAgent: "Look at this photo",
        MediaUrl: "https://example.com/photo.jpg",
        MediaUrls: ["https://example.com/photo.jpg"],
        MediaType: "image",
        MediaTypes: ["image"],
      }),
    );
  });

  it("passes mixed MediaTypes for messages with different attachment kinds", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "",
        attachments: [
          { type: "photo", kind: "image", url: "https://example.com/pic.jpg" },
          { type: "doc", kind: "document", url: "https://example.com/file.pdf" },
        ],
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrl: "https://example.com/pic.jpg",
        MediaUrls: ["https://example.com/pic.jpg", "https://example.com/file.pdf"],
        MediaType: "image",
        MediaTypes: ["image", "document"],
      }),
    );
  });

  it("omits MediaUrl and MediaUrls when message has no attachments", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "plain text",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrl: undefined,
        MediaUrls: undefined,
        MediaType: undefined,
        MediaTypes: undefined,
      }),
    );
  });

  it("includes reply metadata in the inbound context", async () => {
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        replyToMessageId: "77",
        replyToText: "quoted reply",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "77",
        ReplyToIdFull: "77",
        ReplyToBody: "quoted reply",
      }),
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
    const message = makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID });

    await handleVkInbound({
      message,
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
      statusSink,
    });

    const statusUpdate = statusSink.mock.calls[0]?.[0] as { lastInboundAt?: number } | undefined;
    expect(statusUpdate?.lastInboundAt).toBeTypeOf("number");
    expect(statusUpdate!.lastInboundAt).toBe(message.timestamp);
    expect(vi.mocked(runtime.channel.session.recordInboundSession)).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.channel.session.recordInboundSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SessionKey: "vk:123456",
        }),
      }),
    );
  });

  it("passes GroupSystemPrompt from per-group config", async () => {
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
          groupPolicy: "open",
          groups: { [String(GROUP_PEER_ID)]: { systemPrompt: "Be concise." } },
        },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        GroupSystemPrompt: "Be concise.",
      }),
    );
  });

  it("passes WasMentioned=true when mention is detected in group", async () => {
    const runtime = installRuntime({
      buildMentionRegexes: vi.fn().mockReturnValue([/@bot/i]),
      matchesMentionPatterns: vi.fn().mockReturnValue(true),
    });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "@bot hello",
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(vi.mocked(runtime.channel.reply.finalizeInboundContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        WasMentioned: true,
      }),
    );
  });

  it("tolerates markRead failure without blocking dispatch", async () => {
    const runtime = installRuntime();
    const runtimeEnv = createVkRuntimeEnv();
    const logSpy = vi.spyOn(runtimeEnv, "log").mockImplementation(() => {});
    mockMarkMessageReadVk.mockRejectedValueOnce(new Error("markRead failed"));

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: runtimeEnv,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("mark read failed"),
    );
    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });

  it("logs typing failures via logTypingFailure", async () => {
    installRuntime();
    mockSendTypingVk.mockRejectedValueOnce(new Error("typing error"));
    mockCreateTypingCallbacks.mockReset().mockImplementation(({ start, onStartError }) => ({
      onReplyStart: vi.fn(async () => {
        try {
          await start();
        } catch (err) {
          onStartError?.(err);
        }
      }),
      onIdle: vi.fn(),
      onCleanup: vi.fn(),
    }));

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockLogTypingFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "vk",
        target: String(SENDER_ID),
      }),
    );
  });

  it("logs pairing reply errors without crashing", async () => {
    const runtimeEnv = createVkRuntimeEnv();
    const errorSpy = vi.spyOn(runtimeEnv, "error").mockImplementation(() => {});
    mockSendPayloadVk.mockRejectedValueOnce(new Error("send failed"));

    installRuntime({
      upsertPairingRequest: vi.fn().mockResolvedValue({ code: "X", created: true }),
    });

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID }),
      account: makeAccount({ config: { dmPolicy: "pairing", allowFrom: [] } }),
      config: baseCfg(),
      runtime: runtimeEnv,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pairing reply failed"),
    );
  });
});

// ── Command gating ──────────────────────────────────────────────────────────

describe("command gating", () => {
  it("drops group message when command gate blocks unauthorized control command", async () => {
    const { resolveControlCommandGate } = await import("openclaw/plugin-sdk/command-auth");
    vi.mocked(resolveControlCommandGate).mockReturnValueOnce({
      shouldBlock: true,
      commandAuthorized: false,
    });

    const runtime = installRuntime({ hasControlCommand: true });

    await handleVkInbound({
      message: makeMessage({
        peerId: GROUP_PEER_ID,
        senderId: SENDER_ID,
        isGroup: true,
        text: "/admin reset",
      }),
      account: makeAccount({
        config: { dmPolicy: "open", groupPolicy: "open" },
      }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).not.toHaveBeenCalled();
  });

  it("does not block DM messages even when command gate blocks", async () => {
    const { resolveControlCommandGate } = await import("openclaw/plugin-sdk/command-auth");
    vi.mocked(resolveControlCommandGate).mockReturnValueOnce({
      shouldBlock: true,
      commandAuthorized: false,
    });

    const runtime = installRuntime({ hasControlCommand: true });

    await handleVkInbound({
      message: makeMessage({
        senderId: SENDER_ID,
        peerId: SENDER_ID,
        text: "/admin reset",
      }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(
      vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher),
    ).toHaveBeenCalledOnce();
  });
});

describe("step-progress (channels.vk.streaming.mode=progress)", () => {
  it("routes execution steps to the edit-in-place draft and finalizes on the last block", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async ({ dispatcherOptions, replyOptions }: any) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions.onToolStart?.({ name: "Bash" });
        await dispatcherOptions.deliver({ text: "done" }, { kind: "final" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg({ streaming: { mode: "progress" } }),
      runtime: createVkRuntimeEnv(),
    });

    // A draft compositor was created and fed by the execution steps.
    expect(mockCreateProgressCompositor).toHaveBeenCalledTimes(1);
    // The step is rendered from a built line (not undefined) and shown at once.
    expect(mockProgressCompositor.pushToolProgress).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool", name: "Bash" }),
      expect.objectContaining({ toolName: "Bash", startImmediately: true }),
    );
    // The final answer still flows through the normal deliver path…
    expect(mockSendPayloadVk).toHaveBeenCalled();
    // …bracketed by the compositor's finalize signals.
    expect(mockProgressCompositor.markFinalReplyStarted).toHaveBeenCalledTimes(1);
    expect(mockProgressCompositor.markFinalReplyDelivered).toHaveBeenCalledTimes(1);
  });

  it("builds no draft when streaming mode is off (default reactions/plain path)", async () => {
    mockResolveStreamMode.mockReturnValue("off");
    const runtime = installRuntime();

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: baseCfg(),
      runtime: createVkRuntimeEnv(),
    });

    expect(mockCreateProgressCompositor).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("runs reactions AND the step draft together when both are enabled (Telegram parity)", async () => {
    mockResolveStreamMode.mockReturnValue("progress");
    const runtime = installRuntime();
    vi.mocked(runtime.channel.reactions.shouldAckReaction).mockReturnValue(true);
    vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async ({ replyOptions }: any) => {
        await replyOptions.onToolStart?.({ name: "Bash" });
      },
    );

    await handleVkInbound({
      message: makeMessage({ senderId: SENDER_ID, peerId: SENDER_ID, conversationMessageId: 7 }),
      account: makeAccount({ config: { dmPolicy: "open" } }),
      config: {
        ...baseCfg({ streaming: { mode: "progress" } }),
        messages: { statusReactions: { enabled: true }, ackReactionScope: "all" },
      } as CoreConfig,
      runtime: createVkRuntimeEnv(),
    });

    // Both controllers exist and the single onToolStart fans out to each.
    expect(mockCreateProgressCompositor).toHaveBeenCalledTimes(1);
    expect(mockStatusReactionCtrl.setTool).toHaveBeenCalledWith("Bash");
    expect(mockProgressCompositor.pushToolProgress).toHaveBeenCalledWith(
      expect.objectContaining({ event: "tool", name: "Bash" }),
      expect.objectContaining({ toolName: "Bash", startImmediately: true }),
    );
  });
});
