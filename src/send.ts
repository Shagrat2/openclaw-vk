import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueKeyedTask } from "openclaw/plugin-sdk/core";
import { VK, getRandomId } from "vk-io";
import { resolveVkAccount } from "./accounts.js";
import { describeVkSourceKind, resolveVkDiagLevel, vkDiag, vkDiagFailure } from "./diagnostics.js";
import { readVkErrorCode, readVkErrorMessage } from "./vk-errors.js";
import {
  cleanupAudioSegments,
  getVkAudioMessageMaxMs,
  probeAudioDurationMs,
  audioFileExtension,
  splitAudioAtSilence,
} from "./audio-chunk.js";
import {
  renderVkMarkdownChunks,
  type VkPreparedFormattedMessage,
} from "./format.js";
import {
  claimTtsParts,
  discardTtsParts,
  readTtsPartsManifest,
  waitForTtsPart,
} from "./tts-parts.js";
import { buildVkKeyboard, buildVkKeyboardRemoval, resolveVkButtonsFromPayload } from "./keyboard.js";
import { loadVkOutboundMedia } from "./media.js";
import { getVkRuntime, readVkRuntimeConfig } from "./runtime.js";
import { vkPositiveSetting } from "./settings.js";
import { normalizeVkTargetId } from "./send-support.js";
import type { CoreConfig, ResolvedVkAccount, VkReplyButtons } from "./types.js";
export {
  applyVkAllowlistConfigEdit,
  isVkGroupPeerId,
  normalizeVkDirectoryEntries,
  normalizeVkSenderAllowEntry,
  normalizeVkTargetId,
  readVkAllowlistConfig,
  resolveVkDirectoryGroups,
  resolveVkDirectoryPeers,
} from "./send-support.js";

const VK_MESSAGE_TEXT_LIMIT = 4096;
const VK_TRANSIENT_RETRY_ATTEMPTS = 3;
const VK_REMOTE_MEDIA_FETCH_TIMEOUT_MS = 15_000;

/** Download ceiling for remote media: the URL comes from a model reply. */
function getVkRemoteMediaMaxBytes(): number {
  return vkPositiveSetting({ env: "VK_REMOTE_AUDIO_MAX_BYTES", section: "audio", key: "remoteMaxBytes", fallback: 128 * 1024 * 1024 });
}
const DEFAULT_ACCOUNT_ID = "default";
const VK_MEDIA_SCOPE_FALLBACK_NOTICE =
  "Attachment could not be delivered; sent as text instead.";

const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

