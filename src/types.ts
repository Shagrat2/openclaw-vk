import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/compat";

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
  groups?: Record<
    string,
    {
      enabled?: boolean;
      allowFrom?: Array<string | number>;
      requireMention?: boolean;
      systemPrompt?: string;
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

export type VkInboundMessage = {
  messageId: string;
  peerId: number;
  senderId: number;
  text: string;
  timestamp: number;
  isGroup: boolean;
  messagePayload?: unknown;
  attachments?: VkInboundAttachment[];
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
  url?: string;
  title?: string;
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
