import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks (for transitive accounts.ts and runtime.ts imports) ────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/account-id", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  channelReadyPatch: (extras: Record<string, unknown> = {}) => ({
    running: true,
    connected: true,
    lifecycle: "ready",
    lastConnectedAt: Date.now(),
    lastError: null,
    terminalDisconnect: undefined,
    ...extras,
  }),
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

import { monitorVkProvider } from "./monitor.js";
import { setVkRuntime } from "./runtime.js";
import {
  createVkRuntimeEnv,
  makeVkRuntime,
} from "./test-helpers.js";
import type { CoreConfig } from "./types.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockPollingTransportOptions = vi.hoisted(() => vi.fn());
const mockPollingTransportStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPollingTransportStop = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPollingTransportFetch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPollingTransportSubscribe = vi.hoisted(() => vi.fn());
const mockPollingTransportInstances = vi.hoisted(() => [] as Array<{ fetchUpdates: () => Promise<void> }>);
const mockFirstLongPollFetch = vi.hoisted(() => vi.fn());
const mockUpdatesOn = vi.hoisted(() => vi.fn());
const mockHandleWebhookUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockHandlePollingUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockGroupsGetById = vi.hoisted(() =>
  vi
    .fn()
    .mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] }),
);
const mockGroupsGetLongPollServer = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ server: "lp.vk.com", key: "abc", ts: 1 }),
);

vi.mock("vk-io", () => {
  class PollingTransport {
    started = false;
    pollingHandler: ((update: unknown[]) => unknown) | undefined;
    protected ts: string | number = "initial-ts";
    protected pts = 0;
    protected restarted = 0;
    protected url = new URL(
      "https://lp.vk.test?key=secret-test-key&act=a_check&wait=25",
    );

    constructor(options: unknown) {
      mockPollingTransportOptions(options);
      mockPollingTransportInstances.push(this);
    }

    async start() {
      this.started = true;
      await mockPollingTransportStart();
      void this.startFetchLoop();
    }

    async stop() {
      this.started = false;
      await mockPollingTransportStop();
    }

    async fetchUpdates() {
      this.url.searchParams.set("ts", String(this.ts));
      await mockPollingTransportFetch(new URL(this.url));
    }

    subscribe(handler: (update: unknown[]) => unknown) {
      this.pollingHandler = handler;
      mockPollingTransportSubscribe(handler);
    }

    protected async startFetchLoop() {
      if (!this.started) {
        return;
      }
      try {
        await this.fetchUpdates();
      } catch {
        if (this.started) {
          void this.startFetchLoop();
        }
      }
    }
  }

  return {
    PollingTransport,
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
          on: mockUpdatesOn,
          handleWebhookUpdate: mockHandleWebhookUpdate,
          handlePollingUpdate: mockHandlePollingUpdate,
        },
      };
    }),
  };
});

const mockHandleVkInbound = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("./inbound.js", () => ({ handleVkInbound: mockHandleVkInbound }));

