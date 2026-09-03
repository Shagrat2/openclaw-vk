import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks (for transitive accounts.ts and runtime.ts imports) ────────────

const mockStatusPatches = vi.hoisted(() => [] as unknown[]);
const mockPollingTransport = vi.hoisted(() => ({
  fetchUpdates: vi.fn().mockResolvedValue(undefined),
}));
const mockWatchdog = vi.hoisted(() => ({
  arm: vi.fn(),
  touch: vi.fn(),
  disarm: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/channel-lifecycle", () => ({
  createAccountStatusSink:
    ({ accountId }: { accountId: string }) =>
    (patch: Record<string, unknown>) =>
      mockStatusPatches.push({ accountId, ...patch }),
  createArmableStallWatchdog: vi.fn(() => mockWatchdog),
  waitUntilAbort: (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  channelReadyPatch: (extras: Record<string, unknown> = {}) => ({
    lifecycle: "ready",
    ...extras,
  }),
  channelStoppedPatch: (extras: Record<string, unknown> = {}) => ({
    lifecycle: "stopped",
    ...extras,
  }),
  createTransportActivityStatusPatch: (at?: number) => ({
    lastTransportActivityAt: at ?? Date.now(),
  }),
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactIdentifier: (value?: string) => `sha256:${String(value ?? "-").length}`,
  redactSensitiveText: (text: string) => text,
}));

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
      setRuntime: (r: unknown) => { runtime = r; },
      getRuntime: () => {
        if (!runtime) throw new Error(errorMsg);
        return runtime;
      },
    };
  },
}));

import {
  combineVkInboundMessages,
  monitorVkProvider,
  resolveSerializeInbound,
} from "./monitor.js";
import { createArmableStallWatchdog } from "openclaw/plugin-sdk/channel-lifecycle";
import { VK } from "vk-io";
import { setVkRuntime } from "./runtime.js";
import {
  createVkRuntimeEnv,
  makeMessage,
  makeVkRuntime,
} from "./test-helpers.js";
import type { CoreConfig } from "./types.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockUpdatesStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdatesStartPolling = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockUpdatesStop = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdatesOn = vi.hoisted(() => vi.fn());

const mockGroupsGetById = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] }),
);
const mockGroupsGetLongPollServer = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ server: "lp.vk.com", key: "abc", ts: 1 }),
);

vi.mock("vk-io", () => ({
  // Must use a regular function (not an arrow) so `new VK(...)` works.
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        groups: {
          getById: mockGroupsGetById,
          getLongPollServer: mockGroupsGetLongPollServer,
        },
      },
      updates: {
        start: mockUpdatesStart,
        startPolling: mockUpdatesStartPolling,
        stop: mockUpdatesStop,
        on: mockUpdatesOn,
        use: vi.fn(),
        // Через него снимается сигнал живости: обёртка вокруг fetchUpdates.
        pollingTransport: mockPollingTransport,
      },
    };
  }),
}));

const mockHandleVkInbound = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("./inbound.js", () => ({ handleVkInbound: mockHandleVkInbound }));

const mockPrimeVkGroupId = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ primeVkGroupId: mockPrimeVkGroupId }));

