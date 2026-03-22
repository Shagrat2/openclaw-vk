import { VK, getRandomId } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import { buildVkKeyboard, buildVkKeyboardRemoval, resolveVkButtonsFromPayload } from "./keyboard.js";
import { loadVkOutboundMedia } from "./media.js";
import { getVkRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedVkAccount, VkReplyButtons } from "./types.js";

const VK_MESSAGE_TEXT_LIMIT = 4096;
const VK_TRANSIENT_RETRY_ATTEMPTS = 2;
const VK_GROUP_CHAT_OFFSET = 2_000_000_000;
const DEFAULT_ACCOUNT_ID = "default";

export type SendVkOptions = {
  cfg?: CoreConfig;
  accountId?: string;
  replyTo?: string;
  buttons?: VkReplyButtons;
  clearKeyboard?: boolean;
  mediaLocalRoots?: readonly string[];
  forceDocument?: boolean;
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

type VkClientState = {
  vk: VK;
  groupId?: number;
  groupIdPromise?: Promise<number | undefined>;
};

const vkInstances = new Map<string, VkClientState>();

function getOrCreateVkState(token: string): VkClientState {
  let state = vkInstances.get(token);
  if (!state) {
    state = {
      vk: new VK({ token, apiLimit: 20 }),
    };
    vkInstances.set(token, state);
  }
  return state;
}

function getOrCreateVk(token: string): VK {
  return getOrCreateVkState(token).vk;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableVkError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  const errorCode =
    typeof record.code === "number"
      ? record.code
      : typeof record.error_code === "number"
        ? record.error_code
        : undefined;
  if (errorCode === 6 || errorCode === 9 || errorCode === 10) {
    return true;
  }
  const message = [
    typeof record.message === "string" ? record.message : "",
    typeof record.name === "string" ? record.name : "",
    typeof record.description === "string" ? record.description : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /timeout|timed out|temporar|econnreset|socket hang up|too many requests|rate limit|429|5\d\d/.test(
    message,
  );
}

async function withVkRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (attempt >= VK_TRANSIENT_RETRY_ATTEMPTS || !isRetryableVkError(error)) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }
}

function trimVkMessageText(text?: string): string {
  return text?.slice(0, VK_MESSAGE_TEXT_LIMIT) ?? "";
}

function resolveVkKeyboard(opts: SendVkOptions): string | undefined {
  return opts.clearKeyboard === true ? buildVkKeyboardRemoval() : buildVkKeyboard(opts.buttons);
}

function buildVkMessageChunks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const chunker =
    (getVkRuntime().channel as { text?: { chunkMarkdownText?: (text: string, limit: number) => string[] } })
      .text?.chunkMarkdownText;
  if (typeof chunker === "function") {
    try {
      const chunks = chunker(trimmed, VK_MESSAGE_TEXT_LIMIT)
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      if (chunks.length > 0) {
        return chunks;
      }
    } catch {
      // Fall back to fixed-width chunks.
    }
  }

  const chunks: string[] = [];
  for (let start = 0; start < trimmed.length; start += VK_MESSAGE_TEXT_LIMIT) {
    chunks.push(trimmed.slice(start, start + VK_MESSAGE_TEXT_LIMIT));
  }
  return chunks;
}

