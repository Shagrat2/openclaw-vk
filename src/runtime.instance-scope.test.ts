import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The SDK store resolves its slot from the invoking managed instance. This stub
 * reproduces that: writes made "inside" a host call land in a per-call slot, and
 * a read from outside any call sees only the standalone slot — which is what a
 * progress callback the host runs on its own gets.
 */
const scope = { insideHostCall: false };
const instanceSlot: { runtime: unknown } = { runtime: null };
const standaloneSlot: { runtime: unknown } = { runtime: null };
const slot = () => (scope.insideHostCall ? instanceSlot : standaloneSlot);

vi.mock("openclaw/plugin-sdk/runtime-store", () => ({
  createPluginRuntimeStore: () => ({
    setRuntime: (next: unknown) => {
      slot().runtime = next;
    },
    clearRuntime: () => {
      slot().runtime = null;
    },
    tryGetRuntime: () => slot().runtime ?? null,
    getRuntime: () => {
      if (!slot().runtime) {
        throw new Error("VK runtime not initialized - plugin not registered");
      }
      return slot().runtime;
    },
  }),
}));

const { clearVkRuntime, getVkRuntime, setVkRuntime, tryGetVkRuntime } = await import(
  "./runtime.js"
);

describe("VK runtime outside a host call", () => {
  const runtime = { config: { current: () => ({}) } } as unknown as PluginRuntime;

  beforeEach(() => {
    instanceSlot.runtime = null;
    standaloneSlot.runtime = null;
    scope.insideHostCall = false;
    clearVkRuntime();
  });

  // Registration happens inside a host call; the step-progress callbacks do not.
  // Before the mirror this threw mid-turn and every tool step lost its draft.
  it("is still available to a callback the host runs on its own", () => {
    scope.insideHostCall = true;
    setVkRuntime(runtime);
    scope.insideHostCall = false;

    expect(tryGetVkRuntime()).toBe(runtime);
    expect(getVkRuntime()).toBe(runtime);
  });

  it("goes away with the registration it mirrors", () => {
    scope.insideHostCall = true;
    setVkRuntime(runtime);
    clearVkRuntime();
    scope.insideHostCall = false;

    expect(tryGetVkRuntime()).toBeNull();
    expect(() => getVkRuntime()).toThrow("VK runtime not initialized");
  });
});
