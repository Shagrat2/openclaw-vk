const { emptyPluginConfigSchema } = require("openclaw/plugin-sdk");
const { vkPlugin } = require("./src/channel.js");
const { setVkRuntime } = require("./src/runtime.js");

function register(api) {
  setVkRuntime(api.runtime);
  api.registerChannel({ plugin: vkPlugin });
}

module.exports = {
  id: "vk",
  name: "VK",
  description: "VK (VKontakte) community bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register,
};
