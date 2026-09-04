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

/**
 * Draft rendering mode accepted by `channels.vk.streaming.mode`.
 *
 * Re-exported from the core rather than restated: the literals were written out
 * here, in the config schema and in the core, and a mode added upstream would
 * have left this copy silently behind.
 */
export type { StreamingMode as ChannelProgressDraftMode } from "openclaw/plugin-sdk/channel-outbound";
