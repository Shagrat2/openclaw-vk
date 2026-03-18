import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/compat";

const { setRuntime: setVkRuntime, getRuntime: getVkRuntime } =
  createPluginRuntimeStore<PluginRuntime>("VK runtime not initialized - plugin not registered");
export { getVkRuntime, setVkRuntime };