export type SendVkOptions = {
  /**
   * Gateway stop. Reaches external processes (ffmpeg while splitting voice
   * messages): without it a shutdown left them running with nobody left to
   * collect the result.
   */
  abortSignal?: AbortSignal;
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

type VkOutboundMediaReference = {
  url: string;
  title?: string;
  mimeType?: string;
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



function isVkScopeDeniedError(error: unknown): boolean {
  if (readVkErrorCode(error) === 15) {
    return true;
  }
  const message = readVkErrorMessage(error).toLowerCase();
  return message.includes("access denied") && message.includes("scope");
}

/**
 * VK answers with code 100 "X is undefined" when it did not accept the source:
 * `photo` at the save stage, `file` on a truncated multipart upload. The wording
 * is the same for both, so the parsing is shared.
 */
function isVkUndefinedSourceError(error: unknown, subject: "file" | "photo"): boolean {
  if (readVkErrorCode(error) !== 100) {
    return false;
  }
  const message = readVkErrorMessage(error).toLowerCase();
  return message.includes(`${subject} is undefined`) || message.includes(`${subject} undefined`);
}

function isVkPhotoSourceRejectedError(error: unknown): boolean {
  return isVkUndefinedSourceError(error, "photo");
}

function isVkImageUploadFallbackError(error: unknown): boolean {
  return isVkScopeDeniedError(error) || isVkPhotoSourceRejectedError(error);
}

/**
 * Retry a PHOTO upload on code 100 "photo is undefined".
 *
 * This failure was long treated as a verdict on the source and went straight to
 * the photo-to-document fallback, so the recipient got a grey file card instead
 * of a picture. Measurement showed the opposite: a 177 KB frame failed on
 * attempt 1, the same bytes went through as a document eight seconds later, and
 * the next two frames uploaded as photos on the first try. It is the same
 * truncated multipart as "file is undefined" on voice messages, only on the
 * photo endpoint.
 *
 * If the source really is unusable as a photo, the retries cost under a second
 * and the document fallback still fires — its predicate is untouched.
 */
function isVkRetryablePhotoUploadError(error: unknown): boolean {
  return isVkTransientFileUndefinedError(error) || isVkPhotoSourceRejectedError(error);
}

/**
 * Transient UPLOAD failure: a truncated multipart transfer, where VK answers
 * with code 100 "file is undefined". The request is idempotent, so a retry
 * goes through.
 */
function isVkTransientFileUndefinedError(error: unknown): boolean {
  return isVkUndefinedSourceError(error, "file");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function materializeRemoteVkPhotoSource(sourceUrl: string): Promise<Buffer | null> {
  if (!isHttpUrl(sourceUrl)) {
    return null;
  }
  const chunks: Buffer[] = [];
  const total = await streamBoundedRemoteMedia(
    sourceUrl,
    { maxBytes: getVkRemoteMediaMaxBytes(), contentTypePrefix: "image/" },
    (chunk) => {
      chunks.push(chunk);
    },
  );
  return total === null ? null : Buffer.concat(chunks, total);
}

function isRetryableVkError(error: unknown): boolean {
  const errorCode = readVkErrorCode(error);
  if (errorCode === 6 || errorCode === 9 || errorCode === 10) {
    return true;
  }
  const message = readVkErrorMessage(error).toLowerCase();
  return /time-?out|timed out|temporar|econnreset|socket hang up|too many requests|rate limit|not allowed|abort|429|5\d\d/.test(
    message,
  );
}

/**
 * Attachment delivery diagnostics.
 *
 * Written to the same VK_VOICE_DEBUG_LOG that already holds the media path
 * traces (ENTRY sendPayloadVk, uploadVkAudioMessage): one timeline for the whole
 * send path is readable, one split across two sinks is not. The first version
 * logged through runtime.logging and turned out to be mute — success there sits
 * behind the verbose gate, and that gate is closed in production.
 *
 * Failures are mirrored into the general runtime log, which is not gated and is
 * visible without the opt-in file.
 *
 * Only safe fields: attachment kind, size, attempt number, error code. No URLs,
 * no paths, no peer ids — such records leak easily into bug reports.
 */
type MediaUploadKind = "photo" | "document" | "audio";

function logMediaUploadOutcome(params: {
  kind: MediaUploadKind;
  source: string | Buffer;
  mime?: string;
  bytes?: number;
  attempt: number;
  error?: unknown;
}): void {
  const fields = {
    kind: params.kind,
    source: params.source,
    mime: params.mime,
    bytes: params.bytes,
    attempt: params.attempt,
  };
  if (params.error) {
    vkDiagFailure("vk upload failed", params.error, fields);
    return;
  }
  vkDiag("vk upload ok", fields);
}

/**
 * Upload queue: one transfer at a time per token.
 *
 * Within a single reply media already goes sequentially (sendPayloadMediaVk
 * awaits every attachment), but separate replies are independent — trailing
 * voice parts, parallel conversations — and reach the upload server at the same
 * time. Keying by token keeps order where the state is shared without making one
 * account wait for another.
 *
 * Retries and the pauses between them are deliberately OUTSIDE the queue:
 * holding the lock while sleeping would stall other uploads for no gain.
 */
const mediaUploadTails = new Map<string, Promise<void>>();


/** Jittered pause: spreads retries of different sends so they do not converge. */
function retryDelayMs(attempt: number): number {
  const base = 250 * attempt;
  return base + Math.floor(Math.random() * base);
}

/**
 * Attachment upload: queued for the transfer, retried on transient failures,
 * with one shared diagnostic. The caller only has to say what it is uploading.
 */
/**
 * Local file size for the log. Byte counts are among the safe fields, but this
 * one was only computed for buffers, leaving a hole for on-disk files exactly
 * where the number tells an empty render from a complete one.
 *
 * The stat call happens only when diagnostics are on, and once per upload rather
 * than per attempt: with diagnostics off the send path must pay nothing.
 */
async function localSourceSize(source: string | Buffer): Promise<number | undefined> {
  if (Buffer.isBuffer(source)) {
    return source.byteLength;
  }
  if (resolveVkDiagLevel() === "off" || describeVkSourceKind(source) !== "local") {
    return undefined;
  }
  try {
    const path = source.startsWith("file://") ? fileURLToPath(source) : source;
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

async function runMediaUpload<T>(params: {
  kind: MediaUploadKind;
  source: string | Buffer;
  mime?: string;
  token: string;
  upload: () => Promise<T>;
  /** Per-kind retry policy, when this attachment kind differs from the default. */
  retry?: {
    extraRetryableCodes?: readonly number[];
    extraRetryablePredicate?: (error: unknown) => boolean;
    maxAttempts?: number;
  };
}): Promise<T> {
  const bytes = await localSourceSize(params.source);
  let attempt = 0;
  return await withVkRetry(
    async () => {
      attempt += 1;
      try {
        const result = await enqueueKeyedTask({
          tails: mediaUploadTails,
          key: params.token,
          task: params.upload,
        });
        logMediaUploadOutcome({ kind: params.kind, source: params.source, mime: params.mime, bytes, attempt });
        return result;
      } catch (error) {
        logMediaUploadOutcome({
          kind: params.kind,
          source: params.source,
          mime: params.mime,
          bytes,
          attempt,
          error,
        });
        throw error;
      }
    },
    params.retry ?? { extraRetryablePredicate: isVkTransientFileUndefinedError },
  );
}

async function withVkRetry<T>(
  operation: () => Promise<T>,
  opts?: {
    extraRetryableCodes?: readonly number[];
    extraRetryablePredicate?: (error: unknown) => boolean;
    maxAttempts?: number;
  },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? VK_TRANSIENT_RETRY_ATTEMPTS;
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const code = readVkErrorCode(error);
      const retryable =
        isRetryableVkError(error) ||
        (code !== undefined && (opts?.extraRetryableCodes?.includes(code) ?? false)) ||
        (opts?.extraRetryablePredicate?.(error) ?? false);
      if (attempt >= maxAttempts || !retryable) {
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    }
  }
}

function getLastSendResult(results: readonly SendVkResult[]): SendVkResult | null {
  return results.length > 0 ? (results[results.length - 1] ?? null) : null;
}

function buildVkUploadSource(params: {
  source: string | Buffer;
  filename?: string;
  contentType?: string;
}): { value: string | Buffer; filename?: string; contentType?: string } {
  return {
    value: params.source,
    ...(params.filename ? { filename: params.filename } : {}),
    ...(params.contentType ? { contentType: params.contentType } : {}),
  };
}

function prepareVkMessageChunks(text: string): VkPreparedFormattedMessage[] {
  return renderVkMarkdownChunks(text, { chunkSize: VK_MESSAGE_TEXT_LIMIT }).filter((chunk) => chunk.text.length > 0);
}

function toPreparedVkMessages(
  message: string | VkPreparedFormattedMessage | undefined,
): VkPreparedFormattedMessage[] {
  if (!message) {
    return [{ text: "" }];
  }
  if (typeof message !== "string") {
    return [message];
  }

  const chunks = prepareVkMessageChunks(message);
  return chunks.length > 0 ? chunks : [{ text: "" }];
}

function resolveVkKeyboard(opts: SendVkOptions): string | undefined {
  return opts.clearKeyboard === true ? buildVkKeyboardRemoval() : buildVkKeyboard(opts.buttons);
}

function dedupeVkMediaReferences(
  refs: VkOutboundMediaReference[],
): VkOutboundMediaReference[] {
  const byUrl = new Map<string, VkOutboundMediaReference>();
  for (const ref of refs) {
    const normalizedUrl = ref.url.trim();
    if (!normalizedUrl) {
      continue;
    }
    const existing = byUrl.get(normalizedUrl);
    if (!existing) {
      byUrl.set(normalizedUrl, { ...ref, url: normalizedUrl });
      continue;
    }
    byUrl.set(normalizedUrl, {
      url: normalizedUrl,
      title: existing.title ?? ref.title,
      mimeType: existing.mimeType ?? ref.mimeType,
    });
  }
  return Array.from(byUrl.values());
}

function resolvePayloadMediaReferences(payload: VkOutboundPayloadLike): VkOutboundMediaReference[] {
  const rawUrls = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  return dedupeVkMediaReferences(
    rawUrls
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((url) => ({ url })),
  );
}

function isLikelyVkMediaReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (isHttpUrl(trimmed) || /^data:/i.test(trimmed) || trimmed.startsWith("file://")) {
    return true;
  }
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return true;
  }
  return /\.(?:apng|avif|bmp|gif|heic|heif|jpeg|jpg|png|webp|aac|flac|m4a|mp3|oga|ogg|opus|wav|pdf|mp4|webm)(?:$|[?#])/i.test(
    trimmed,
  );
}

function isLikelyVkAttachmentLinkTarget(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith("file://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    /^data:/i.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return true;
  }

  return /\.(?:txt|md|json|csv|tsv|log|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz|tgz|png|jpg|jpeg|webp|gif|mp3|wav|ogg|opus|mp4|webm)(?:$|[?#])/i.test(
    trimmed,
  );
}

function isLikelyVkAttachmentTitle(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /\.(?:txt|md|json|csv|tsv|log|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz|tgz|png|jpg|jpeg|webp|gif|mp3|wav|ogg|opus|mp4|webm)$/i.test(
    trimmed,
  );
}

function resolveVkMarkdownAttachmentPayload(text: string): {
  text: string;
  mediaRefs: VkOutboundMediaReference[];
} {
  const mediaRefs: VkOutboundMediaReference[] = [];
  const stripped = text.replace(MARKDOWN_LINK_RE, (fullMatch, bang: string, label: string, rawUrl: string) => {
    const candidate = rawUrl.trim();
    const shouldExtract =
      bang === "!"
        ? isLikelyVkMediaReference(candidate)
        : isLikelyVkAttachmentLinkTarget(candidate);

    if (!shouldExtract) {
      return fullMatch;
    }
    const trimmedLabel = label.trim();
    mediaRefs.push({
      url: candidate,
      ...(bang !== "!" && isLikelyVkAttachmentTitle(trimmedLabel)
        ? { title: trimmedLabel }
        : {}),
    });
    return "";
  });

  const normalizedText = stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: normalizedText,
    mediaRefs: dedupeVkMediaReferences(mediaRefs),
  };
}

function resolveVkPayloadParts(
  payload: VkOutboundPayloadLike,
  opts: SendVkOptions,
): {
  text: string;
  mediaRefs: VkOutboundMediaReference[];
  buttons: VkReplyButtons | undefined;
  replyTo: string | undefined;
  clearKeyboard: boolean;
} {
  const parsedText = resolveVkMarkdownAttachmentPayload(payload.text ?? "");
  const text = parsedText.text;
  const mediaRefs = dedupeVkMediaReferences([
    ...resolvePayloadMediaReferences(payload),
    ...parsedText.mediaRefs,
  ]);
  const buttons = opts.buttons ?? resolveVkButtonsFromPayload(payload);
  const replyTo = payload.replyToId ?? opts.replyTo;
  const clearKeyboard = opts.clearKeyboard === true && !buttons;

  return {
    text,
    mediaRefs,
    buttons,
    replyTo,
    clearKeyboard,
  };
}

function recordOutboundActivity(accountId: string): void {
  getVkRuntime().channel.activity.record({
    channel: "vk",
    accountId,
    direction: "outbound",
    at: Date.now(),
  });
}

async function resolveSendTarget(params: { cfg?: CoreConfig; accountId?: string; to: string }) {
  const runtime = getVkRuntime();
  const cfg = params.cfg ?? readVkRuntimeConfig(runtime);
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
  formatted: VkPreparedFormattedMessage;
  attachment?: string;
  opts?: SendVkOptions;
}): Promise<SendVkResult> {
  const vk = getOrCreateVk(params.account.token);
  const keyboard = resolveVkKeyboard(params.opts ?? {});
  const formatData =
    params.formatted.formatData && params.formatted.formatData.items.length > 0
      ? JSON.stringify(params.formatted.formatData)
      : undefined;
  const randomId = getRandomId();
  const messageId = await withVkRetry(async () => {
    return await vk.api.messages.send({
      peer_id: params.peerId,
      message: params.formatted.text,
      random_id: randomId,
      ...(params.attachment ? { attachment: params.attachment } : {}),
      ...(keyboard ? { keyboard } : {}),
      ...(params.opts?.replyTo ? { reply_to: Number(params.opts.replyTo) } : {}),
      ...(formatData ? { format_data: formatData } : {}),
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
  vkDiag("send text", { to, textLen: (text ?? "").length });
  const parsed = resolveVkMarkdownAttachmentPayload(text);
  const results = await sendPayloadResultsVk({
    to,
    text: parsed.text,
    mediaRefs: parsed.mediaRefs,
    opts,
  });

  return getLastSendResult(results) ?? { messageId: "", chatId: normalizeVkTargetId(to) };
}

/**
 * Sends an attachment with its caption, then any overflow chunks.
 *
 * The three attachment senders (photo, document, voice) ended with the same
 * block: split the caption, put the first chunk on the attachment, send the rest
 * as plain messages. The rule that keyboards belong on the last message and
 * `replyTo` on the first lived in each copy separately, which is how three
 * copies of one invariant drift apart without anyone noticing.
 */
async function sendVkAttachmentWithCaption(params: {
  to: string;
  peerId: number;
  account: ResolvedVkAccount;
  attachment: string;
  text?: string | VkPreparedFormattedMessage;
  opts: SendVkOptions;
}): Promise<SendVkResult> {
  const [firstChunk, ...tailChunks] = toPreparedVkMessages(params.text);
  const firstResult = await sendVkApiMessage({
    to: params.to,
    peerId: params.peerId,
    account: params.account,
    formatted: firstChunk ?? { text: "" },
    attachment: params.attachment,
    opts: {
      ...params.opts,
      // Buttons ride the last message of the reply, so they wait if more chunks
      // are coming.
      buttons: tailChunks.length === 0 ? params.opts.buttons : undefined,
      clearKeyboard: tailChunks.length === 0 ? params.opts.clearKeyboard : undefined,
    },
  });

  if (tailChunks.length === 0) {
    return firstResult;
  }

  const tailResults = await sendMessageChunksVk({
    to: params.to,
    chunks: tailChunks,
    // `replyTo` belongs to the first message only; repeating it would quote the
    // same message on every chunk.
    opts: { ...params.opts, replyTo: undefined },
  });

  return getLastSendResult(tailResults) ?? firstResult;
}

export async function sendPhotoVk(
  to: string,
  photoSource: string | Buffer,
  text?: string | VkPreparedFormattedMessage,
  opts: SendVkOptions = {},
  uploadMeta?: {
    filename?: string;
    contentType?: string;
    /**
     * Whether to retry "photo is undefined" instead of failing immediately. The
     * caller decides, because only it knows whether it has a fallback: a picture
     * behind a URL does (download and retry with the bytes), a local file does
     * not, and there the retry is the only thing between a photo and a grey
     * document card.
     */
    retryTransientPhotoErrors?: boolean;
  },
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = await resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const attachment = await runMediaUpload({
    kind: "photo",
    source: photoSource,
    mime: uploadMeta?.contentType,
    token: account.token,
    retry:
      uploadMeta?.retryTransientPhotoErrors === true
        ? { extraRetryablePredicate: isVkRetryablePhotoUploadError }
        : undefined,
    upload: () =>
      vk.upload.messagePhoto({
        peer_id: peerId,
        source: buildVkUploadSource({
          source: photoSource,
          filename: uploadMeta?.filename,
          contentType: uploadMeta?.contentType,
        }),
      }),
  });
  return await sendVkAttachmentWithCaption({
    to: normalizedTo,
    peerId,
    account,
    attachment: String(attachment),
    text: text,
    opts,
  });
}

export async function sendDocumentVk(
  to: string,
  docSource: string | Buffer,
  title: string,
  text?: string | VkPreparedFormattedMessage,
  opts: SendVkOptions = {},
  uploadMeta?: { contentType?: string },
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = await resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const attachment = await runMediaUpload({
    kind: "document",
    source: docSource,
    mime: uploadMeta?.contentType,
    token: account.token,
    upload: () =>
      vk.upload.messageDocument({
        peer_id: peerId,
        source: buildVkUploadSource({
          source: docSource,
          filename: title,
          contentType: uploadMeta?.contentType,
        }),
        title,
      }),
  });
  return await sendVkAttachmentWithCaption({
    to: normalizedTo,
    peerId,
    account,
    attachment: String(attachment),
    text: text,
    opts,
  });
}

/**
 * Returns a local filesystem path usable by ffmpeg for `audioSource`, plus a
 * cleanup callback. Buffers are written to a temp file. Non-local strings
 * (http/data/file:// etc.) yield `null` so the caller skips splitting.
 */
/**
 * Downloads remote audio with a size ceiling.
 *
 * The ceiling is mandatory: the URL comes from a model reply, so the source is
 * untrusted, and without a limit an unbounded body could be pulled into memory.
 * We read as a stream and abort as soon as the limit is exceeded.
 */
/**
 * Streams a remote media body with a byte ceiling, handing chunks to `sink`.
 *
 * One reader for both media paths. They used to be two: audio counted bytes and
 * enforced a ceiling, photos read `arrayBuffer()` with no limit at all — the
 * same untrusted URL from a model reply, one of them unbounded. Streaming also
 * lets the audio path write straight to disk instead of holding the whole file
 * in memory and then writing it, which peaked at twice the file size.
 *
 * Returns the number of bytes read, or null when the fetch failed, the ceiling
 * was exceeded, or the content type did not match.
 */
async function streamBoundedRemoteMedia(
  url: string,
  opts: { maxBytes: number; contentTypePrefix?: string },
  sink: (chunk: Buffer) => Promise<void> | void,
): Promise<number | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VK_REMOTE_MEDIA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      return null;
    }
    if (opts.contentTypePrefix) {
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType && !contentType.startsWith(opts.contentTypePrefix)) {
        return null;
      }
    }
    // The declared size is a cheap early exit; the counter below is what
    // actually enforces the ceiling, since the header can lie or be absent.
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      return null;
    }
    let total = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > opts.maxBytes) {
        return null;
      }
      await sink(Buffer.from(chunk));
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function materializeLocalAudioFile(
  audioSource: string | Buffer,
  title: string,
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  if (Buffer.isBuffer(audioSource)) {
    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), "vk-voice-src-"));
    } catch {
      return null;
    }
    try {
      const safeName = title.replace(/[\\/]/g, "_") || "voice.ogg";
      const path = join(dir, safeName);
      await writeFile(path, audioSource);
      return {
        path,
        cleanup: async () => {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        },
      };
    } catch {
      // The directory was created but the write failed — clean up after
      // ourselves. This path used to leave an empty directory in /tmp per
      // failure.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
  }

  // Materialize remote audio into a temporary file: otherwise a long recording
  // behind a URL was never split and went as one piece, which VK rejected.
  //
  // Streamed straight to disk rather than buffered and then written: at the
  // 128 MB ceiling the old path peaked at twice that in memory, on a machine
  // that also holds local models.
  if (isHttpUrl(audioSource)) {
    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), "vk-voice-src-"));
    } catch {
      return null;
    }
    const path = join(dir, title.replace(/[\\/]/g, "_") || "voice.ogg");
    const cleanup = async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    const handle = await open(path, "w").catch(() => null);
    if (!handle) {
      await cleanup();
      return null;
    }
    try {
      const total = await streamBoundedRemoteMedia(
        audioSource,
        { maxBytes: getVkRemoteMediaMaxBytes() },
        async (chunk) => {
          await handle.write(chunk);
        },
      );
      if (total === null) {
        await cleanup();
        return null;
      }
      return { path, cleanup };
    } catch {
      await cleanup();
      return null;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // data: and file:// are left alone: the first is already in memory and arrives
  // as a buffer, the second the core expands into a plain path before us.
  if (/^data:/i.test(audioSource) || audioSource.startsWith("file://")) {
    return null;
  }
  return { path: audioSource, cleanup: async () => {} };
}

