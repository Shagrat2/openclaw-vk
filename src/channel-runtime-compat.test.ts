import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unmock("openclaw/plugin-sdk/channel-runtime");
  vi.unmock("openclaw/plugin-sdk");
});

describe("loadChannelRuntimeCompat", () => {
  it("uses channel-runtime when the scoped entrypoint is available", async () => {
    const createReplyPrefixOptions = vi.fn(() => ({
      responsePrefixContextProvider: () => ({}),
      onModelSelected: () => {},
    }));
    const createTypingCallbacks = vi.fn(() => ({
      onReplyStart: async () => {},
    }));
    const logTypingFailure = vi.fn();

    vi.doMock("openclaw/plugin-sdk/channel-runtime", () => ({
      createReplyPrefixOptions,
      createTypingCallbacks,
      logTypingFailure,
    }));
    vi.doMock("openclaw/plugin-sdk", () => ({
      createReplyPrefixOptions: vi.fn(),
      createTypingCallbacks: vi.fn(),
      logTypingFailure: vi.fn(),
    }));

    const { loadChannelRuntimeCompat } = await import("./channel-runtime-compat.js");
    const runtime = await loadChannelRuntimeCompat();

    runtime.createReplyPrefixOptions({ cfg: {}, agentId: "main", channel: "vk", accountId: "a" });

    expect(createReplyPrefixOptions).toHaveBeenCalledOnce();
  });

  it("falls back to the monolithic plugin-sdk when channel-runtime is unavailable", async () => {
    const fallbackCreateReplyPrefixOptions = vi.fn(() => ({
      responsePrefixContextProvider: () => ({}),
      onModelSelected: () => {},
    }));
    const fallbackCreateTypingCallbacks = vi.fn(() => ({
      onReplyStart: async () => {},
    }));
    const fallbackLogTypingFailure = vi.fn();

    vi.doMock("openclaw/plugin-sdk/channel-runtime", () => {
      throw new Error("Cannot find module openclaw/plugin-sdk/channel-runtime");
    });
    vi.doMock("openclaw/plugin-sdk", () => ({
      createReplyPrefixOptions: fallbackCreateReplyPrefixOptions,
      createTypingCallbacks: fallbackCreateTypingCallbacks,
      logTypingFailure: fallbackLogTypingFailure,
    }));

    const { loadChannelRuntimeCompat } = await import("./channel-runtime-compat.js");
    const runtime = await loadChannelRuntimeCompat();

    runtime.createTypingCallbacks({
      start: async () => {},
      onStartError: () => {},
    });

    expect(fallbackCreateTypingCallbacks).toHaveBeenCalledOnce();
  });

  it("synthesizes logTypingFailure when channel-runtime omits it", async () => {
    const createReplyPrefixOptions = vi.fn(() => ({
      responsePrefixContextProvider: () => ({}),
      onModelSelected: () => {},
    }));
    const createTypingCallbacks = vi.fn(() => ({
      onReplyStart: async () => {},
    }));
    const fallbackCreateTypingCallbacks = vi.fn();
    const log = vi.fn();

    vi.doMock("openclaw/plugin-sdk/channel-runtime", () => ({
      createReplyPrefixOptions,
      createTypingCallbacks,
    }));
    vi.doMock("openclaw/plugin-sdk", () => ({
      createReplyPrefixOptions: vi.fn(),
      createTypingCallbacks: fallbackCreateTypingCallbacks,
    }));

    const { loadChannelRuntimeCompat } = await import("./channel-runtime-compat.js");
    const runtime = await loadChannelRuntimeCompat();

    runtime.logTypingFailure({
      log,
      channel: "vk",
      target: "123",
      error: new Error("boom"),
    });

    expect(createTypingCallbacks).not.toHaveBeenCalled();
    expect(fallbackCreateTypingCallbacks).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("vk: typing failed for target=123: Error: boom"),
    );
  });
});