const mockCoreAtLeast = vi.hoisted(() => vi.fn(() => true));
vi.mock("./sdk-compat.js", () => ({
  coreAtLeast: mockCoreAtLeast,
  loadCoreBridge: async (core: any) => ({
    loadConfig: () => core.config.loadConfig(),
    resolveStorePath: (...a: any[]) => core.channel.session.resolveStorePath(...a),
    readSessionUpdatedAt: (...a: any[]) => core.channel.session.readSessionUpdatedAt(...a),
    recordInboundSession: (...a: any[]) => core.channel.session.recordInboundSession(...a),
    dispatchReplyWithBufferedBlockDispatcher: (...a: any[]) =>
      core.channel.reply.dispatchReplyWithBufferedBlockDispatcher(...a),
    finalizeInboundContext: (...a: any[]) => core.channel.reply.finalizeInboundContext(...a),
    formatAgentEnvelope: (...a: any[]) => core.channel.reply.formatAgentEnvelope(...a),
    resolveEnvelopeFormatOptions: (...a: any[]) =>
      core.channel.reply.resolveEnvelopeFormatOptions(...a),
    hasControlCommand: (...a: any[]) => core.channel.text.hasControlCommand(...a),
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Даёт стартовой части монитора добежать до ожидания сигнала остановки. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function baseCfg(): CoreConfig {
  return { channels: { vk: { token: "test-token" } } };
}

/**
 * Start the monitor in the background with an AbortController.
 * monitorVkProvider hangs at waitForAbort() until the signal fires,
 * so we never await it directly — we flush microtasks to let setup complete,
 * then abort to clean up.
 */
function startMonitor(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const promise = monitorVkProvider({
    token: "test-token",
    accountId: "default",
    config: baseCfg(),
    runtime: createVkRuntimeEnv(),
    abortSignal: controller.signal,
    ...overrides,
  } as Parameters<typeof monitorVkProvider>[0]);

  return { promise, controller };
}

/** Drain microtask queue so mocked async operations (start, canUseBotsLongPoll) complete. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Retrieve the handler registered for `message_new` via `vk.updates.on`. */
function getMessageHandler(): (ctx: Record<string, unknown>) => Promise<void> {
  const call = mockUpdatesOn.mock.calls.find(([event]) => event === "message_new");
  if (!call) {
    throw new Error("message_new handler was not registered");
  }
  return call[1] as (ctx: Record<string, unknown>) => Promise<void>;
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    peerId: 555_000,
    senderId: 555_000,
    text: "hello",
    messagePayload: undefined,
    createdAt: 1_700_000_000,
    isOutbox: false,
    ...overrides,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let activeMonitor: { promise: Promise<void>; controller: AbortController } | undefined;

beforeEach(() => {
  mockUpdatesStart.mockReset().mockResolvedValue(undefined);
  mockUpdatesStartPolling.mockReset().mockResolvedValue(undefined);
  mockUpdatesStop.mockReset().mockResolvedValue(undefined);
  mockUpdatesOn.mockReset();
  mockGroupsGetById
    .mockReset()
    .mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] });
  mockGroupsGetLongPollServer
    .mockReset()
    .mockResolvedValue({ server: "lp.vk.com", key: "abc", ts: 1 });
  mockHandleVkInbound.mockReset().mockResolvedValue(undefined);
  mockPrimeVkGroupId.mockReset();
  setVkRuntime(makeVkRuntime());
});

afterEach(async () => {
  if (activeMonitor) {
    activeMonitor.controller.abort();
    await activeMonitor.promise.catch(() => {});
    activeMonitor = undefined;
  }
});

// ── Long Poll mode selection ──────────────────────────────────────────────────

describe("Long Poll mode selection", () => {
  it("uses Bots Long Poll when groups.getLongPollServer succeeds", async () => {
    activeMonitor = startMonitor();
    await flush();

    expect(mockGroupsGetById).toHaveBeenCalled();
    expect(mockPrimeVkGroupId).toHaveBeenCalledWith("test-token", 12345678);
    expect(mockGroupsGetLongPollServer).toHaveBeenCalledWith({
      group_id: 12345678,
    });
    expect(mockUpdatesStart).toHaveBeenCalledOnce();
    expect(mockUpdatesStartPolling).not.toHaveBeenCalled();
  });

  it("falls back to User Long Poll when getLongPollServer throws", async () => {
    mockGroupsGetLongPollServer.mockRejectedValueOnce(
      new Error("Access denied: no access to call this method"),
    );

    activeMonitor = startMonitor();
    await flush();

    expect(mockPrimeVkGroupId).toHaveBeenCalledWith("test-token", 12345678);
    expect(mockUpdatesStart).not.toHaveBeenCalled();
    expect(mockUpdatesStartPolling).toHaveBeenCalledOnce();
  });

  it("falls back to User Long Poll when groups array is empty", async () => {
    mockGroupsGetById.mockResolvedValueOnce({ groups: [] });

    activeMonitor = startMonitor();
    await flush();

    expect(mockUpdatesStart).not.toHaveBeenCalled();
    expect(mockUpdatesStartPolling).toHaveBeenCalledOnce();
  });

  it("falls back to User Long Poll when getById throws", async () => {
    mockGroupsGetById.mockRejectedValueOnce(new Error("network error"));

    activeMonitor = startMonitor();
    await flush();

    expect(mockUpdatesStart).not.toHaveBeenCalled();
    expect(mockUpdatesStartPolling).toHaveBeenCalledOnce();
  });
});

// ── Abort signal & stop ───────────────────────────────────────────────────────

describe("stop/abort", () => {
  it("abort signal calls updates.stop()", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    expect(mockUpdatesStop).not.toHaveBeenCalled();
    controller.abort();
    await promise;

    expect(mockUpdatesStop).toHaveBeenCalledOnce();
  });

  it("does not call stop twice on repeated abort", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    controller.abort();
    await promise;

    // The finally block already called stopUpdates; a second abort should be a no-op.
    expect(mockUpdatesStop).toHaveBeenCalledOnce();
  });
});

// ── message_new handler ───────────────────────────────────────────────────────

describe("message_new handler", () => {
  it("registers a message_new event handler", async () => {
    activeMonitor = startMonitor();
    await flush();

    const events = mockUpdatesOn.mock.calls.map(([event]) => event);
    expect(events).toContain("message_new");
  });

  it("calls handleVkInbound with correct payload on incoming message", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({
        id: 99,
        peerId: 123_456,
        senderId: 555_000,
        text: "hi",
        messagePayload: { oc: "/models anthropic" },
      }),
    );

    expect(mockHandleVkInbound).toHaveBeenCalledOnce();
    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message).toMatchObject({
      messageId: "99",
      peerId: 123_456,
      senderId: 555_000,
      text: "hi",
      isGroup: false,
      messagePayload: { oc: "/models anthropic" },
      timestamp: 1_700_000_000_000,
    });
  });

  it("propagates attachments, reply context, and VK timestamps", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({
        id: 100,
        createdAt: 1_700_000_123,
        attachments: [{ type: "photo", largeSizeUrl: "https://example.com/photo.png" }],
        replyMessage: { id: 7, text: "quoted" },
      }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message).toMatchObject({
      timestamp: 1_700_000_123_000,
      attachments: [
        {
          type: "photo",
          kind: "image",
          url: "https://example.com/photo.png",
        },
      ],
      replyToMessageId: "7",
      replyToText: "quoted",
    });
  });

  it("normalizes vk-io style document image attachments from preview photos", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({
        attachments: [
          {
            get type() {
              return "doc";
            },
            get isImage() {
              return true;
            },
            get ext() {
              return "heic";
            },
            get preview() {
              return {
                photo: [{ url: "https://example.com/phone-photo-preview" }],
              };
            },
          },
        ],
      }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.attachments).toEqual([
      {
        type: "doc",
        kind: "image",
        url: "https://example.com/phone-photo-preview",
        title: undefined,
        mimeType: "image/heic",
      },
    ]);
  });

  it("sets isGroup=true for group chat peer IDs (>= 2_000_000_000)", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({ peerId: 2_000_000_001, senderId: 555_000 }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.isGroup).toBe(true);
  });

  it("skips outbox messages", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(makeCtx({ isOutbox: true }));

    expect(mockHandleVkInbound).not.toHaveBeenCalled();
  });

  it("coerces missing text to empty string", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(makeCtx({ text: undefined }));

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.text).toBe("");
  });

  it("records inbound activity before dispatching", async () => {
    const core = makeVkRuntime();
    setVkRuntime(core);

    activeMonitor = startMonitor();
    await flush();
    await getMessageHandler()(makeCtx());

    expect(vi.mocked(core.channel.activity.record)).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "vk", direction: "inbound" }),
    );
  });

  it("does not dispatch messages after abort", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    controller.abort();
    await promise;

    await getMessageHandler()(makeCtx());

    expect(mockHandleVkInbound).not.toHaveBeenCalled();
  });

  it("catches and logs handler errors without propagating", async () => {
    const runtime = createVkRuntimeEnv();
    const errorSpy = vi.spyOn(runtime, "error").mockImplementation(() => {});

    mockHandleVkInbound.mockRejectedValueOnce(new Error("dispatch failed"));

    activeMonitor = startMonitor({ runtime });
    await flush();

    // Should not throw
    await getMessageHandler()(makeCtx({ peerId: 999 }));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("dispatch failed"),
    );
  });

  it("routes each message through the inbound debouncer", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(makeCtx({ peerId: 777, text: "hi" }));

    // The immediate-flush stub calls onFlush([msg]) → handleVkInbound once.
    expect(mockHandleVkInbound).toHaveBeenCalledTimes(1);
    expect(mockHandleVkInbound.mock.calls[0][0].message.text).toBe("hi");
  });

  it("falls back to Date.now() when createdAt is missing", async () => {
    activeMonitor = startMonitor();
    await flush();

    const before = Date.now();
    await getMessageHandler()(makeCtx({ createdAt: undefined }));
    const after = Date.now();

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });

  it("falls back to Date.now() when createdAt is NaN", async () => {
    activeMonitor = startMonitor();
    await flush();

    const before = Date.now();
    await getMessageHandler()(makeCtx({ createdAt: NaN }));
    const after = Date.now();

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });

  it("reloads config for each message (gets fresh account state)", async () => {
    const core = makeVkRuntime();
    setVkRuntime(core);

    activeMonitor = startMonitor();
    await flush();
    await getMessageHandler()(makeCtx());

    expect(vi.mocked(core.config.loadConfig)).toHaveBeenCalled();
  });

  it("handles messages without attachments or replyMessage", async () => {
    activeMonitor = startMonitor();
    await flush();

    await getMessageHandler()(
      makeCtx({ attachments: undefined, replyMessage: undefined }),
    );

    const { message } = mockHandleVkInbound.mock.calls[0][0];
    expect(message.attachments).toEqual([]);
    expect(message.replyToMessageId).toBeUndefined();
    expect(message.replyToText).toBeUndefined();
  });
});

