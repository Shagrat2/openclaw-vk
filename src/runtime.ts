import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { CoreConfig } from "./types.js";

const { setRuntime: setVkRuntime, getRuntime: getVkRuntime } =
  createPluginRuntimeStore<PluginRuntime>("VK runtime not initialized - plugin not registered");

export function readVkRuntimeConfig(runtime: PluginRuntime = getVkRuntime()): CoreConfig {
  if (typeof runtime.config.current !== "function") {
    throw new Error("OpenClaw runtime does not expose config.current()");
  }
  return runtime.config.current() as unknown as CoreConfig;
}

export { getVkRuntime, setVkRuntime };