function resolvePayloadMediaUrls(payload: VkOutboundPayloadLike): string[] {
  const rawUrls = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  return Array.from(
    new Set(
      rawUrls
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function recordOutboundActivity(accountId: string): void {
  getVkRuntime().channel.activity.record({
    channel: "vk",
    accountId,
    direction: "outbound",
    at: Date.now(),
  });
}

function resolveSendTarget(params: { cfg?: CoreConfig; accountId?: string; to: string }) {
  const runtime = getVkRuntime();
  const cfg = (params.cfg ?? runtime.config.loadConfig()) as CoreConfig;
  const account = resolveVkAccount({ cfg, accountId: params.accountId });
  if (!account.token) {
    throw new Error("VK token not configured");
  }

  const normalizedTo = normalizeVkTargetId(params.to);
  const peerId = Number(normalizedTo);
  if (Number.isNaN(peerId)) {
    throw new Error(`Invalid VK peer ID: ${params.to}`);
  }

  return {
    account,
    peerId,
    to: normalizedTo,
  };
}

async function sendVkApiMessage(params: {
  to: string;
  peerId: number;
  account: ResolvedVkAccount;
  message: string;
  attachment?: string;
  opts?: SendVkOptions;
}): Promise<SendVkResult> {
  const vk = getOrCreateVk(params.account.token);
  const keyboard = resolveVkKeyboard(params.opts ?? {});
  const messageId = await withVkRetry(async () => {
    return await vk.api.messages.send({
      peer_id: params.peerId,
      message: trimVkMessageText(params.message),
      random_id: getRandomId(),
      ...(params.attachment ? { attachment: params.attachment } : {}),
      ...(keyboard ? { keyboard } : {}),
      ...(params.opts?.replyTo ? { reply_to: Number(params.opts.replyTo) } : {}),
    });
  });

  recordOutboundActivity(params.account.accountId);
  return { messageId: String(messageId), chatId: params.to };
}

async function resolveVkGroupId(state: VkClientState): Promise<number | undefined> {
  if (typeof state.groupId === "number") {
    return state.groupId;
  }
  if (!state.groupIdPromise) {
    state.groupIdPromise = state.vk.api.groups
      .getById({})
      .then(({ groups }) => {
        const groupId = groups[0]?.id;
        state.groupId = typeof groupId === "number" ? groupId : undefined;
        return state.groupId;
      })
      .catch(() => undefined);
  }
  return await state.groupIdPromise;
}

export function primeVkGroupId(token: string, groupId: number): void {
  const trimmedToken = token.trim();
  if (!trimmedToken || !Number.isInteger(groupId) || groupId <= 0) {
    return;
  }
  const state = getOrCreateVkState(trimmedToken);
  state.groupId = groupId;
  state.groupIdPromise = Promise.resolve(groupId);
}

export async function sendMessageVk(
  to: string,
  text: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  return await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    message: text,
    opts,
  });
}

export async function sendPhotoVk(
  to: string,
  photoSource: string | Buffer,
  text?: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const attachment = await withVkRetry(async () => {
    return await vk.upload.messagePhoto({
      peer_id: peerId,
      source: { value: photoSource },
    });
  });

  return await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    message: text ?? "",
    attachment: String(attachment),
    opts,
  });
}

export async function sendDocumentVk(
  to: string,
  docSource: string | Buffer,
  title: string,
  text?: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const attachment = await withVkRetry(async () => {
    return await vk.upload.messageDocument({
      peer_id: peerId,
      source: { value: docSource },
      title,
    });
  });

  return await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    message: text ?? "",
    attachment: String(attachment),
    opts,
  });
}

export async function sendAudioMessageVk(
  to: string,
  audioSource: string | Buffer,
  title: string,
  text?: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const attachment = await withVkRetry(async () => {
    return await vk.upload.audioMessage({
      peer_id: peerId,
      source: { value: audioSource },
      title,
    });
  });

  return await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    message: text ?? "",
    attachment: String(attachment),
    opts,
  });
}

export async function sendTypingVk(to: string, account: ResolvedVkAccount): Promise<void> {
  if (!account.token) {
    return;
  }

  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId)) {
    return;
  }

  const state = getOrCreateVkState(account.token);
  const groupId = await resolveVkGroupId(state);

  await withVkRetry(async () => {
    await state.vk.api.messages.setActivity({
      peer_id: peerId,
      type: "typing",
      ...(typeof groupId === "number" ? { group_id: groupId } : {}),
    });
  });
}

export async function markMessageReadVk(
  to: string,
  messageId: string,
  account: ResolvedVkAccount,
): Promise<void> {
  if (!account.token) {
    return;
  }

  const peerId = Number(normalizeVkTargetId(to));
  const startMessageId = Number(messageId);
  if (Number.isNaN(peerId) || Number.isNaN(startMessageId)) {
    return;
  }

  const vk = getOrCreateVk(account.token);
  await withVkRetry(async () => {
    await vk.api.messages.markAsRead({
      peer_id: peerId,
      start_message_id: startMessageId,
      mark_conversation_as_read: true,
    });
  });
}

async function sendMessageChunksVk(params: {
  to: string;
  chunks: string[];
  opts: SendVkOptions;
}): Promise<SendVkResult | null> {
  let lastResult: SendVkResult | null = null;
  for (let index = 0; index < params.chunks.length; index += 1) {
    const chunk = params.chunks[index];
    if (!chunk) {
      continue;
    }
    const isLast = index === params.chunks.length - 1;
    lastResult = await sendMessageVk(params.to, chunk, {
      ...params.opts,
      replyTo: index === 0 ? params.opts.replyTo : undefined,
      buttons: isLast ? params.opts.buttons : undefined,
      clearKeyboard: isLast ? params.opts.clearKeyboard : undefined,
    });
  }
  return lastResult;
}