async function uploadVkAudioMessage(params: {
  vk: VK;
  token: string;
  peerId: number;
  source: string | Buffer;
  filename: string;
  contentType?: string;
}): Promise<string> {
  // Guard against an invalid peer_id (would surface from VK as a misleading
  // error 15 "access denied … with current scopes", even though the token's
  // scopes are fine). Fail loud and accurate instead.
  if (!Number.isFinite(params.peerId) || params.peerId <= 0) {
    vkDiagFailure("audio upload aborted: invalid peer", null, {
      peerId: params.peerId,
      filename: params.filename,
    });
    throw new Error(
      `VK audio upload aborted: invalid peer_id (${JSON.stringify(params.peerId)}); peer_id is required for audio_message uploads`,
    );
  }
  vkDiag("audio upload start", {
    source: params.source,
    mime: params.contentType,
    peerId: params.peerId,
    filename: params.filename,
  });
  // The retry targets EXACTLY the upload-server request, not the whole upload.
  //
  // Under load `docs.getMessagesUploadServer(type=audio_message)` returns
  // code=15 transiently (measured: ~20% versus zero when sending sequentially),
  // and a repeat request goes through. Wrapping the whole pipeline (get server →
  // upload → save) in a retry would be wrong: a genuine permission failure is
  // permanent, and a retry after a successful upload can create the document
  // twice.
  //
  // The address is fetched for EVERY upload attempt rather than once: VK's
  // upload_url is short-lived and effectively single-use, so replaying multipart
  // against a spent address would always fail and the "file is undefined" retry
  // would be pointless.
  const requestUploadUrl = (): Promise<string> =>
    withVkRetry(
      async () => {
        const server = (await params.vk.api.docs.getMessagesUploadServer({
          type: "audio_message",
          peer_id: params.peerId,
        })) as { upload_url?: string };
        if (!server?.upload_url) {
          throw new Error("VK audio upload: getMessagesUploadServer returned no upload_url");
        }
        return server.upload_url;
      },
      { extraRetryableCodes: [15] },
    );

  const attachment = await runMediaUpload({
    kind: "audio",
    source: params.source,
    mime: params.contentType,
    token: params.token,
    upload: async () =>
      await params.vk.upload.audioMessage({
        peer_id: params.peerId,
        source: {
          uploadUrl: await requestUploadUrl(),
          values: [
            buildVkUploadSource({
              source: params.source,
              filename: params.filename,
              contentType: params.contentType,
            }),
          ],
        },
        title: params.filename,
      }),
    // A truncated multipart transfer (code=100 "file is undefined") is retried:
    // the file never reached VK, so there can be no duplicate.
    retry: { extraRetryablePredicate: isVkTransientFileUndefinedError },
  });
  return String(attachment);
}

