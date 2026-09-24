import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The step draft through the REAL core: `channel-outbound` (compositor, stream
 * mode, `isPotentialTruncatedFinal` / `selectLongerFinalText`), `reply-payload`,
 * the real `progress-draft.ts` and the real markdown renderer. Only the VK API
 * (`send.js`) and the agent run itself are replaced.
 *
 * `inbound.test.ts` mocks the whole core surface, and one of its mocks —
 * "the longest text wins" for `selectLongerFinalText` — is what kept the empty
 * final deleting the answer invisible: the real function returns nothing for
 * an empty final. Every property here is asserted on what the recipient ends
 * up seeing in the chat, not on which helper was called.
 *
 * The `openclaw` peer is optional, so this file skips itself where it is not
 * installed (CI's test job, `check:test-isolation`).
 */
const CHANNEL_OUTBOUND = "openclaw/plugin-sdk/channel-outbound";
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve(CHANNEL_OUTBOUND);
    return true;
  } catch {
    return false;
  }
})();

// ── A VK chat the tests can read back ────────────────────────────────────────

type ChatMessage = {
  id: number;
  text: string;
  media: string[];
  formatData?: unknown;
};

const chat = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  nextId: 100,
  sendMessageCalls: 0,
  /** Fail every sendMessageVk call from this index on (0-based), or never. */
  failSendMessageFrom: null as number | null,
  failSendPayload: false,
  payloadCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("./send.js", () => ({
  sendMessageVk: vi.fn(async (to: string, text: string) => {
    const index = chat.sendMessageCalls++;
    if (chat.failSendMessageFrom !== null && index >= chat.failSendMessageFrom) {
      throw new Error("VK API error 10: internal server error");
    }
    const id = chat.nextId++;
    chat.messages.push({ id, text, media: [] });
    return { messageId: String(id), chatId: to };
  }),
  editMessageVk: vi.fn(
    async (_to: string, id: number, text: string, _account: unknown, opts?: { formatData?: unknown }) => {
      const message = chat.messages.find((m) => m.id === id);
      if (!message) {
        return false;
      }
      message.text = text;
      message.formatData = opts?.formatData;
      return true;
    },
  ),
  deleteMessageVk: vi.fn(async (_to: string, id: number) => {
    chat.messages = chat.messages.filter((m) => m.id !== id);
  }),
  sendPayloadVk: vi.fn(async (to: string, payload: Record<string, unknown>) => {
    chat.payloadCalls.push(payload);
    if (chat.failSendPayload) {
      throw new Error("VK API error 10: upload failed");
    }
    const id = chat.nextId++;
    const media = [
      ...(typeof payload.mediaUrl === "string" ? [payload.mediaUrl] : []),
      ...((payload.mediaUrls as string[] | undefined) ?? []),
    ];
    chat.messages.push({ id, text: String(payload.text ?? ""), media });
    return { messageId: String(id), chatId: to };
  }),
  markMessageReadVk: vi.fn(async () => undefined),
  sendTypingVk: vi.fn(async () => undefined),
  resolveVkOwnGroup: vi.fn(async () => ({ id: 239104331, name: "Карамелька" })),
  clearVkInstances: vi.fn(),
}));

// ── The agent run: each test scripts what the core delivers ─────────────────

type Scenario = (args: {
  dispatcherOptions: {
    deliver: (payload: unknown, info?: { kind?: string }) => Promise<void>;
  };
  replyOptions: {
    onToolStart?: (payload: Record<string, unknown>) => Promise<void>;
  };
}) => Promise<void>;

const run = vi.hoisted(() => ({ scenario: null as Scenario | null }));

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  dispatchReplyWithBufferedBlockDispatcher: async (args: Parameters<Scenario>[0]) => {
    await run.scenario?.(args);
  },
  finalizeInboundContext: (ctx: unknown) => ctx,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveStorePath: () => "/tmp/vk-draft-sdk-test-sessions",
  readSessionUpdatedAt: () => undefined,
  recordSessionMetaFromInbound: async () => undefined,
}));

const inbound: typeof import("./inbound.js") | null = sdkInstalled
  ? await import("./inbound.js")
  : null;
const runtimeModule: typeof import("./runtime.js") | null = sdkInstalled
  ? await import("./runtime.js")
  : null;