const mockPrimeVkGroupId = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ primeVkGroupId: mockPrimeVkGroupId }));

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  mockPollingTransportOptions.mockReset();
  mockPollingTransportStart.mockReset().mockResolvedValue(undefined);
  mockPollingTransportStop.mockReset().mockResolvedValue(undefined);
  mockPollingTransportFetch.mockReset().mockResolvedValue(undefined);
  mockPollingTransportSubscribe.mockReset();
  mockPollingTransportInstances.length = 0;
  mockFirstLongPollFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ ts: "next-ts", updates: [] }),
  });
  vi.stubGlobal("fetch", mockFirstLongPollFetch);
  mockUpdatesOn.mockReset();
  mockHandleWebhookUpdate.mockReset().mockResolvedValue(undefined);
  mockHandlePollingUpdate.mockReset().mockResolvedValue(undefined);
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
  vi.unstubAllGlobals();
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
    expect(mockPollingTransportOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        pollingGroupId: 12345678,
        pollingWait: 3_000,
        pollingRetryLimit: 3,
      }),
    );
    expect(mockPollingTransportStart).toHaveBeenCalledOnce();
  });

  it("falls back to User Long Poll when getLongPollServer throws", async () => {
    mockGroupsGetLongPollServer.mockRejectedValueOnce(
      new Error("Access denied: no access to call this method"),
    );

    activeMonitor = startMonitor();
    await flush();

    expect(mockPrimeVkGroupId).toHaveBeenCalledWith("test-token", 12345678);
    expect(mockPollingTransportOptions).toHaveBeenCalledWith(
      expect.not.objectContaining({ pollingGroupId: expect.anything() }),
    );
    expect(mockPollingTransportStart).toHaveBeenCalledOnce();
  });

  it("falls back to User Long Poll when groups array is empty", async () => {
    mockGroupsGetById.mockResolvedValueOnce({ groups: [] });

    activeMonitor = startMonitor();
    await flush();

    expect(mockPollingTransportOptions).toHaveBeenCalledWith(
      expect.not.objectContaining({ pollingGroupId: expect.anything() }),
    );
    expect(mockPollingTransportStart).toHaveBeenCalledOnce();
  });

  it("falls back to User Long Poll when getById throws", async () => {
    mockGroupsGetById.mockRejectedValueOnce(new Error("network error"));

    activeMonitor = startMonitor();
    await flush();

    expect(mockPollingTransportOptions).toHaveBeenCalledWith(
      expect.not.objectContaining({ pollingGroupId: expect.anything() }),
    );
    expect(mockPollingTransportStart).toHaveBeenCalledOnce();
  });
});

// ── Gateway lifecycle status ─────────────────────────────────────────────────