/**
 * Streams the continuation parts of a long spoken reply as follow-up voice
 * messages (see `./tts-parts.ts`). Runs detached from the reply operation:
 * parts are still being synthesized while this waits, and blocking the reply on
 * that would stall the dispatcher.
 */
async function deliverTtsContinuation(params: {
  vk: VK;
  peerId: number;
  to: string;
  account: ResolvedVkAccount;
  dir: string;
  opts: SendVkOptions;
}): Promise<void> {
  const manifest = await readTtsPartsManifest(params.dir);
  if (!manifest) {
    return;
  }
  vkDiag("tts continuation start", {
    parts: manifest.parts.length,
    dir: params.dir,
    peerId: params.peerId,
  });
  const maxMs = getVkAudioMessageMaxMs();

  for (const entry of manifest.parts) {
    const part = await waitForTtsPart(params.dir, entry.index);
    if (!part) {
      vkDiag("tts continuation skip", { part: entry.index, reason: "not ready" });
      continue;
    }
    const file = join(params.dir, part.file);
    let segments: string[] = [];
    try {
      if ((part.durationMs ?? 0) > maxMs) {
        segments = await splitAudioAtSilence(file, maxMs, {
          // The manifest already carries it — measuring again would spawn an
          // ffprobe per part, up to eight on one long reply.
          knownDurationMs: part.durationMs,
          signal: params.opts.abortSignal,
        });
      }
    } catch {
      segments = [];
    }
    const sources = segments.length >= 2 ? segments : [file];
    try {
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index] as string;
        const attachment = await uploadVkAudioMessage({
          vk: params.vk,
          token: params.account.token,
          peerId: params.peerId,
          source,
          filename: `voice-part-${String(part.index).padStart(2, "0")}-${index + 1}${
            source.endsWith(".wav") ? ".wav" : ".ogg"
          }`,
        });
        await sendVkApiMessage({
          to: params.to,
          peerId: params.peerId,
          account: params.account,
          formatted: { text: "" },
          attachment,
          opts: {
            ...params.opts,
            replyTo: undefined,
            buttons: undefined,
            clearKeyboard: undefined,
          },
        });
      }
      vkDiag("tts continuation sent", {
        part: part.index,
        total: manifest.parts.length,
        segments: sources.length,
      });
    } catch (error) {
      // One lost part must not swallow the rest of the reply.
      vkDiagFailure("tts continuation failed", error, { part: part.index });
    } finally {
      if (segments.length >= 2) {
        await cleanupAudioSegments(segments);
      }
    }
  }

  await discardTtsParts(params.dir);
  vkDiag("tts continuation done", { parts: manifest.parts.length, dir: params.dir });
}