describe("combineVkInboundMessages", () => {
  it("returns null for an empty batch", () => {
    expect(combineVkInboundMessages([])).toBeNull();
  });

  it("returns the single message unchanged", () => {
    const msg = makeMessage({ messageId: "m1", text: "solo" });
    expect(combineVkInboundMessages([msg])).toBe(msg);
  });

  it("merges texts and keeps the last message's identity", () => {
    const combined = combineVkInboundMessages([
      makeMessage({ messageId: "m1", text: "first", timestamp: 1000 }),
      makeMessage({ messageId: "m2", text: "second", timestamp: 2000 }),
      makeMessage({ messageId: "m3", text: "third", timestamp: 3000 }),
    ]);
    expect(combined?.text).toBe("first\nsecond\nthird");
    // Reply/react target = latest message.
    expect(combined?.messageId).toBe("m3");
    expect(combined?.timestamp).toBe(3000);
  });

  it("skips empty texts when merging", () => {
    const combined = combineVkInboundMessages([
      makeMessage({ messageId: "m1", text: "a" }),
      makeMessage({ messageId: "m2", text: "" }),
      makeMessage({ messageId: "m3", text: "b" }),
    ]);
    expect(combined?.text).toBe("a\nb");
  });
});

// ── Watchdog liveness policy (end-to-end over the supervision loop) ──────────
//
// The unit tests above cover how the cursor is READ; these cover what the
// watchdog DOES with it. That distinction matters: the policy was rewritten
// after an upstream audit (a static cursor used to imply a restart, which would
// tear down perfectly healthy idle channels), and nothing guarded the new
// state transitions — a regression there is invisible until VK ingress either
// dies silently or flaps in production.
describe("monitorVkProvider — состояние канала для ядра", () => {
  beforeEach(() => {
    mockStatusPatches.length = 0;
    mockWatchdog.arm.mockClear();
    mockWatchdog.touch.mockClear();
    mockPollingTransport.fetchUpdates = vi.fn().mockResolvedValue(undefined);
    delete (mockPollingTransport as Record<string, unknown>).__vkPollInstrumented;
  });

  it("сообщает о готовности с отметкой активности транспорта", async () => {
    const setStatus = vi.fn();
    const { promise, controller } = startMonitor({ setStatus });
    await flushMicrotasks();

    const ready = mockStatusPatches.find(
      (p) => (p as { lifecycle?: string }).lifecycle === "ready",
    ) as Record<string, unknown> | undefined;
    expect(ready).toBeDefined();
    expect(ready?.mode).toBe("longpoll");
    expect(typeof ready?.lastTransportActivityAt).toBe("number");
    expect(mockWatchdog.arm).toHaveBeenCalledTimes(1);

    controller.abort();
    await promise;
  });

  it("считает живым каждый завершённый опрос, включая пустой", async () => {
    const setStatus = vi.fn();
    const { promise, controller } = startMonitor({ setStatus });
    await flushMicrotasks();
    mockStatusPatches.length = 0;
    mockWatchdog.touch.mockClear();

    // Пустой ответ long-poll — событий нет, но запрос завершился.
    await mockPollingTransport.fetchUpdates();

    expect(mockWatchdog.touch).toHaveBeenCalledTimes(1);
    expect(mockStatusPatches.at(-1)).toMatchObject({
      lastTransportActivityAt: expect.any(Number),
    });

    controller.abort();
    await promise;
  });

  it("на залипшем транспорте сообщает разрыв и завершает задачу, а не перезапускается сам", async () => {
    const setStatus = vi.fn();
    const { promise, controller } = startMonitor({ setStatus });
    await flushMicrotasks();

    // Сторож тишины сработал: имитируем его вызов.
    const onTimeout = vi.mocked(createArmableStallWatchdog).mock.calls.at(-1)?.[0]
      ?.onTimeout as ((info: { idleMs: number }) => void) | undefined;
    expect(onTimeout).toBeTypeOf("function");
    onTimeout?.({ idleMs: 150_000 });

    await promise; // задача аккаунта завершилась сама — рестарт делает ядро

    const stopped = mockStatusPatches.find(
      (p) => (p as { lifecycle?: string }).lifecycle === "stopped",
    ) as Record<string, unknown> | undefined;
    expect(stopped).toBeDefined();
    expect(String(stopped?.lastError)).toContain("no completed long-poll request");
    expect(stopped?.lastDisconnect).toMatchObject({ at: expect.any(Number) });
    controller.abort();
  });
});

describe("resolveSerializeInbound", () => {
  afterEach(() => {
    delete process.env.VK_SERIALIZE_INBOUND;
    mockCoreAtLeast.mockReturnValue(true);
  });

  it("на свежем ядре не сериализует: дедлок mirror-transcript исправлен нативно", () => {
    mockCoreAtLeast.mockReturnValue(true);
    expect(resolveSerializeInbound()).toBe(false);
  });

  it("на старом ядре включает сериализацию сама — обход там ещё нужен", () => {
    mockCoreAtLeast.mockReturnValue(false);
    expect(resolveSerializeInbound()).toBe(true);
  });

  it("явный флаг перебивает автоопределение в обе стороны", () => {
    mockCoreAtLeast.mockReturnValue(true);
    process.env.VK_SERIALIZE_INBOUND = "true";
    expect(resolveSerializeInbound()).toBe(true);

    mockCoreAtLeast.mockReturnValue(false);
    process.env.VK_SERIALIZE_INBOUND = "false";
    expect(resolveSerializeInbound()).toBe(false);
  });
});
