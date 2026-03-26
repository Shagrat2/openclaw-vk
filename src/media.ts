import { readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { VkInboundAttachment, VkInboundResolvedMedia } from "./types.js";

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

const DATA_URL_DEFAULT_NAME = "attachment.bin";
const DEFAULT_VK_INBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".bmp": "image/bmp",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export type VkResolvedOutboundMedia = {
  kind: "image" | "document" | "audio_message";
  source: string | Buffer;
  title: string;
  mediaUrl: string;
};

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function pickFirstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function mimeFromExtension(ext?: string): string | undefined {
  const normalized = ext?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return MIME_BY_EXTENSION[normalized.startsWith(".") ? normalized : `.${normalized}`];
}

function extensionFromMimeType(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase().split(";")[0];
  if (!normalized) {
    return undefined;
  }
  const entry = Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === normalized);
  return entry?.[0];
}

function mimeFromUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return mimeFromExtension(extname(parsed.pathname));
  } catch {
    return mimeFromExtension(extname(value));
  }
}

function readImageUrlList(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const urls = value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      return pickFirstString([
        readString(record, "url"),
        readString(record, "src"),
        readString(record, "baseUrl"),
      ]);
    })
    .filter((entry): entry is string => Boolean(entry));
  return urls.at(-1);
}

function readPhotoPreviewUrl(record: Record<string, unknown>): string | undefined {
  const preview =
    record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
      ? (record.preview as Record<string, unknown>)
      : undefined;
  if (!preview) {
    return undefined;
  }
  return readImageUrlList(preview.photo);
}

function readGraffitiPreviewUrl(record: Record<string, unknown>): string | undefined {
  const preview =
    record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
      ? (record.preview as Record<string, unknown>)
      : undefined;
  if (!preview?.graffiti || typeof preview.graffiti !== "object" || Array.isArray(preview.graffiti)) {
    return undefined;
  }
  return readString(preview.graffiti as Record<string, unknown>, "src");
}

function readAudioMessagePreviewUrl(record: Record<string, unknown>): string | undefined {
  const preview =
    record.preview && typeof record.preview === "object" && !Array.isArray(record.preview)
      ? (record.preview as Record<string, unknown>)
      : undefined;
  if (
    !preview?.audio_message ||
    typeof preview.audio_message !== "object" ||
    Array.isArray(preview.audio_message)
  ) {
    return undefined;
  }
  const audioPreview = preview.audio_message as Record<string, unknown>;
  return pickFirstString([
    readString(audioPreview, "link_mp3"),
    readString(audioPreview, "link_ogg"),
  ]);
}

function normalizeVkAttachmentKind(type: string, record: Record<string, unknown>): string {
  switch (type) {
    case "photo":
      return "image";
    case "doc":
    case "document":
      if (readBoolean(record, "isImage")) {
        return "image";
      }
      if (readBoolean(record, "isAudio") || readBoolean(record, "isVoice")) {
        return "audio";
      }
      if (readBoolean(record, "isVideo")) {
        return "video";
      }
      return "document";
    case "audio_message":
      return "audio";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "sticker":
      return "sticker";
    case "graffiti":
      return "image";
    case "link":
      return "link";
    default:
      return type || "attachment";
  }
}

function normalizeVkAttachmentTitle(type: string, record: Record<string, unknown>): string | undefined {
  if (type === "audio_message") {
    return "voice-message";
  }
  return pickFirstString([
    readString(record, "title"),
    readString(record, "name"),
    readString(record, "caption"),
    readString(record, "text"),
  ]);
}

function normalizeVkAttachmentUrl(type: string, record: Record<string, unknown>): string | undefined {
  switch (type) {
    case "photo":
      return pickFirstString([
        readString(record, "largeSizeUrl"),
        readString(record, "mediumSizeUrl"),
        readString(record, "smallSizeUrl"),
        readString(record, "url"),
        readImageUrlList(record.sizes),
      ]);
    case "doc":
    case "document":
      return pickFirstString([
        readPhotoPreviewUrl(record),
        readGraffitiPreviewUrl(record),
        readAudioMessagePreviewUrl(record),
        readString(record, "url"),
        readString(record, "previewUrl"),
      ]);
    case "audio_message":
      return pickFirstString([
        readString(record, "mp3Url"),
        readString(record, "oggUrl"),
        readString(record, "url"),
      ]);
    case "audio":
      return readString(record, "url");
    case "video":
      return pickFirstString([readString(record, "player"), readString(record, "url")]);
    case "sticker":
    case "graffiti":
      return pickFirstString([
        readImageUrlList(record.imagesWithBackground),
        readImageUrlList(record.images),
        readString(record, "url"),
      ]);
    case "link":
      return readString(record, "url");
    default:
      return readString(record, "url");
  }
}