/**
 * Claims the continuation directory for a just-sent head audio and starts
 * delivering it, if there is one.
 *
 * Both audio paths — split and single-file — ended with the same claim-and-start
 * pair; a third path would have needed a third copy.
 */
async function startTtsContinuationForHead(params: {
  vk: VK;
  peerId: number;
  to: string;
  account: ResolvedVkAccount;
  headDurationMs: number | null;
  opts: SendVkOptions;
}): Promise<void> {
  const dir = await claimTtsParts(params.headDurationMs);
  if (!dir) {
    return;
  }
  startTtsContinuation({
    vk: params.vk,
    peerId: params.peerId,
    to: params.to,
    account: params.account,
    dir,
    opts: params.opts,
  });
}

function startTtsContinuation(params: {
  vk: VK;
  peerId: number;
  to: string;
  account: ResolvedVkAccount;
  dir: string;
  opts: SendVkOptions;
}): void {
  void deliverTtsContinuation(params).catch((error: unknown) => {
    vkDiagFailure("tts continuation error", error);
  });
}

export async function sendAudioMessageVk(
  to: string,
  audioSource: string | Buffer,
  title: string,
  text?: string | VkPreparedFormattedMessage,
  opts: SendVkOptions = {},
  uploadMeta?: { contentType?: string },
): Promise<SendVkResult> {
  const { account, peerId, to: normalizedTo } = await resolveSendTarget({
    cfg: opts.cfg,
    accountId: opts.accountId,
    to,
  });
  const vk = getOrCreateVk(account.token);
  const [firstChunk, ...tailChunks] = toPreparedVkMessages(text);

  // ── Attempt silence-based split for over-limit local audio ────────────────
  const local = await materializeLocalAudioFile(audioSource, title);
  // Source for a single send. For a URL this is the file we downloaded, not the
  // URL itself: otherwise vk-io would pull the same bytes a second time — we
  // already fetched them to measure the duration.
  let uploadSource: string | Buffer = audioSource;
  let uploadCleanup: (() => Promise<void>) | null = null;
  // Head duration doubles as the key that claims this reply's continuation parts.
  let headDurationMs: number | null = null;
  if (local) {
    const maxMs = getVkAudioMessageMaxMs();
    let segments: string[] = [];
    try {
      headDurationMs = await probeAudioDurationMs(local.path);
      if (headDurationMs !== null && headDurationMs > maxMs) {
        segments = await splitAudioAtSilence(local.path, maxMs, {
          knownDurationMs: headDurationMs,
          signal: opts.abortSignal,
        });
      }
    } catch {
      segments = [];
    }

    if (segments.length >= 2) {
      try {
        const result = await sendVkAudioSegments({
          to: normalizedTo,
          peerId,
          account,
          vk,
          segments,
          contentType: uploadMeta?.contentType,
          firstChunk,
          tailChunks,
          opts,
        });
        await startTtsContinuationForHead({
          vk,
          peerId,
          to: normalizedTo,
          account,
          headDurationMs,
          opts,
        });
        return result;
      } finally {
        await cleanupAudioSegments(segments);
        await local.cleanup();
      }
    }
    if (typeof audioSource === "string" && isHttpUrl(audioSource)) {
      // Keep the download until the send finishes, then clean it up.
      uploadSource = local.path;
      uploadCleanup = local.cleanup;
    } else {
      await local.cleanup();
    }
  }

  // ── Single-message path (short audio / split unavailable) ─────────────────
  const attachment = await uploadVkAudioMessage({
    vk,
    token: account.token,
    peerId,
    source: uploadSource,
    filename: title,
    contentType: uploadMeta?.contentType,
  }).finally(async () => {
    await uploadCleanup?.();
  });
  const firstResult = await sendVkApiMessage({
    to: normalizedTo,
    peerId,
    account,
    formatted: firstChunk ?? { text: "" },
    attachment,
    opts: {
      ...opts,
      buttons: tailChunks.length === 0 ? opts.buttons : undefined,
      clearKeyboard: tailChunks.length === 0 ? opts.clearKeyboard : undefined,
    },
  });

  await startTtsContinuationForHead({
    vk,
    peerId,
    to: normalizedTo,
    account,
    headDurationMs,
    opts,
  });

  if (tailChunks.length === 0) {
    return firstResult;
  }

  const tailResults = await sendMessageChunksVk({
    to: normalizedTo,
    chunks: tailChunks,
    opts: {
      ...opts,
      replyTo: undefined,
    },
  });

  return getLastSendResult(tailResults) ?? firstResult;
}

