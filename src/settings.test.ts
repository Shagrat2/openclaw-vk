import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `openclaw` peer is optional and absent in CI's unit-test job, so every SDK
// subpath a module under test imports has to be mocked — including the ones it
// reaches transitively, here through `settings.ts`.
vi.mock("openclaw/plugin-sdk/core", () => ({
  parseStrictPositiveInteger: (value: unknown) => {
    const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
    if (!/^\d+$/.test(raw.trim())) return undefined;
    const parsed = Number.parseInt(raw.trim(), 10);
    return parsed > 0 ? parsed : undefined;
  },
}));

const runtimeConfig = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("./runtime.js", () => ({
  tryGetVkRuntime: () => ({}),
  readVkRuntimeConfig: () => runtimeConfig.value,
}));

const { vkBooleanSetting, vkPositiveSetting, vkStringSetting } = await import("./settings.js");

function withConfig(vk: Record<string, unknown>): void {
  runtimeConfig.value = { channels: { vk } };
}

beforeEach(() => {
  runtimeConfig.value = undefined;
  delete process.env.VK_TEST_KNOB;
});

afterEach(() => {
  delete process.env.VK_TEST_KNOB;
});

describe("channel settings", () => {
  const numeric = { env: "VK_TEST_KNOB", section: "audio", key: "maxVoiceMs", fallback: 270_000 };

  it("falls back to the default when nothing is configured", () => {
    expect(vkPositiveSetting(numeric)).toBe(270_000);
  });

  it("reads the value from channels.vk", () => {
    withConfig({ audio: { maxVoiceMs: 60_000 } });
    expect(vkPositiveSetting(numeric)).toBe(60_000);
  });

  it("lets the environment override the config", () => {
    // The escape hatch: changing a variable on a running gateway is the fastest
    // way to answer "is this knob the problem?".
    withConfig({ audio: { maxVoiceMs: 60_000 } });
    process.env.VK_TEST_KNOB = "1000";
    expect(vkPositiveSetting(numeric)).toBe(1_000);
  });

  it("ignores a nonsense value in either place", () => {
    // Strict parsing on both sides: a tunable that silently accepts a typo is
    // worse than one that falls back to its default.
    withConfig({ audio: { maxVoiceMs: "many" } });
    expect(vkPositiveSetting(numeric)).toBe(270_000);
    process.env.VK_TEST_KNOB = "12abc";
    expect(vkPositiveSetting(numeric)).toBe(270_000);
  });

  it("survives a runtime without a config snapshot", () => {
    // Reading a tunable must never break the path that reads it.
    runtimeConfig.value = undefined;
    expect(vkPositiveSetting(numeric)).toBe(270_000);
  });

  it("resolves strings and booleans the same way", () => {
    withConfig({ voiceContinuation: { dir: "/parts", enabled: false } });
    expect(vkStringSetting({ env: "VK_TEST_KNOB", section: "voiceContinuation", key: "dir" })).toBe(
      "/parts",
    );
    expect(
      vkBooleanSetting({
        env: "VK_TEST_KNOB",
        section: "voiceContinuation",
        key: "enabled",
        fallback: true,
      }),
    ).toBe(false);

    process.env.VK_TEST_KNOB = "0";
    expect(
      vkBooleanSetting({
        env: "VK_TEST_KNOB",
        section: "voiceContinuation",
        key: "enabled",
        fallback: true,
      }),
    ).toBe(false);
  });
});