const helpers: typeof import("./test-helpers.js") | null = sdkInstalled
  ? await import("./test-helpers.js")
  : null;

const LABEL = "⏳ Работаю";

function progressCfg() {
  return {
    channels: {
      vk: {
        token: "tok",
        dmPolicy: "open",
        allowFrom: ["*"],
        streaming: { mode: "progress", progress: { label: LABEL, toolProgress: true } },
      },
    },
  };
}

async function runTurn(scenario: Scenario): Promise<void> {
  run.scenario = scenario;
  const cfg = progressCfg();
  await inbound!.handleVkInbound({
    message: helpers!.makeMessage({ conversationMessageId: 42, text: "сделай" }),
    account: helpers!.makeAccount({ config: { dmPolicy: "open", allowFrom: ["*"] } }),
    config: cfg as never,
    runtime: helpers!.createVkRuntimeEnv(),
  });
}

const toolStart = (name = "exec") => ({
  name,
  phase: "start",
  toolCallId: `call-${name}`,
  args: { command: "ls" },
});

const texts = () => chat.messages.map((m) => m.text);
const voice = { mediaUrl: "file:///tmp/answer.opus", audioAsVoice: true };

describe.skipIf(!inbound || !runtimeModule || !helpers)("step draft through the real core", () => {
  beforeEach(() => {
    chat.messages = [];
    chat.nextId = 100;
    chat.sendMessageCalls = 0;
    chat.failSendMessageFrom = null;
    chat.failSendPayload = false;
    chat.payloadCalls = [];
    run.scenario = null;
    runtimeModule!.setVkRuntime(helpers!.makeVkRuntime());
  });

  it("shows the tool step in the draft (sanity: the real compositor is wired)", async () => {
    let seen: string[] = [];
    await runTurn(async ({ replyOptions, dispatcherOptions }) => {
      await replyOptions.onToolStart?.(toolStart());
      seen = texts();
      await dispatcherOptions.deliver({ text: "Готово." }, { kind: "final" });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith(LABEL)).toBe(true);
    expect(texts()).toEqual(["Готово."]);
  });

  // ── P1-1: an empty final must not delete the answer that is in the draft ──

  describe("empty final after the answer went into the draft as blocks", () => {
    const ANSWER = "Готово: проверил каталог, там три файла, всё на месте.";

    for (const [name, final] of [
      ["empty text", { text: "", ...voice }],
      ["no text at all", { ...voice }],
    ] as const) {
      it(`keeps the answer when the final carries ${name} and a voice note`, async () => {
        await runTurn(async ({ replyOptions, dispatcherOptions }) => {
          await replyOptions.onToolStart?.(toolStart());
          await dispatcherOptions.deliver({ text: ANSWER }, { kind: "block" });
          await dispatcherOptions.deliver(final, { kind: "final" });
        });
        expect(chat.messages.map((m) => m.text)).toContain(ANSWER);
        // The answer is final now: no "working" header left on it.
        expect(texts().some((t) => t.includes(LABEL))).toBe(false);
        expect(chat.messages.some((m) => m.media.includes(voice.mediaUrl))).toBe(true);
      });
    }

    it("still drops a draft that holds only steps when the final is empty", async () => {
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: "", ...voice }, { kind: "final" });
      });
      expect(texts().some((t) => t.includes(LABEL))).toBe(false);
      expect(chat.messages).toHaveLength(1);
      expect(chat.messages[0]?.media).toEqual([voice.mediaUrl]);
    });

    it("keeps the fuller draft when a non-empty final arrives truncated", async () => {
      const full =
        "Проверил все три сервера по очереди и сравнил их журналы за последние сутки, " +
        "расхождений нет, резервные копии свежие и читаются без ошибок.";
      const truncated = `${full.slice(0, 60)}…`;
      await runTurn(async ({ replyOptions, dispatcherOptions }) => {
        await replyOptions.onToolStart?.(toolStart());
        await dispatcherOptions.deliver({ text: full }, { kind: "block" });
        await dispatcherOptions.deliver({ text: truncated }, { kind: "final" });
      });
      expect(texts()).toContain(full);
      expect(texts()).not.toContain(truncated);
      expect(texts().some((t) => t.includes(LABEL))).toBe(false);
    });
  });

});