/**
 * Sends N audio segments as separate VK voice messages in order, then the
 * remaining text chunks. The first text chunk + replyTo ride the first voice;
 * buttons/clearKeyboard apply only to the very last sent message.
 */
/** Segment file extension: after `-c copy` the container stays as it was. */
async function sendVkAudioSegments(params: {
  to: string;
  peerId: number;
  account: ResolvedVkAccount;
  vk: VK;
  segments: readonly string[];
  contentType?: string;
  firstChunk?: VkPreparedFormattedMessage;
  tailChunks: VkPreparedFormattedMessage[];
  opts: SendVkOptions;
}): Promise<SendVkResult> {
  const { segments, tailChunks, opts } = params;
  const hasTail = tailChunks.length > 0;
  const results: SendVkResult[] = [];

  // Upload ALL segments first, and only then send them.
  //
  // Each segment used to be sent right after its own upload, so a failure on the
  // second left the recipient with a truncated answer: the first half of the
  // phrase delivered, the second never coming. Uploading shows the recipient
  // nothing, so its failure can be handled as a whole — and the caller then
  // falls back to sending a single file.
  const attachments: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    attachments.push(
      await uploadVkAudioMessage({
        vk: params.vk,
        token: params.account.token,
        peerId: params.peerId,
        source: segment,
        // Take the extension from the segment itself: splitting uses `-c copy`,
        // so the container stays as it was, and naming an mp3 segment ".ogg"
        // would lie to VK about the format.
        filename: `voice-${String(index + 1).padStart(2, "0")}${audioFileExtension(segment)}`,
        contentType: params.contentType,
      }),
    );
  }

  for (let index = 0; index < segments.length; index += 1) {
    const isFirst = index === 0;
    const isLastSegment = index === segments.length - 1;
    const applyKeyboard = isLastSegment && !hasTail;
    const attachment = attachments[index] as string;

    const result = await sendVkApiMessage({
      to: params.to,
      peerId: params.peerId,
      account: params.account,
      formatted: isFirst ? params.firstChunk ?? { text: "" } : { text: "" },
      attachment,
      opts: {
        ...opts,
        replyTo: isFirst ? opts.replyTo : undefined,
        buttons: applyKeyboard ? opts.buttons : undefined,
        clearKeyboard: applyKeyboard ? opts.clearKeyboard : undefined,
      },
    });
    results.push(result);
  }

  if (hasTail) {
    const tailResults = await sendMessageChunksVk({
      to: params.to,
      chunks: tailChunks,
      opts: {
        ...opts,
        replyTo: undefined,
      },
    });
    results.push(...tailResults);
  }

  return getLastSendResult(results) ?? { messageId: "", chatId: params.to };
}