function inferVkAttachmentMimeType(
  type: string,
  record: Record<string, unknown>,
  url?: string,
): string | undefined {
  const fromUrl = mimeFromUrl(url);
  switch (type) {
    case "photo":
      return fromUrl ?? "image/jpeg";
    case "sticker":
    case "graffiti":
      return fromUrl ?? "image/png";
    case "audio_message":
      if (typeof record.mp3Url === "string" && record.mp3Url.trim()) {
        return "audio/mpeg";
      }
      if (typeof record.oggUrl === "string" && record.oggUrl.trim()) {
        return "audio/ogg";
      }
      return fromUrl ?? "audio/ogg";
    case "audio":
      return fromUrl;
    case "video":
      return fromUrl;
    case "doc":
    case "document": {
      const typeId = typeof record.typeId === "number" ? record.typeId : undefined;
      const ext = readString(record, "ext") ?? readString(record, "extension");
      const fromExt = mimeFromExtension(ext);
      if (readBoolean(record, "isImage") || typeId === 4) {
        return fromExt ?? fromUrl ?? "image/jpeg";
      }
      if (readBoolean(record, "isAudio") || readBoolean(record, "isVoice") || typeId === 5) {
        return fromExt ?? fromUrl ?? "audio/ogg";
      }
      if (readBoolean(record, "isVideo") || typeId === 6) {
        return fromExt ?? fromUrl ?? "video/mp4";
      }
      return fromExt ?? fromUrl;
    }
    default:
      return fromUrl;
  }
}

export function extractVkInboundAttachments(rawAttachments: unknown): VkInboundAttachment[] {
  if (!Array.isArray(rawAttachments)) {
    return [];
  }

  return rawAttachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return undefined;
      }
      const record = attachment as Record<string, unknown>;
      const type = readString(record, "type") ?? "attachment";
      const url = normalizeVkAttachmentUrl(type, record);
      return {
        type,
        kind: normalizeVkAttachmentKind(type, record),
        url,
        title: normalizeVkAttachmentTitle(type, record),
        mimeType: inferVkAttachmentMimeType(type, record, url),
      } satisfies VkInboundAttachment;
    })
    .filter((attachment): attachment is VkInboundAttachment => Boolean(attachment));
}

export function resolveVkInboundReplyContext(replyMessage: unknown): {
  replyToMessageId?: string;
  replyToText?: string;
} {
  if (!replyMessage || typeof replyMessage !== "object" || Array.isArray(replyMessage)) {
    return {};
  }
  const record = replyMessage as Record<string, unknown>;
  const replyToMessageId = pickFirstString([
    typeof record.id === "number" ? String(record.id) : undefined,
    readString(record, "id"),
  ]);
  const replyToText = pickFirstString([readString(record, "text"), readString(record, "message")]);
  return {
    replyToMessageId,
    replyToText,
  };
}

