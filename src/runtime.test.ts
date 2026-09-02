import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { readVkRuntimeConfig } from "./runtime.js";

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: () => ({
    setRuntime: vi.fn(),
    getRuntime: vi.fn(),
  }),
}));

describe("readVkRuntimeConfig", () => {
  it("uses the current OpenClaw config API", () => {
    const expected = { channels: { vk: { enabled: true } } };
    const current = vi.fn().mockReturnValue(expected);
    const runtime = { config: { current } } as unknown as PluginRuntime;

    expect(readVkRuntimeConfig(runtime)).toBe(expected);
    expect(current).toHaveBeenCalledOnce();
  });

  it("fails clearly instead of using the removed legacy config API", () => {
    const loadConfig = vi.fn();
    const runtime = { config: { loadConfig } } as unknown as PluginRuntime;

    expect(() => readVkRuntimeConfig(runtime)).toThrow(
      "OpenClaw runtime does not expose config.current()",
    );
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