async function sendResolvedMediaVk(params: {
  to: string;
  mediaUrl: string;
  caption?: string;
  opts: SendVkOptions;
}): Promise<SendVkResult> {
  const media = await loadVkOutboundMedia({
    mediaUrl: params.mediaUrl,
    mediaLocalRoots: params.opts.mediaLocalRoots,
    forceDocument: params.opts.forceDocument,
  });
  if (media.kind === "image") {
    return await sendPhotoVk(params.to, media.source, params.caption, params.opts);
  }
  if (media.kind === "audio_message") {
    return await sendAudioMessageVk(params.to, media.source, media.title, params.caption, params.opts);
  }
  return await sendDocumentVk(params.to, media.source, media.title, params.caption, params.opts);
}

async function sendPayloadMediaVk(params: {
  to: string;
  mediaUrls: string[];
  text: string;
  opts: SendVkOptions;
}): Promise<SendVkResult | null> {
  const textChunks = buildVkMessageChunks(params.text);
  let firstCaption = textChunks.shift();
  let lastResult: SendVkResult | null = null;

  for (let index = 0; index < params.mediaUrls.length; index += 1) {
    const mediaUrl = params.mediaUrls[index];
    const isLastMedia = index === params.mediaUrls.length - 1;
    const shouldApplyKeyboard = isLastMedia && textChunks.length === 0;
    lastResult = await sendResolvedMediaVk({
      to: params.to,
      mediaUrl,
      caption: firstCaption,
      opts: {
        ...params.opts,
        replyTo: index === 0 ? params.opts.replyTo : undefined,
        buttons: shouldApplyKeyboard ? params.opts.buttons : undefined,
        clearKeyboard: shouldApplyKeyboard ? params.opts.clearKeyboard : undefined,
      },
    });
    firstCaption = undefined;
  }

  if (textChunks.length > 0) {
    const textResult = await sendMessageChunksVk({
      to: params.to,
      chunks: textChunks,
      opts: {
        ...params.opts,
        replyTo: undefined,
      },
    });
    if (textResult) {
      lastResult = textResult;
    }
  }

  return lastResult;
}

export async function sendPayloadVk(
  to: string,
  payload: VkOutboundPayloadLike,
  opts: SendVkOptions = {},
): Promise<SendVkResult | null> {
  const text = payload.text?.trim() ?? "";
  const mediaUrls = resolvePayloadMediaUrls(payload);
  const buttons = opts.buttons ?? resolveVkButtonsFromPayload(payload);
  const replyTo = payload.replyToId ?? opts.replyTo;
  const clearKeyboard = opts.clearKeyboard === true && !buttons;

  if (!text && mediaUrls.length === 0) {
    return null;
  }

  if (mediaUrls.length > 0) {
    return await sendPayloadMediaVk({
      to,
      mediaUrls,
      text,
      opts: {
        ...opts,
        replyTo,
        buttons,
        clearKeyboard,
      },
    });
  }

  return await sendMessageChunksVk({
    to,
    chunks: buildVkMessageChunks(text),
    opts: {
      ...opts,
      replyTo,
      buttons,
      clearKeyboard,
    },
  });
}

export function isVkGroupPeerId(peerId: string | number): boolean {
  const numericPeerId = typeof peerId === "number" ? peerId : Number(peerId);
  return Number.isFinite(numericPeerId) && numericPeerId >= VK_GROUP_CHAT_OFFSET;
}

export function normalizeVkTargetId(value: string | number): string {
  return String(value).trim().replace(/^vk:(?:user:|chat:)?/i, "");
}

export function normalizeVkSenderAllowEntry(value: string | number): string {
  return String(value).trim().replace(/^vk:(?:user:)?/i, "");
}

export function normalizeVkDirectoryEntries(
  entries: Array<string | number>,
  params: {
    kind: "user" | "group";
    query?: string | null;
    limit?: number | null;
  },
): Array<{ kind: "user" | "group"; id: string }> {
  const normalized = Array.from(
    new Set(
      entries
        .map((entry) =>
          params.kind === "group" ? normalizeVkTargetId(entry) : normalizeVkSenderAllowEntry(entry),
        )
        .filter(Boolean)
        .filter((entry) => entry !== "*")
        .filter((entry) =>
          params.kind === "group" ? isVkGroupPeerId(entry) : !isVkGroupPeerId(entry),
        ),
    ),
  );
  const query = params.query?.trim().toLowerCase() ?? "";
  const filtered = query
    ? normalized.filter((entry) => entry.toLowerCase().includes(query))
    : normalized;
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? Math.floor(params.limit)
      : undefined;
  return filtered.slice(0, limit ?? filtered.length).map((id) => ({ kind: params.kind, id }));
}