export function resolveVkInboundMediaUrls(
  attachments: readonly VkInboundAttachment[] | undefined,
): string[] {
  return Array.from(
    new Set(
      (attachments ?? [])
        .map((attachment) => attachment.url?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
}

export function resolveVkInboundMediaTypes(
  attachments: readonly VkInboundAttachment[] | undefined,
): string[] {
  return Array.from(
    new Set(
      (attachments ?? [])
        .map(
          (attachment) =>
            attachment.mimeType?.trim() || attachment.kind?.trim() || attachment.type?.trim(),
        )
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
}

function shouldMaterializeVkInboundAttachment(attachment: VkInboundAttachment): boolean {
  const kind = attachment.kind?.trim().toLowerCase();
  const type = attachment.type?.trim().toLowerCase();
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (!attachment.url?.trim()) {
    return false;
  }
  if (kind === "link" || type === "link") {
    return false;
  }
  if (mimeType?.startsWith("image/") || mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) {
    return true;
  }
  return kind === "image" || kind === "audio" || kind === "video" || kind === "document" || kind === "sticker";
}

function buildVkInboundMediaFileHint(attachment: VkInboundAttachment): string {
  const title = attachment.title?.trim();
  if (title) {
    return basename(title);
  }
  const sourceUrl = attachment.url?.trim();
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      const name = basename(parsed.pathname);
      if (name) {
        return name;
      }
    } catch {
      const name = basename(sourceUrl);
      if (name) {
        return name;
      }
    }
  }
  const ext = extensionFromMimeType(attachment.mimeType) ?? "";
  return `${attachment.kind || attachment.type || "attachment"}${ext}`;
}

export async function resolveVkInboundResolvedMedia(params: {
  attachments?: readonly VkInboundAttachment[];
  mediaRuntime?: Pick<PluginRuntime["channel"]["media"], "fetchRemoteMedia" | "saveMediaBuffer">;
  maxBytes?: number;
  logError?: (line: string) => void;
}): Promise<VkInboundResolvedMedia[]> {
  const attachments = params.attachments ?? [];
  if (attachments.length === 0) {
    return [];
  }

  const maxBytes = params.maxBytes ?? DEFAULT_VK_INBOUND_MEDIA_MAX_BYTES;
  const out: VkInboundResolvedMedia[] = [];
  for (const attachment of attachments) {
    const url = attachment.url?.trim();
    if (!url) {
      continue;
    }
    if (!params.mediaRuntime || !shouldMaterializeVkInboundAttachment(attachment)) {
      out.push({
        url,
        contentType: attachment.mimeType,
        attachment,
      });
      continue;
    }

    try {
      const fileHint = buildVkInboundMediaFileHint(attachment);
      const fetched = await params.mediaRuntime.fetchRemoteMedia({
        url,
        filePathHint: fileHint,
        maxBytes,
      });
      const saved = await params.mediaRuntime.saveMediaBuffer(
        Buffer.from(fetched.buffer),
        fetched.contentType ?? attachment.mimeType,
        "inbound",
        maxBytes,
        fileHint,
      );
      out.push({
        path: saved.path,
        url,
        contentType: saved.contentType ?? attachment.mimeType,
        attachment,
      });
    } catch (err) {
      params.logError?.(`vk: inbound media download failed for ${url}: ${String(err)}`);
      out.push({
        url,
        contentType: attachment.mimeType,
        attachment,
      });
    }
  }
  return out;
}

export function resolveVkInboundResolvedMediaPaths(
  media: readonly VkInboundResolvedMedia[] | undefined,
): string[] {
  return (media ?? [])
    .map((entry) => entry.path?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

export function resolveVkInboundResolvedMediaUrls(
  media: readonly VkInboundResolvedMedia[] | undefined,
): string[] {
  return (media ?? [])
    .filter((entry) => Boolean(entry.path?.trim()))
    .map((entry) => entry.url.trim())
    .filter(Boolean);
}

export function resolveVkInboundResolvedMediaTypes(
  media: readonly VkInboundResolvedMedia[] | undefined,
): string[] {
  return (media ?? [])
    .filter((entry) => Boolean(entry.path?.trim()))
    .map((entry) => entry.contentType?.trim() || entry.attachment.mimeType?.trim())
    .filter((entry): entry is string => Boolean(entry));
}

export function resolveVkInboundBodyText(params: {
  text?: string | null;
  attachments?: readonly VkInboundAttachment[];
}): string {
  const trimmedText = params.text?.trim() ?? "";
  if (trimmedText) {
    return trimmedText;
  }

  const mediaKinds = Array.from(
    new Set(
      (params.attachments ?? [])
        .map((attachment) => attachment.kind?.trim() || attachment.type?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  if (mediaKinds.length === 0) {
    return "";
  }

  return `<media:${mediaKinds[0] ?? "attachment"}>`;
}

function isHttpMediaUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value);
}

function inferDocumentNameFromUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.trim();
    const name = basename(pathname);
    return name || "attachment";
  } catch {
    return basename(value) || "attachment";
  }
}

function inferOutboundKind(params: {
  name: string;
  mimeType?: string;
  forceDocument?: boolean;
}): "image" | "document" | "audio_message" {
  if (params.forceDocument) {
    return "document";
  }
  const mimeType = params.mimeType?.trim().toLowerCase();
  if (mimeType && mimeType.startsWith("image/") && mimeType !== "image/gif") {
    return "image";
  }
  if (mimeType && mimeType.startsWith("audio/")) {
    return "audio_message";
  }
  const extension = extname(params.name).trim().toLowerCase();
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio_message";
  }
  return IMAGE_EXTENSIONS.has(extension) ? "image" : "document";
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType?: string; name: string } {
  const match = dataUrl.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  const mimeType = match[1]?.trim().toLowerCase() || undefined;
  const isBase64 = Boolean(match[2]);
  const body = match[3] ?? "";
  const buffer = isBase64
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body), "utf8");
  const extension =
    mimeType === "image/png"
      ? ".png"
      : mimeType === "image/jpeg"
        ? ".jpg"
        : mimeType === "image/webp"
          ? ".webp"
          : mimeType === "audio/mpeg"
            ? ".mp3"
            : mimeType === "audio/ogg"
              ? ".ogg"
              : mimeType === "audio/opus"
                ? ".opus"
                : mimeType === "audio/wav"
                  ? ".wav"
                  : mimeType === "audio/aac"
                    ? ".aac"
                    : mimeType === "audio/flac"
                      ? ".flac"
                      : mimeType === "audio/mp4"
                        ? ".m4a"
          : mimeType === "application/pdf"
            ? ".pdf"
            : "";
  const name = extension ? `attachment${extension}` : DATA_URL_DEFAULT_NAME;
  return { buffer, mimeType, name };
}

async function resolveAllowedLocalPath(
  input: string,
  mediaLocalRoots?: readonly string[],
): Promise<string> {
  const normalizedInput = input.startsWith("file://") ? fileURLToPath(input) : input;
  const absolutePath = isAbsolute(normalizedInput)
    ? normalizedInput
    : resolvePath(normalizedInput);
  const resolvedPath = await realpath(absolutePath);

  if (!mediaLocalRoots?.length) {
    return resolvedPath;
  }

  const resolvedRoots = (
    await Promise.all(
      mediaLocalRoots.map(async (root) => {
        const trimmed = root?.trim();
        if (!trimmed) {
          return null;
        }
        try {
          return await realpath(trimmed);
        } catch {
          return null;
        }
      }),
    )
  ).filter((entry): entry is string => Boolean(entry));

  const isAllowed = resolvedRoots.some(
    (root) => resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`),
  );
  if (!isAllowed) {
    throw new Error(`Local media path is outside allowed roots: ${input}`);
  }

  return resolvedPath;
}

export async function loadVkOutboundMedia(params: {
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  forceDocument?: boolean;
}): Promise<VkResolvedOutboundMedia> {
  const mediaUrl = params.mediaUrl.trim();
  if (!mediaUrl) {
    throw new Error("Missing media URL");
  }

  if (isDataUrl(mediaUrl)) {
    const decoded = decodeDataUrl(mediaUrl);
    return {
      kind: inferOutboundKind({
        name: decoded.name,
        mimeType: decoded.mimeType,
        forceDocument: params.forceDocument,
      }),
      source: decoded.buffer,
      title: decoded.name,
      mediaUrl,
    };
  }

  if (isHttpMediaUrl(mediaUrl)) {
    const title = inferDocumentNameFromUrl(mediaUrl);
    return {
      kind: inferOutboundKind({
        name: title,
        forceDocument: params.forceDocument,
      }),
      source: mediaUrl,
      title,
      mediaUrl,
    };
  }

  const localPath = await resolveAllowedLocalPath(mediaUrl, params.mediaLocalRoots);
  const title = basename(localPath) || "attachment";
  return {
    kind: inferOutboundKind({
      name: title,
      forceDocument: params.forceDocument,
    }),
    source: await readFile(localPath),
    title,
    mediaUrl: localPath,
  };
}
