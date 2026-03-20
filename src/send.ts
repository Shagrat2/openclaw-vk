import { VK, getRandomId } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import { buildVkKeyboard, resolveVkButtonsFromPayload } from "./keyboard.js";
import { getVkRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedVkAccount, VkReplyButtons } from "./types.js";

export type SendVkOptions = {
  cfg?: CoreConfig;
  accountId?: string;
  replyTo?: string;
  buttons?: VkReplyButtons;
};

export type SendVkResult = {
  messageId: string;
  chatId: string;
};

export type VkOutboundPayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  channelData?: Record<string, unknown>;
};

// Reuse VK instances per token to avoid creating new connections each time
const vkInstances = new Map<string, VK>();

function getOrCreateVk(token: string): VK {
  let vk = vkInstances.get(token);
  if (!vk) {
    vk = new VK({ token, apiLimit: 20 });
    vkInstances.set(token, vk);
  }
  return vk;
}

/**
 * Send a text message to a VK peer.
 */
export async function sendMessageVk(
  to: string,
  text: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  const runtime = getVkRuntime();
  const cfg = (opts.cfg ?? runtime.config.loadConfig()) as CoreConfig;
  const account = resolveVkAccount({ cfg, accountId: opts.accountId });

  if (!account.token) {
    throw new Error("VK token not configured");
  }

  const peerId = Number(to);
  if (Number.isNaN(peerId)) {
    throw new Error(`Invalid VK peer ID: ${to}`);
  }

  const vk = getOrCreateVk(account.token);
  const keyboard = buildVkKeyboard(opts.buttons);

  const messageId = await vk.api.messages.send({
    peer_id: peerId,
    message: text.slice(0, 4096),
    random_id: getRandomId(),
    ...(keyboard ? { keyboard } : {}),
    ...(opts.replyTo ? { reply_to: Number(opts.replyTo) } : {}),
  });

  runtime.channel.activity.record({
    channel: "vk",
    accountId: account.accountId,
    direction: "outbound",
    at: Date.now(),
  });

  return { messageId: String(messageId), chatId: to };
}

/**
 * Send a photo attachment to a VK peer.
 */
export async function sendPhotoVk(
  to: string,
  photoSource: string | Buffer,
  text?: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  const runtime = getVkRuntime();
  const cfg = (opts.cfg ?? runtime.config.loadConfig()) as CoreConfig;
  const account = resolveVkAccount({ cfg, accountId: opts.accountId });

  if (!account.token) {
    throw new Error("VK token not configured");
  }

  const peerId = Number(to);
  if (Number.isNaN(peerId)) {
    throw new Error(`Invalid VK peer ID: ${to}`);
  }

  const vk = getOrCreateVk(account.token);

  const attachment = await vk.upload.messagePhoto({
    peer_id: peerId,
    source: { value: photoSource },
  });

  const messageId = await vk.api.messages.send({
    peer_id: peerId,
    message: text?.slice(0, 4096) ?? "",
    attachment: String(attachment),
    random_id: getRandomId(),
  });

  runtime.channel.activity.record({
    channel: "vk",
    accountId: account.accountId,
    direction: "outbound",
    at: Date.now(),
  });

  return { messageId: String(messageId), chatId: to };
}

/**
 * Send a document attachment to a VK peer.
 */
export async function sendDocumentVk(
  to: string,
  docSource: string | Buffer,
  title: string,
  text?: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  const runtime = getVkRuntime();
  const cfg = (opts.cfg ?? runtime.config.loadConfig()) as CoreConfig;
  const account = resolveVkAccount({ cfg, accountId: opts.accountId });

  if (!account.token) {
    throw new Error("VK token not configured");
  }

  const peerId = Number(to);
  if (Number.isNaN(peerId)) {
    throw new Error(`Invalid VK peer ID: ${to}`);
  }

  const vk = getOrCreateVk(account.token);

  const attachment = await vk.upload.messageDocument({
    peer_id: peerId,
    source: { value: docSource },
    title,
  });

  const messageId = await vk.api.messages.send({
    peer_id: peerId,
    message: text?.slice(0, 4096) ?? "",
    attachment: String(attachment),
    random_id: getRandomId(),
  });

  runtime.channel.activity.record({
    channel: "vk",
    accountId: account.accountId,
    direction: "outbound",
    at: Date.now(),
  });

  return { messageId: String(messageId), chatId: to };
}

/**
 * Send typing activity indicator.
 */
export async function sendTypingVk(to: string, account: ResolvedVkAccount): Promise<void> {
  if (!account.token) {
    return;
  }

  const peerId = Number(to);
  if (Number.isNaN(peerId)) {
    return;
  }

  const vk = getOrCreateVk(account.token);

  try {
    await vk.api.messages.setActivity({
      peer_id: peerId,
      type: "typing",
    });
  } catch {
    // Typing indicator failure is non-critical
  }
}

function resolvePayloadMediaUrls(payload: VkOutboundPayloadLike): string[] {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  return typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()
    ? [payload.mediaUrl.trim()]
    : [];
}

function formatPayloadText(payload: VkOutboundPayloadLike): string {
  const trimmedText = payload.text?.trim() ?? "";
  const mediaUrls = resolvePayloadMediaUrls(payload);
  if (!trimmedText && mediaUrls.length === 0) {
    return "";
  }
  const mediaBlock = mediaUrls.length
    ? mediaUrls.map((url) => `Attachment: ${url}`).join("\n")
    : "";
  if (!trimmedText) {
    return mediaBlock;
  }
  if (!mediaBlock) {
    return trimmedText;
  }
  return `${trimmedText}\n\n${mediaBlock}`;
}

export async function sendPayloadVk(
  to: string,
  payload: VkOutboundPayloadLike,
  opts: Omit<SendVkOptions, "replyTo" | "buttons"> = {},
): Promise<SendVkResult | null> {
  const text = formatPayloadText(payload);
  const buttons = resolveVkButtonsFromPayload(payload);
  if (!text) {
    return null;
  }

  return await sendMessageVk(to, text, {
    ...opts,
    replyTo: payload.replyToId,
    buttons,
  });
}

/** Cleanup VK instances (for shutdown). */
export function clearVkInstances(): void {
  vkInstances.clear();
}