export function readVkAllowlistConfig(account: ResolvedVkAccount) {
  return {
    dmAllowFrom: (account.config.allowFrom ?? []).map(String),
    groupAllowFrom: (account.config.groupAllowFrom ?? []).map(String),
    dmPolicy: account.config.dmPolicy,
    groupPolicy: account.config.groupPolicy,
    groupOverrides: Object.entries(account.config.groups ?? {})
      .filter(([, groupConfig]) => Array.isArray(groupConfig?.allowFrom) && groupConfig.allowFrom.length > 0)
      .map(([label, groupConfig]) => ({
        label,
        entries: (groupConfig?.allowFrom ?? []).map(String),
      })),
  };
}

export function applyVkAllowlistConfigEdit(params: {
  cfg: CoreConfig;
  parsedConfig: Record<string, unknown>;
  accountId?: string | null;
  scope: "dm" | "group";
  action: "add" | "remove";
  entry: string;
}):
  | {
      kind: "ok";
      changed: boolean;
      pathLabel: string;
      writeTarget:
        | { kind: "channel"; scope: { channelId: "vk" } }
        | { kind: "account"; scope: { channelId: "vk"; accountId: string } };
    }
  | { kind: "invalid-entry" } {
  const normalizedEntry = normalizeVkSenderAllowEntry(params.entry);
  if (!normalizedEntry) {
    return { kind: "invalid-entry" };
  }

  const channels = (params.parsedConfig.channels ??= {}) as Record<string, unknown>;
  const vk = ((channels.vk ??= {}) as Record<string, unknown>);
  const normalizedAccountId =
    typeof params.accountId === "string" && params.accountId.trim()
      ? params.accountId.trim()
      : DEFAULT_ACCOUNT_ID;
  const hasAccounts =
    Boolean(vk.accounts && typeof vk.accounts === "object") &&
    Object.keys(vk.accounts as Record<string, unknown>).length > 0;
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;

  let targetRecord: Record<string, unknown>;
  if (useAccount) {
    const accounts = (vk.accounts ??= {}) as Record<string, unknown>;
    const existing = accounts[normalizedAccountId];
    if (!existing || typeof existing !== "object") {
      accounts[normalizedAccountId] = {};
    }
    targetRecord = accounts[normalizedAccountId] as Record<string, unknown>;
  } else {
    targetRecord = vk;
  }

  const writePath = params.scope === "group" ? "groupAllowFrom" : "allowFrom";
  const existing = Array.isArray(targetRecord[writePath])
    ? (targetRecord[writePath] as unknown[])
        .map((entry) => normalizeVkSenderAllowEntry(entry as string))
        .filter(Boolean)
    : [];
  const hasEntry = existing.includes(normalizedEntry);
  let next = existing;
  let changed = false;

  if (params.action === "add") {
    if (!hasEntry) {
      next = [...existing, normalizedEntry];
      changed = true;
    }
  } else if (hasEntry) {
    next = existing.filter((entry) => entry !== normalizedEntry);
    changed = true;
  }

  if (changed) {
    if (next.length > 0) {
      targetRecord[writePath] = next;
    } else {
      delete targetRecord[writePath];
    }
  }

  return {
    kind: "ok",
    changed,
    pathLabel: useAccount
      ? `channels.vk.accounts.${normalizedAccountId}.${writePath}`
      : `channels.vk.${writePath}`,
    writeTarget: useAccount
      ? { kind: "account", scope: { channelId: "vk", accountId: normalizedAccountId } }
      : { kind: "channel", scope: { channelId: "vk" } },
  };
}

export function resolveVkDirectoryPeers(params: {
  account: ResolvedVkAccount;
  query?: string | null;
  limit?: number | null;
}) {
  const entries = [
    ...(params.account.config.allowFrom ?? []),
    ...(params.account.config.defaultTo ? [params.account.config.defaultTo] : []),
  ];
  return normalizeVkDirectoryEntries(entries, {
    kind: "user",
    query: params.query,
    limit: params.limit,
  });
}

export function resolveVkDirectoryGroups(params: {
  account: ResolvedVkAccount;
  query?: string | null;
  limit?: number | null;
}) {
  const entries = [
    ...Object.keys(params.account.config.groups ?? {}).filter((entry) => entry !== "*"),
    ...(params.account.config.defaultTo ? [params.account.config.defaultTo] : []),
  ];
  return normalizeVkDirectoryEntries(entries, {
    kind: "group",
    query: params.query,
    limit: params.limit,
  });
}

export function clearVkInstances(): void {
  vkInstances.clear();
}
