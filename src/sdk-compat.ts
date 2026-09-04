// Local copies of Plugin SDK types that the core stopped exporting.
//
// Both types existed in `channel-message` / `channel-outbound` up to 2026.7 and
// were moved into internal modules in 2026.8. They describe data this plugin
// reads from its own config, so a local copy costs nothing and removes a
// dependency on a surface the core no longer publishes.

/** Streaming section of the VK channel config, as this plugin reads it. */
export type StreamingCompatEntry = {
  streaming?: unknown;
};

/** Draft rendering mode accepted by `channels.vk.streaming.mode`. */
export type ChannelProgressDraftMode = "off" | "partial" | "block" | "progress";
