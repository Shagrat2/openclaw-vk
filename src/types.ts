export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type GroupPolicy = "open" | "disabled" | "allowlist";

/** The core's supplemental context visibility modes (`channels.<id>.contextVisibility`). */
export const VK_CONTEXT_VISIBILITY_MODES = ["all", "allowlist", "allowlist_quote"] as const;
export type VkContextVisibility = (typeof VK_CONTEXT_VISIBILITY_MODES)[number];

export type VkAccountConfig = {
  name?: string;
  enabled?: boolean;
  token?: string;
  tokenFile?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  /** Which forwards reach the agent in groups; see `VK_CONTEXT_VISIBILITY_MODES`. */
  contextVisibility?: VkContextVisibility;
  groups?: Record<
    string,
    {
      enabled?: boolean;
      allowFrom?: Array<string | number>;
      requireMention?: boolean;
      systemPrompt?: string;
      tools?: {
        allow?: string[];
        alsoAllow?: string[];
        deny?: string[];
      };
    }
  >;
};

export type VkConfig = VkAccountConfig & {
  accounts?: Record<string, VkAccountConfig>;
};

export type ResolvedVkAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: VkAccountConfig;
};

/** A message forwarded into an inbound one, as VK delivers it. */
export type VkInboundForward = {
  /** Author of the forwarded message; negative for a community. */
  senderId: number;
  /** When it was originally sent, in milliseconds. */
  timestamp?: number;
  text: string;
  attachments?: VkInboundAttachment[];
  forwards?: VkInboundForward[];
};

export type VkInboundMessage = {
  messageId: string;
  conversationMessageId?: number;
  peerId: number;
  senderId: number;
  text: string;
  timestamp: number;
  isGroup: boolean;
  messagePayload?: unknown;
  attachments?: VkInboundAttachment[];
  replyToMessageId?: string;
  replyToText?: string;
  /** Author of the quoted message; negative for a community. */
  replyToSenderId?: number;
  /** Messages forwarded into this one. */
  forwards?: VkInboundForward[];
  /** Messages forwarded into the quoted one. */
  replyToForwards?: VkInboundForward[];
};

export type VkButtonStyle = "primary" | "secondary" | "success" | "danger";

export type VkReplyButton = {
  text: string;
  callback_data: string;
  style?: VkButtonStyle;
};

export type VkReplyButtons = ReadonlyArray<ReadonlyArray<VkReplyButton>>;

export type VkInboundAttachment = {
  type: string;
  kind: string;
  url?: string;
  title?: string;
  mimeType?: string;
  /** A shared wall post: its address and text. The post has no media URL. */
  post?: { url?: string; text?: string };
};

export type VkInboundResolvedMedia = {
  path?: string;
  url: string;
  contentType?: string;
  attachment: VkInboundAttachment;
};

export type VkProbe = {
  ok: boolean;
  groupId?: number;
  groupName?: string;
  screenName?: string;
  error?: string;
};

export type CoreConfig = {
  channels?: {
    vk?: VkConfig;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
