import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStallWatchdog } from "./stall-watchdog.js";

describe("createStallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function make(overrides: Partial<Parameters<typeof createStallWatchdog>[0]> = {}) {
    const onTimeout = vi.fn();
    const watchdog = createStallWatchdog({
      label: "test",
      timeoutMs: 1_000,
      checkIntervalMs: 100,
      onTimeout,
      ...overrides,
    });
    return { watchdog, onTimeout };
  }

  it("stays quiet until armed, because silence during startup is expected", () => {
    const { watchdog, onTimeout } = make();
    vi.advanceTimersByTime(5_000);
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("fires once the transport goes silent past the timeout", () => {
    const { watchdog, onTimeout } = make();
    watchdog.arm();
    vi.advanceTimersByTime(1_100);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout.mock.calls[0][0].idleMs).toBeGreaterThanOrEqual(1_000);
    watchdog.stop();
  });

  it("does not fire while activity keeps arriving", () => {
    const { watchdog, onTimeout } = make();
    watchdog.arm();
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(500);
      watchdog.touch();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("fires only once — the handler ends the account task, a repeat is wasted work", () => {
    const { watchdog, onTimeout } = make();
    watchdog.arm();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).toHaveBeenCalledOnce();
    watchdog.stop();
  });

  it("stops watching after stop()", () => {
    const { watchdog, onTimeout } = make();
    watchdog.arm();
    watchdog.stop();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("stops when the abort signal fires, so a shutdown reports no false stall", () => {
    const controller = new AbortController();
    const { watchdog, onTimeout } = make({ abortSignal: controller.signal });
    watchdog.arm();
    controller.abort();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("survives a throwing handler instead of taking the transport down", () => {
    const error = vi.fn();
    const { watchdog } = make({
      onTimeout: () => {
        throw new Error("handler exploded");
      },
      runtime: { error } as never,
    });
    watchdog.arm();
    expect(() => vi.advanceTimersByTime(1_100)).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stall watchdog handler failed"));
    watchdog.stop();
  });
});