describe("gateway lifecycle status", () => {
  it("publishes a ready and connected snapshot after the first Long Poll succeeds", async () => {
    const setStatus = vi.fn();

    activeMonitor = startMonitor({ setStatus });
    await flush();

    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastTransportActivityAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
      mode: "longpoll",
    });

    const ready = setStatus.mock.calls[0][0];
    expect(ready.lastEventAt).toBeUndefined();
    expect(ready.lastTransportActivityAt).toBe(ready.lastConnectedAt);

    const readinessUrl = mockFirstLongPollFetch.mock.calls[0][0] as URL;
    const normalPollUrl = mockPollingTransportFetch.mock.calls[0][0] as URL;
    expect(readinessUrl.searchParams.get("act")).toBe("a_check");
    expect(readinessUrl.searchParams.get("key")).toBe("secret-test-key");
    expect(readinessUrl.searchParams.get("ts")).toBe("initial-ts");
    expect(readinessUrl.searchParams.get("wait")).toBe("1");
    expect(normalPollUrl.searchParams.get("wait")).toBe("25");
  });

  it("refreshes transport activity after successful empty polls beyond the stale threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T09:00:00Z"));
    const setStatus = vi.fn();

    activeMonitor = startMonitor({ setStatus });
    await flush();
    const connectedAt = setStatus.mock.calls[0][0].lastConnectedAt as number;

    vi.setSystemTime(connectedAt + 31 * 60 * 1000);
    await mockPollingTransportInstances[0].fetchUpdates();

    expect(setStatus).toHaveBeenLastCalledWith({
      lastTransportActivityAt: connectedAt + 31 * 60 * 1000,
    });
    vi.useRealTimers();
  });

  it("propagates startup failure without publishing a false-ready snapshot", async () => {
    const setStatus = vi.fn();
    mockPollingTransportStart.mockRejectedValueOnce(new Error("Long Poll bootstrap failed"));

    const { promise } = startMonitor({ setStatus });

    await expect(promise).rejects.toThrow("Long Poll bootstrap failed");
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does not publish ready when the first real Long Poll request fails", async () => {
    const setStatus = vi.fn();
    mockFirstLongPollFetch.mockRejectedValueOnce(
      new Error("request failed for https://lp.vk.test?key=secret-long-poll-key"),
    );

    const { promise } = startMonitor({ setStatus });

    await expect(promise).rejects.toThrow("VK Long Poll transport check failed");
    expect(setStatus).not.toHaveBeenCalled();
    expect(mockPollingTransportStop).toHaveBeenCalledOnce();
    await expect(promise).rejects.not.toThrow("secret-long-poll-key");
  });

  it("accepts failed=1 as a successful ts refresh before publishing ready", async () => {
    const setStatus = vi.fn();
    mockFirstLongPollFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ failed: 1, ts: "refreshed-ts" }),
    });

    activeMonitor = startMonitor({ setStatus });
    await flush();

    expect(setStatus).toHaveBeenCalledOnce();
    const normalPollUrl = mockPollingTransportFetch.mock.calls[0][0] as URL;
    expect(normalPollUrl.searchParams.get("ts")).toBe("refreshed-ts");
    expect(normalPollUrl.searchParams.get("wait")).toBe("25");
  });

  it("dispatches Bots LP updates returned by the readiness poll through VK middleware", async () => {
    const update = { type: "message_new", group_id: 12345678 };
    mockFirstLongPollFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ts: "next-ts", updates: [update] }),
    });

    activeMonitor = startMonitor();
    await flush();

    expect(mockHandleWebhookUpdate).toHaveBeenCalledWith(update);
    expect(mockHandlePollingUpdate).not.toHaveBeenCalled();
  });

  it("dispatches User LP updates returned by the readiness poll through VK middleware", async () => {
    const update = [4, 99, 0, 123, 1_700_000_000, "message"];
    mockGroupsGetLongPollServer.mockRejectedValueOnce(new Error("Access denied"));
    mockFirstLongPollFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ts: "next-ts", updates: [update] }),
    });

    activeMonitor = startMonitor();
    await flush();

    expect(mockHandlePollingUpdate).toHaveBeenCalledWith(update);
    expect(mockHandleWebhookUpdate).not.toHaveBeenCalled();
  });

  it("retains vk-io retry handling after a post-ready poll failure", async () => {
    const setStatus = vi.fn();
    mockPollingTransportFetch
      .mockRejectedValueOnce(new Error("post-ready transport failure"))
      .mockResolvedValueOnce(undefined);

    activeMonitor = startMonitor({ setStatus });
    await flush();

    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenLastCalledWith({
      lastTransportActivityAt: expect.any(Number),
    });
    expect(mockFirstLongPollFetch).toHaveBeenCalledOnce();
    expect(mockPollingTransportFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung readiness poll promptly without publishing ready", async () => {
    const setStatus = vi.fn();
    let firstPollSignal: AbortSignal | undefined;
    mockFirstLongPollFetch.mockImplementationOnce(
      (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
        firstPollSignal = init.signal ?? undefined;
        firstPollSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      }),
    );

    const { promise, controller } = startMonitor({ setStatus });
    await flush();
    expect(firstPollSignal?.aborted).toBe(false);

    controller.abort();
    await promise;

    expect(firstPollSignal?.aborted).toBe(true);
    expect(mockPollingTransportStop).toHaveBeenCalledOnce();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("stops a transport that finishes starting after an abort and never marks it ready", async () => {
    const setStatus = vi.fn();
    let finishStart!: () => void;
    mockPollingTransportStart.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishStart = resolve;
      }),
    );

    const { promise, controller } = startMonitor({ setStatus });
    await flush();
    expect(mockPollingTransportStart).toHaveBeenCalledOnce();

    controller.abort();
    await flush();
    expect(mockPollingTransportStop).not.toHaveBeenCalled();

    finishStart();
    await promise;

    expect(mockPollingTransportStop).toHaveBeenCalledOnce();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

// ── Abort signal & stop ───────────────────────────────────────────────────────

describe("stop/abort", () => {
  it("abort signal stops the active polling transport", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    expect(mockPollingTransportStop).not.toHaveBeenCalled();
    controller.abort();
    await promise;

    expect(mockPollingTransportStop).toHaveBeenCalledOnce();
  });

  it("does not call stop twice on repeated abort", async () => {
    const { promise, controller } = startMonitor();
    await flush();

    controller.abort();
    await promise;

    // The finally block already called stopUpdates; a second abort should be a no-op.
    expect(mockPollingTransportStop).toHaveBeenCalledOnce();
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

    expect(vi.mocked(core.config.current)).toHaveBeenCalled();
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