export async function sendFormattedTextVk(
  to: string,
  text: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult[]> {
  const parsed = resolveVkMarkdownAttachmentPayload(text);
  return await sendPayloadResultsVk({
    to,
    text: parsed.text,
    mediaRefs: parsed.mediaRefs,
    opts,
  });
}

export async function sendFormattedMediaVk(
  to: string,
  text: string,
  mediaUrl: string,
  opts: SendVkOptions = {},
): Promise<SendVkResult> {
  vkDiag("send media", { to, mediaUrl, textLen: (text ?? "").length });
  const result = await sendPayloadVk(
    to,
    {
      text,
      mediaUrl,
    },
    opts,
  );
  if (!result) {
    throw new Error("VK formatted media delivery produced no result");
  }
  return result;
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

// VK reaction id catalog as returned by messages.getReactionsAssets (16 items):
//   1=❤️ 2=🔥 3=😂 4=👍 5=💩 6=⁉️ 7=😭 8=😡
//   9=👎 10=👌 11=😄 12=🤔 13=🙏 14=😘 15=😍 16=🎉
const VK_REACTION_ID_DEFAULT = 4; // 👍

const VK_REACTION_ID_BY_EMOJI: Readonly<Record<string, number>> = {
  "❤️": 1,
  "❤": 1,
  "🔥": 2,
  "😂": 3,
  "🤣": 3,
  "👍": 4,
  "💩": 5,
  "⁉️": 6,
  "⁉": 6,
  "😭": 7,
  "😡": 8,
  "👎": 9,
  "👌": 10,
  "😄": 11,
  "🤔": 12,
  "🙏": 13,
  "😘": 14,
  "😍": 15,
  "🎉": 16,
};

export function mapEmojiToVkReactionId(emoji: string): number {
  return VK_REACTION_ID_BY_EMOJI[emoji] ?? VK_REACTION_ID_DEFAULT;
}

export async function sendReactionVk(
  to: string,
  cmid: number,
  emoji: string,
  account: ResolvedVkAccount,
): Promise<boolean> {
  if (!account.token) {
    return false;
  }
  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId) || !Number.isFinite(cmid)) {
    return false;
  }
  const reactionId = mapEmojiToVkReactionId(emoji);
  const vk = getOrCreateVk(account.token);
  await withVkRetry(async () => {
    await vk.api.messages.sendReaction({
      peer_id: peerId,
      cmid,
      reaction_id: reactionId,
    });
  });
  return true;
}

export async function deleteReactionVk(
  to: string,
  cmid: number,
  account: ResolvedVkAccount,
): Promise<void> {
  if (!account.token) {
    return;
  }
  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId) || !Number.isFinite(cmid)) {
    return;
  }
  const vk = getOrCreateVk(account.token);
  await withVkRetry(async () => {
    await vk.api.messages.deleteReaction({
      peer_id: peerId,
      cmid,
    });
  });
}

/**
 * Edit an already-sent bot message in place. Used by the step-progress draft
 * (progress-draft.ts) to rewrite a single "live" message with the running list
 * of execution steps. `messageId` is the value returned as `SendVkResult.messageId`
 * (the message_id from messages.send). Returns false when the account/target is
 * unusable so the caller can fall back to a fresh send.
 */
export async function editMessageVk(
  to: string,
  messageId: number,
  text: string,
  account: ResolvedVkAccount,
  opts: { formatData?: VkPreparedFormattedMessage["formatData"] } = {},
): Promise<boolean> {
  if (!account.token) {
    return false;
  }
  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId) || !Number.isFinite(messageId) || messageId <= 0) {
    return false;
  }
  const vk = getOrCreateVk(account.token);
  const editParams: Record<string, unknown> = {
    peer_id: peerId,
    message_id: messageId,
    message: text,
    keep_forward_messages: 1,
    keep_snippets: 1,
  };
  // format_data carries VK's rich-text runs (markdown). It is a real messages.edit
  // param but not typed by vk-io, so build the params loosely and cast on the call.
  if (opts.formatData && opts.formatData.items.length > 0) {
    editParams.format_data = JSON.stringify(opts.formatData);
  }
  await withVkRetry(async () => {
    await vk.api.messages.edit(
      editParams as unknown as Parameters<typeof vk.api.messages.edit>[0],
    );
  });
  return true;
}

/**
 * Delete a bot message the plugin previously sent (e.g. drop the progress draft
 * when the final answer is delivered as a separate message). Best-effort:
 * failures are swallowed by withVkRetry semantics and never block delivery.
 */
export async function deleteMessageVk(
  to: string,
  messageId: number,
  account: ResolvedVkAccount,
): Promise<void> {
  if (!account.token) {
    return;
  }
  const peerId = Number(normalizeVkTargetId(to));
  if (Number.isNaN(peerId) || !Number.isFinite(messageId) || messageId <= 0) {
    return;
  }
  const vk = getOrCreateVk(account.token);
  await withVkRetry(async () => {
    await vk.api.messages.delete({
      peer_id: peerId,
      message_ids: [messageId],
      delete_for_all: 1,
    });
  });
}

async function sendMessageChunksVk(params: {
  to: string;
  chunks: VkPreparedFormattedMessage[];
  opts: SendVkOptions;
}): Promise<SendVkResult[]> {
  const { account, peerId, to: normalizedTo } = await resolveSendTarget({
    cfg: params.opts.cfg,
    accountId: params.opts.accountId,
    to: params.to,
  });

  const results: SendVkResult[] = [];
  for (let index = 0; index < params.chunks.length; index += 1) {
    const chunk = params.chunks[index];
    if (!chunk || !chunk.text) {
      continue;
    }
    const isLast = index === params.chunks.length - 1;
    const result = await sendVkApiMessage({
      to: normalizedTo,
      peerId,
      account,
      formatted: chunk,
      opts: {
        ...params.opts,
        replyTo: index === 0 ? params.opts.replyTo : undefined,
        buttons: isLast ? params.opts.buttons : undefined,
        clearKeyboard: isLast ? params.opts.clearKeyboard : undefined,
      },
    });
    results.push(result);
  }
  return results;
}

async function sendResolvedMediaVk(params: {
  to: string;
  media: VkOutboundMediaReference;
  caption?: VkPreparedFormattedMessage;
  opts: SendVkOptions;
}): Promise<SendVkResult> {
  const media = await loadVkOutboundMedia({
    mediaUrl: params.media.url,
    mediaLocalRoots: params.opts.mediaLocalRoots,
    forceDocument: params.opts.forceDocument,
    preferredName: params.media.title,
    preferredMimeType: params.media.mimeType,
  });
  const sourceUrl = isHttpUrl(media.mediaUrl) ? media.mediaUrl : undefined;

  const sendSourceUrlFallback = async (): Promise<SendVkResult> => {
    if (!sourceUrl) {
      const captionText = params.caption?.text.trim();
      const fallbackText = captionText
        ? `${captionText}\n${VK_MEDIA_SCOPE_FALLBACK_NOTICE}`
        : VK_MEDIA_SCOPE_FALLBACK_NOTICE;
      return await sendMessageVk(params.to, fallbackText, params.opts);
    }
    const captionText = params.caption?.text.trim();
    const fallbackText = captionText ? `${captionText}\n${sourceUrl}` : sourceUrl;
    return await sendMessageVk(params.to, fallbackText, params.opts);
  };

  if (media.kind === "image") {
    let photoSource: string | Buffer = media.source;
    let photoError: unknown;
    try {
      return await sendPhotoVk(params.to, photoSource, params.caption, params.opts, {
        filename: media.title,
        contentType: media.mimeType,
        retryTransientPhotoErrors: !sourceUrl,
      });
    } catch (error) {
      photoError = error;
    }

    if (sourceUrl && typeof photoSource === "string" && isVkPhotoSourceRejectedError(photoError)) {
      const materialized = await materializeRemoteVkPhotoSource(sourceUrl);
      if (!materialized) {
        return await sendSourceUrlFallback();
      }
      photoSource = materialized;
      try {
        return await sendPhotoVk(params.to, photoSource, params.caption, params.opts, {
          filename: media.title,
          contentType: media.mimeType,
        });
      } catch (retryPhotoError) {
        photoError = retryPhotoError;
      }
    }

    const shouldFallbackToDocument = isVkImageUploadFallbackError(photoError);
    if (!shouldFallbackToDocument) {
      throw photoError;
    }

    try {
      return await sendDocumentVk(params.to, photoSource, media.title, params.caption, params.opts, {
        contentType: media.mimeType,
      });
    } catch (documentError) {
      if (!isVkImageUploadFallbackError(documentError)) {
        throw documentError;
      }
      return await sendSourceUrlFallback();
    }
  }
  if (media.kind === "audio_message") {
    try {
      return await sendAudioMessageVk(params.to, media.source, media.title, params.caption, params.opts, {
        contentType: media.mimeType,
      });
    } catch (audioError) {
      // Voice is best-effort: log the *real* VK error (code/message) for
      // diagnosis, then fall back to text rather than dropping the reply or
      // mislabelling it as a scopes problem.
      vkDiagFailure("audio send failed", audioError, {
        to: params.to,
        scopeDenied: isVkScopeDeniedError(audioError),
      });
      return await sendSourceUrlFallback();
    }
  }
  try {
    return await sendDocumentVk(params.to, media.source, media.title, params.caption, params.opts, {
      contentType: media.mimeType,
    });
  } catch (documentError) {
    if (!isVkScopeDeniedError(documentError)) {
      throw documentError;
    }
    return await sendSourceUrlFallback();
  }
}

async function sendPayloadMediaVk(params: {
  to: string;
  mediaRefs: VkOutboundMediaReference[];
  text: string;
  opts: SendVkOptions;
}): Promise<SendVkResult[]> {
  const textChunks = prepareVkMessageChunks(params.text);
  let firstCaption = textChunks.shift();
  const results: SendVkResult[] = [];

  for (let index = 0; index < params.mediaRefs.length; index += 1) {
    const mediaRef = params.mediaRefs[index];
    const isLastMedia = index === params.mediaRefs.length - 1;
    const shouldApplyKeyboard = isLastMedia && textChunks.length === 0;
    const result = await sendResolvedMediaVk({
      to: params.to,
      media: mediaRef as VkOutboundMediaReference,
      caption: firstCaption,
      opts: {
        ...params.opts,
        replyTo: index === 0 ? params.opts.replyTo : undefined,
        buttons: shouldApplyKeyboard ? params.opts.buttons : undefined,
        clearKeyboard: shouldApplyKeyboard ? params.opts.clearKeyboard : undefined,
      },
    });
    // Closes the send-path trace: the upload reported above, and here we see
    // whether the attachment made it into the message. Without this, "the image
    // did not arrive" is indistinguishable from "the image was never sent".
    vkDiag("media sent", {
      index: index + 1,
      total: params.mediaRefs.length,
      messageId: result.messageId || null,
    });
    results.push(result);
    firstCaption = undefined;
  }

  if (textChunks.length > 0) {
    const textResults = await sendMessageChunksVk({
      to: params.to,
      chunks: textChunks,
      opts: {
        ...params.opts,
        replyTo: undefined,
      },
    });
    results.push(...textResults);
  }

  return results;
}

async function sendPayloadResultsVk(params: {
  to: string;
  text: string;
  mediaRefs: VkOutboundMediaReference[];
  opts: SendVkOptions;
}): Promise<SendVkResult[]> {
  if (!params.text && params.mediaRefs.length === 0) {
    return [];
  }

  if (params.mediaRefs.length > 0) {
    return await sendPayloadMediaVk(params);
  }

  return await sendMessageChunksVk({
    to: params.to,
    chunks: prepareVkMessageChunks(params.text),
    opts: params.opts,
  });
}

export async function sendPayloadVk(
  to: string,
  payload: VkOutboundPayloadLike,
  opts: SendVkOptions = {},
): Promise<SendVkResult | null> {
  const { text, mediaRefs, buttons, replyTo, clearKeyboard } = resolveVkPayloadParts(payload, opts);
  vkDiag("send payload", {
    to,
    media: (mediaRefs ?? []).length,
    mediaRefs: (mediaRefs ?? []).map((r) => r?.url),
    textLen: (text ?? "").length,
  });

  return getLastSendResult(
    await sendPayloadResultsVk({
      to,
      text,
      mediaRefs,
      opts: {
        ...opts,
        replyTo,
        buttons,
        clearKeyboard,
      },
    }),
  );
}

export function clearVkInstances(): void {
  vkInstances.clear();
}
