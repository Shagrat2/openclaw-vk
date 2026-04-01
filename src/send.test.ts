import { beforeEach, describe, expect, it, vi } from "vitest";
import { VK } from "vk-io";
import {
  applyVkAllowlistConfigEdit,
  clearVkInstances,
  isVkGroupPeerId,
  markMessageReadVk,
  normalizeVkDirectoryEntries,
  normalizeVkSenderAllowEntry,
  normalizeVkTargetId,
  primeVkGroupId,
  readVkAllowlistConfig,
  resolveVkDirectoryGroups,
  resolveVkDirectoryPeers,
  sendDocumentVk,
  sendAudioMessageVk,
  sendMessageVk,
  sendPayloadVk,
  sendPhotoVk,
  sendTypingVk,
} from "./send.js";
import { makeAccount } from "./test-helpers.js";

// ── SDK mocks (for transitive accounts.ts import) ───────────────────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/account-id", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

const mockChunkMarkdownText = vi.hoisted(() => vi.fn((text: string) => [text]));
const mockGetVkRuntime = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    channel: {
      activity: { record: vi.fn() },
      text: { chunkMarkdownText: mockChunkMarkdownText },
    },
    config: { loadConfig: vi.fn().mockReturnValue({}) },
  }),
);

vi.mock("./runtime.js", () => ({
  getVkRuntime: mockGetVkRuntime,
}));

const mockMessagesSend = vi.hoisted(() => vi.fn());
const mockMessagesMarkAsRead = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockSetActivity = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockUploadPhoto = vi.hoisted(() => vi.fn().mockResolvedValue("photo123_456"));
const mockUploadDocument = vi.hoisted(() => vi.fn().mockResolvedValue("doc123_789"));
const mockUploadAudioMessage = vi.hoisted(() => vi.fn().mockResolvedValue("audio_message123_789"));
const mockGroupsGetById = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] }),
);
const mockGetRandomId = vi.hoisted(() => vi.fn().mockReturnValue(99999));

vi.mock("vk-io", () => ({
  // Must use a regular function (not an arrow) so `new VK(...)` works.
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        groups: {
          getById: mockGroupsGetById,
        },
        messages: {
          send: mockMessagesSend,
          markAsRead: mockMessagesMarkAsRead,
          setActivity: mockSetActivity,
        },
      },
      upload: {
        messagePhoto: mockUploadPhoto,
        messageDocument: mockUploadDocument,
        audioMessage: mockUploadAudioMessage,
      },
    };
  }),
  getRandomId: mockGetRandomId,
}));

const TOKEN = "test-token";
const cfg = { channels: { vk: { token: TOKEN } } } as never;

describe("sendMessageVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    mockMessagesMarkAsRead.mockReset().mockResolvedValue(1);
    mockSetActivity.mockReset().mockResolvedValue(1);
    mockUploadPhoto.mockReset().mockResolvedValue("photo123_456");
    mockUploadDocument.mockReset().mockResolvedValue("doc123_789");
    mockUploadAudioMessage.mockReset().mockResolvedValue("audio_message123_789");
    mockGroupsGetById.mockReset().mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] });
    mockChunkMarkdownText.mockReset().mockImplementation((text: string) => [text]);
    // Reset the constructor call count so per-test assertions stay isolated.
    vi.mocked(VK).mockClear();
  });

  it("sends a text message and returns messageId + chatId", async () => {
    mockMessagesSend.mockResolvedValueOnce(42);

    const result = await sendMessageVk("123456", "hello", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith({
      peer_id: 123456,
      message: "hello",
      random_id: 99999,
    });
    expect(result).toEqual({ messageId: "42", chatId: "123456" });
  });

  it("adds format_data when markdown formatting is present", async () => {
    mockMessagesSend.mockResolvedValueOnce(99);

    await sendMessageVk(
      "123456",
      "**bold** and *italic* and ***both*** with [link](https://example.com)",
      { cfg },
    );

    const call = mockMessagesSend.mock.calls[0][0];
    expect(call.message).toBe("bold and italic and both with link");
    expect(call.format_data).toBeDefined();
    const formatData = JSON.parse(call.format_data as string) as {
      version: number;
      items: Array<{ type: string; offset: number; length: number; url?: string }>;
    };
    expect(formatData.version).toBe(1);
    expect(formatData.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 9, length: 6 },
        { type: "bold", offset: 20, length: 4 },
        { type: "italic", offset: 20, length: 4 },
        { type: "url", offset: 30, length: 4, url: "https://example.com" },
      ]),
    );
  });

  it("throws when peer ID is not a number", async () => {
    await expect(
      sendMessageVk("not-a-number", "text", { cfg }),
    ).rejects.toThrow("Invalid VK peer ID: not-a-number");
  });

  it("accepts vk-prefixed direct targets", async () => {
    mockMessagesSend.mockResolvedValueOnce(43);

    const result = await sendMessageVk("vk:123456", "hello", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: 123456 }),
    );
    expect(result).toEqual({ messageId: "43", chatId: "123456" });
  });

  it("throws when no token is configured", async () => {
    await expect(
      sendMessageVk("123", "text", { cfg: {} as never }),
    ).rejects.toThrow("VK token not configured");
  });

  it("truncates message text to 4096 characters", async () => {
    mockMessagesSend.mockResolvedValueOnce(1);
    const longText = "a".repeat(5000);

    await sendMessageVk("123", longText, { cfg });

    const sentText = mockMessagesSend.mock.calls[0][0].message as string;
    expect(sentText.length).toBe(4096);
  });

  it("includes reply_to when provided", async () => {
    mockMessagesSend.mockResolvedValueOnce(5);

    await sendMessageVk("123", "reply", { cfg, replyTo: "77" });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ reply_to: 77 }),
    );
  });

  it("does not include reply_to when not provided", async () => {
    mockMessagesSend.mockResolvedValueOnce(5);

    await sendMessageVk("123", "msg", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.not.objectContaining({ reply_to: expect.anything() }),
    );
  });

  it("forwards keyboard when buttons are provided", async () => {
    mockMessagesSend.mockResolvedValueOnce(7);

    await sendMessageVk("123", "menu", {
      cfg,
      buttons: [[{ text: "Browse providers", callback_data: "/models", style: "primary" }]],
    });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        keyboard: expect.any(String),
      }),
    );
  });

  it("reuses the same VK instance for the same token", async () => {
    mockMessagesSend.mockResolvedValue(1);

    await sendMessageVk("1", "a", { cfg });
    await sendMessageVk("2", "b", { cfg });

    expect(vi.mocked(VK)).toHaveBeenCalledTimes(1);
  });

  it("creates a separate VK instance for a different token", async () => {
    mockMessagesSend.mockResolvedValue(1);

    await sendMessageVk("1", "a", { cfg });
    await sendMessageVk("1", "b", {
      cfg: { channels: { vk: { token: "other-token" } } } as never,
    });

    expect(vi.mocked(VK)).toHaveBeenCalledTimes(2);
  });

  it("works with group chat peer IDs (>= 2_000_000_000)", async () => {
    mockMessagesSend.mockResolvedValueOnce(10);
    const groupPeerId = "2000000001";

    const result = await sendMessageVk(groupPeerId, "hi group", { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: 2_000_000_001 }),
    );
    expect(result.chatId).toBe(groupPeerId);
  });
});

// ── sendPhotoVk ──────────────────────────────────────────────────────────────

describe("sendPhotoVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    mockUploadPhoto.mockReset().mockResolvedValue("photo123_456");
    vi.mocked(VK).mockClear();
  });

  it("uploads photo and sends message with attachment", async () => {
    mockMessagesSend.mockResolvedValueOnce(99);

    const result = await sendPhotoVk("123", "https://example.com/img.png", "caption", { cfg });

    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: { value: "https://example.com/img.png" },
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: 123,
        message: "caption",
        attachment: "photo123_456",
      }),
    );
    expect(result).toEqual({ messageId: "99", chatId: "123" });
  });

  it("sends empty message text when no caption", async () => {
    mockMessagesSend.mockResolvedValueOnce(1);

    await sendPhotoVk("123", Buffer.from("png"), undefined, { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ message: "" }),
    );
  });

  it("truncates caption to 4096 characters", async () => {
    mockMessagesSend.mockResolvedValueOnce(1);

    await sendPhotoVk("123", "src", "a".repeat(5000), { cfg });

    const sentText = mockMessagesSend.mock.calls[0][0].message as string;
    expect(sentText.length).toBe(4096);
  });

  it("throws when token is not configured", async () => {
    await expect(
      sendPhotoVk("123", "src", undefined, { cfg: {} as never }),
    ).rejects.toThrow("VK token not configured");
  });

  it("throws when peer ID is invalid", async () => {
    await expect(
      sendPhotoVk("abc", "src", undefined, { cfg }),
    ).rejects.toThrow("Invalid VK peer ID: abc");
  });
});

// ── sendDocumentVk ───────────────────────────────────────────────────────────

describe("sendDocumentVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    mockUploadDocument.mockReset().mockResolvedValue("doc123_789");
    vi.mocked(VK).mockClear();
  });

  it("uploads document and sends message with attachment", async () => {
    mockMessagesSend.mockResolvedValueOnce(77);

    const result = await sendDocumentVk("456", Buffer.from("pdf"), "report.pdf", "Here is the report", { cfg });

    expect(mockUploadDocument).toHaveBeenCalledWith({
      peer_id: 456,
      source: { value: Buffer.from("pdf") },
      title: "report.pdf",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: 456,
        message: "Here is the report",
        attachment: "doc123_789",
      }),
    );
    expect(result).toEqual({ messageId: "77", chatId: "456" });
  });

  it("sends empty message text when no caption", async () => {
    mockMessagesSend.mockResolvedValueOnce(1);

    await sendDocumentVk("123", "src", "file.txt", undefined, { cfg });

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ message: "" }),
    );
  });

  it("throws when token is not configured", async () => {
    await expect(
      sendDocumentVk("123", "src", "file.txt", undefined, { cfg: {} as never }),
    ).rejects.toThrow("VK token not configured");
  });

  it("throws when peer ID is invalid", async () => {
    await expect(
      sendDocumentVk("abc", "src", "file.txt", undefined, { cfg }),
    ).rejects.toThrow("Invalid VK peer ID: abc");
  });
});

describe("sendAudioMessageVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    mockUploadAudioMessage.mockReset().mockResolvedValue("audio_message123_789");
    vi.mocked(VK).mockClear();
  });

  it("uploads audio as VK audio_message and sends it as attachment", async () => {
    mockMessagesSend.mockResolvedValueOnce(88);

    const result = await sendAudioMessageVk("456", "https://example.com/voice.mp3", "voice.mp3", "caption", {
      cfg,
    });

    expect(mockUploadAudioMessage).toHaveBeenCalledWith({
      peer_id: 456,
      source: { value: "https://example.com/voice.mp3" },
      title: "voice.mp3",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        peer_id: 456,
        message: "caption",
        attachment: "audio_message123_789",
      }),
    );
    expect(result).toEqual({ messageId: "88", chatId: "456" });
  });
});

// ── sendTypingVk ─────────────────────────────────────────────────────────────

describe("sendTypingVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesMarkAsRead.mockReset().mockResolvedValue(1);
    mockSetActivity.mockReset().mockResolvedValue(1);
    mockGroupsGetById.mockReset().mockResolvedValue({ groups: [{ id: 12345678, name: "Test Group" }] });
    vi.mocked(VK).mockClear();
  });

  it("sends typing indicator", async () => {
    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith({
      group_id: 12345678,
      peer_id: 123,
      type: "typing",
    });
  });

  it("silently returns when token is empty", async () => {
    await sendTypingVk("123", makeAccount({ token: "" }));

    expect(mockSetActivity).not.toHaveBeenCalled();
  });

  it("silently returns when peer ID is not a number", async () => {
    await sendTypingVk("abc", makeAccount());

    expect(mockSetActivity).not.toHaveBeenCalled();
  });

  it("normalizes vk-prefixed peer IDs", async () => {
    await sendTypingVk("vk:user:123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.objectContaining({ peer_id: 123 }),
    );
  });

  it("throws typing errors so the caller can log them", async () => {
    mockSetActivity.mockRejectedValueOnce(new Error("VK API error"));

    await expect(sendTypingVk("123", makeAccount())).rejects.toThrow("VK API error");
  });

  it("omits group_id when the token group cannot be resolved", async () => {
    mockGroupsGetById.mockRejectedValueOnce(new Error("groups.getById failed"));

    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith({
      peer_id: 123,
      type: "typing",
    });
  });
});

describe("markMessageReadVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesMarkAsRead.mockReset().mockResolvedValue(1);
    vi.mocked(VK).mockClear();
  });

  it("marks the incoming VK message as read", async () => {
    await markMessageReadVk("123", "77", makeAccount());

    expect(mockMessagesMarkAsRead).toHaveBeenCalledWith({
      peer_id: 123,
      start_message_id: 77,
      mark_conversation_as_read: true,
    });
  });

  it("returns early when peer or message id is invalid", async () => {
    await markMessageReadVk("abc", "77", makeAccount());
    await markMessageReadVk("123", "nope", makeAccount());

    expect(mockMessagesMarkAsRead).not.toHaveBeenCalled();
  });

  it("normalizes vk-prefixed peer IDs before marking messages read", async () => {
    await markMessageReadVk("vk:chat:123", "77", makeAccount());

    expect(mockMessagesMarkAsRead).toHaveBeenCalledWith({
      peer_id: 123,
      start_message_id: 77,
      mark_conversation_as_read: true,
    });
  });
});

describe("sendPayloadVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset().mockResolvedValue(22);
    vi.mocked(VK).mockClear();
  });

  it("sends explicit vk buttons through sendMessageVk", async () => {
    const result = await sendPayloadVk(
      "123",
      {
        text: "Select a provider:",
        channelData: {
          vk: {
            buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
          },
        },
      },
      { cfg },
    );

    expect(result).toEqual({ messageId: "22", chatId: "123" });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a provider:",
        keyboard: expect.any(String),
      }),
    );
  });

  it("enriches parsed model text with keyboard buttons containing correct labels", async () => {
    await sendPayloadVk(
      "123",
      {
        text: [
          "Providers:",
          "- anthropic (2)",
          "- openai (3)",
          "",
          "Use: /models <provider>",
        ].join("\n"),
      },
      { cfg },
    );

    const call = mockMessagesSend.mock.calls[0][0];
    expect(call.keyboard).toBeDefined();
    const parsed = JSON.parse(call.keyboard as string) as {
      buttons: Array<Array<{ action: { label: string; payload: string } }>>;
    };
    const labels = parsed.buttons.flat().map((b) => b.action.label);
    expect(labels).toContain("anthropic");
    expect(labels).toContain("openai");

    const payloads = parsed.buttons.flat().map((b) => JSON.parse(b.action.payload));
    expect(payloads).toContainEqual({ oc: "/models anthropic" });
    expect(payloads).toContainEqual({ oc: "/models openai" });
  });

  it("returns null when payload has no text or media", async () => {
    const result = await sendPayloadVk("123", { text: "   " }, { cfg });
    expect(result).toBeNull();
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it("sends an explicit empty keyboard when clearKeyboard=true and no new buttons exist", async () => {
    await sendPayloadVk(
      "123",
      {
        text: "Done.",
      },
      { cfg, clearKeyboard: true },
    );

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        keyboard: JSON.stringify({ one_time: false, buttons: [] }),
      }),
    );
  });

  it("sends chunked text and only attaches the keyboard to the final chunk", async () => {
    mockMessagesSend.mockResolvedValue(22);
    mockChunkMarkdownText.mockReturnValueOnce(["chunk-1", "chunk-2"]);

    await sendPayloadVk(
      "123",
      {
        text: "chunked",
        channelData: {
          vk: {
            buttons: [[{ text: "OpenAI", callback_data: "/models openai", style: "primary" }]],
          },
        },
      },
      { cfg },
    );

    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
    expect(mockMessagesSend.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        message: "chunk-1",
      }),
    );
    expect(mockMessagesSend.mock.calls[0][0]).not.toHaveProperty("keyboard");
    expect(mockMessagesSend.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        message: "chunk-2",
        keyboard: expect.any(String),
      }),
    );
  });

  it("sends image media through VK upload flow instead of appending a link to text", async () => {
    mockMessagesSend.mockResolvedValueOnce(24);

    await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/photo.png",
      },
      { cfg },
    );

    expect(mockUploadPhoto).toHaveBeenCalledWith({
      peer_id: 123,
      source: { value: "https://example.com/photo.png" },
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "caption",
        attachment: "photo123_456",
      }),
    );
  });

  it("sends audio media through VK audio_message upload flow", async () => {
    mockMessagesSend.mockResolvedValueOnce(28);

    await sendPayloadVk(
      "123",
      {
        text: "voice caption",
        mediaUrl: "https://example.com/voice.mp3",
      },
      { cfg },
    );

    expect(mockUploadAudioMessage).toHaveBeenCalledWith({
      peer_id: 123,
      source: { value: "https://example.com/voice.mp3" },
      title: "voice.mp3",
    });
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "voice caption",
        attachment: "audio_message123_789",
      }),
    );
  });

  it("deduplicates mediaUrls", async () => {
    mockUploadPhoto.mockReset().mockResolvedValue("photo123_456");
    mockMessagesSend.mockResolvedValue(25);

    await sendPayloadVk(
      "123",
      {
        text: "two same images",
        mediaUrls: ["https://example.com/a.png", "https://example.com/a.png"],
      },
      { cfg },
    );

    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
  });

  it("prefers mediaUrls over mediaUrl when both present", async () => {
    mockMessagesSend.mockResolvedValue(26);

    await sendPayloadVk(
      "123",
      {
        text: "caption",
        mediaUrl: "https://example.com/ignored.png",
        mediaUrls: ["https://example.com/used.png"],
      },
      { cfg },
    );

    expect(mockUploadPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { value: "https://example.com/used.png" },
      }),
    );
  });

  it("forwards replyToId from payload", async () => {
    mockMessagesSend.mockResolvedValueOnce(27);

    await sendPayloadVk(
      "123",
      { text: "reply", replyToId: "77" },
      { cfg },
    );

    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({ reply_to: 77 }),
    );
  });
});

// ── isVkGroupPeerId ─────────────────────────────────────────────────────────

describe("isVkGroupPeerId", () => {
  it("returns true for group peer IDs (>= 2_000_000_000)", () => {
    expect(isVkGroupPeerId(2_000_000_000)).toBe(true);
    expect(isVkGroupPeerId(2_000_000_001)).toBe(true);
    expect(isVkGroupPeerId("2000000005")).toBe(true);
  });

  it("returns false for DM peer IDs (< 2_000_000_000)", () => {
    expect(isVkGroupPeerId(123456)).toBe(false);
    expect(isVkGroupPeerId(1_999_999_999)).toBe(false);
    expect(isVkGroupPeerId("555000")).toBe(false);
  });

  it("returns false for NaN / non-numeric strings", () => {
    expect(isVkGroupPeerId("abc")).toBe(false);
    expect(isVkGroupPeerId("")).toBe(false);
  });
});

// ── normalizeVkTargetId ─────────────────────────────────────────────────────

describe("normalizeVkTargetId", () => {
  it("strips vk: prefix variants", () => {
    expect(normalizeVkTargetId("vk:123")).toBe("123");
    expect(normalizeVkTargetId("vk:user:456")).toBe("456");
    expect(normalizeVkTargetId("vk:chat:789")).toBe("789");
    expect(normalizeVkTargetId("VK:USER:100")).toBe("100");
  });

  it("trims whitespace", () => {
    expect(normalizeVkTargetId("  555  ")).toBe("555");
  });

  it("passes through plain numeric ids", () => {
    expect(normalizeVkTargetId(123456)).toBe("123456");
  });
});

// ── normalizeVkSenderAllowEntry ─────────────────────────────────────────────

describe("normalizeVkSenderAllowEntry", () => {
  it("strips vk: and vk:user: prefixes", () => {
    expect(normalizeVkSenderAllowEntry("vk:123")).toBe("123");
    expect(normalizeVkSenderAllowEntry("vk:user:456")).toBe("456");
  });

  it("does not strip vk:chat: (only user prefix)", () => {
    expect(normalizeVkSenderAllowEntry("vk:chat:789")).toBe("chat:789");
  });

  it("converts numbers to string", () => {
    expect(normalizeVkSenderAllowEntry(42)).toBe("42");
  });
});

// ── normalizeVkDirectoryEntries ─────────────────────────────────────────────

describe("normalizeVkDirectoryEntries", () => {
  it("returns user entries that are not group peer IDs", () => {
    const result = normalizeVkDirectoryEntries([123, 456], { kind: "user" });
    expect(result).toEqual([
      { kind: "user", id: "123" },
      { kind: "user", id: "456" },
    ]);
  });

  it("returns group entries that are group peer IDs", () => {
    const result = normalizeVkDirectoryEntries([2_000_000_001], { kind: "group" });
    expect(result).toEqual([{ kind: "group", id: "2000000001" }]);
  });

  it("excludes wildcard '*' entries", () => {
    const result = normalizeVkDirectoryEntries(["*", 123], { kind: "user" });
    expect(result).toEqual([{ kind: "user", id: "123" }]);
  });

  it("deduplicates entries", () => {
    const result = normalizeVkDirectoryEntries([123, 123, 123], { kind: "user" });
    expect(result).toEqual([{ kind: "user", id: "123" }]);
  });

  it("filters by query", () => {
    const result = normalizeVkDirectoryEntries([100, 200, 300], {
      kind: "user",
      query: "20",
    });
    expect(result).toEqual([{ kind: "user", id: "200" }]);
  });

  it("limits results", () => {
    const result = normalizeVkDirectoryEntries([100, 200, 300], {
      kind: "user",
      limit: 2,
    });
    expect(result).toHaveLength(2);
  });

  it("ignores invalid limit values", () => {
    const result = normalizeVkDirectoryEntries([100], { kind: "user", limit: -1 });
    expect(result).toHaveLength(1);

    const result2 = normalizeVkDirectoryEntries([100], { kind: "user", limit: 0 });
    expect(result2).toHaveLength(1);
  });

  it("filters out user-range IDs when kind=group", () => {
    const result = normalizeVkDirectoryEntries([123, 2_000_000_001], { kind: "group" });
    expect(result).toEqual([{ kind: "group", id: "2000000001" }]);
  });

  it("filters out group-range IDs when kind=user", () => {
    const result = normalizeVkDirectoryEntries([123, 2_000_000_001], { kind: "user" });
    expect(result).toEqual([{ kind: "user", id: "123" }]);
  });
});

// ── primeVkGroupId ──────────────────────────────────────────────────────────

describe("primeVkGroupId", () => {
  beforeEach(() => {
    clearVkInstances();
    vi.mocked(VK).mockClear();
  });

  it("primes the group ID for subsequent typing calls", async () => {
    mockMessagesSend.mockResolvedValue(1);

    primeVkGroupId("test-token", 12345678);
    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: 12345678 }),
    );
  });

  it("does not prime group ID for empty token", async () => {
    mockSetActivity.mockReset().mockResolvedValue(1);
    primeVkGroupId("", 123);

    // sendTypingVk with empty token returns early — no setActivity call
    await sendTypingVk("123", makeAccount({ token: "" }));
    expect(mockSetActivity).not.toHaveBeenCalled();
  });

  it("does not prime group ID for non-positive values", async () => {
    primeVkGroupId("test-token", 0);
    primeVkGroupId("test-token", -1);

    // Without a valid prime, group_id is resolved via groups.getById
    mockGroupsGetById.mockRejectedValueOnce(new Error("no group"));
    await sendTypingVk("123", makeAccount());

    // group_id should be absent since getById failed and prime was rejected
    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.not.objectContaining({ group_id: expect.anything() }),
    );
  });

  it("does not prime group ID for non-integer values", async () => {
    primeVkGroupId("test-token", 1.5);

    mockGroupsGetById.mockRejectedValueOnce(new Error("no group"));
    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith(
      expect.not.objectContaining({ group_id: expect.anything() }),
    );
  });
});

// ── readVkAllowlistConfig ───────────────────────────────────────────────────

describe("readVkAllowlistConfig", () => {
  it("returns allowlist config from account", () => {
    const result = readVkAllowlistConfig(
      makeAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [123, "456"],
          groupPolicy: "open",
          groupAllowFrom: [789],
        },
      }),
    );

    expect(result.dmAllowFrom).toEqual(["123", "456"]);
    expect(result.groupAllowFrom).toEqual(["789"]);
    expect(result.dmPolicy).toBe("allowlist");
    expect(result.groupPolicy).toBe("open");
  });

  it("returns empty arrays when not configured", () => {
    const result = readVkAllowlistConfig(makeAccount({ config: {} }));
    expect(result.dmAllowFrom).toEqual([]);
    expect(result.groupAllowFrom).toEqual([]);
    expect(result.groupOverrides).toEqual([]);
  });

  it("includes group overrides with allowFrom", () => {
    const result = readVkAllowlistConfig(
      makeAccount({
        config: {
          groups: {
            "2000000001": { allowFrom: [100] },
            "2000000002": { requireMention: true },
          },
        },
      }),
    );

    expect(result.groupOverrides).toEqual([
      { label: "2000000001", entries: ["100"] },
    ]);
  });
});

// ── applyVkAllowlistConfigEdit ──────────────────────────────────────────────

describe("applyVkAllowlistConfigEdit", () => {
  it("adds a DM allowFrom entry", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(true);
      expect(result.pathLabel).toBe("channels.vk.allowFrom");
    }
  });

  it("removes a DM allowFrom entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["123", "456"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "remove",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(true);
    }
  });

  it("returns unchanged when adding an existing entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["123"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(false);
    }
  });

  it("returns unchanged when removing a non-existent entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["456"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "remove",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(false);
    }
  });

  it("returns invalid-entry for empty entry", () => {
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig: {},
      scope: "dm",
      action: "add",
      entry: "   ",
    });
    expect(result.kind).toBe("invalid-entry");
  });

  it("uses group scope with groupAllowFrom path", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "group",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pathLabel).toBe("channels.vk.groupAllowFrom");
    }
  });

  it("targets account record when accountId is non-default", () => {
    const parsedConfig: Record<string, unknown> = {};
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      accountId: "sales",
      scope: "dm",
      action: "add",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pathLabel).toBe("channels.vk.accounts.sales.allowFrom");
      expect(result.writeTarget).toEqual({
        kind: "account",
        scope: { channelId: "vk", accountId: "sales" },
      });
    }
  });

  it("deletes the key when removing the last entry", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { vk: { allowFrom: ["123"] } },
    };
    const result = applyVkAllowlistConfigEdit({
      cfg: {} as never,
      parsedConfig,
      scope: "dm",
      action: "remove",
      entry: "123",
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.changed).toBe(true);
      const vk = (parsedConfig as any).channels.vk;
      expect(vk.allowFrom).toBeUndefined();
    }
  });
});

// ── resolveVkDirectoryPeers ─────────────────────────────────────────────────

describe("resolveVkDirectoryPeers", () => {
  it("returns user-range entries from allowFrom and defaultTo", () => {
    const result = resolveVkDirectoryPeers({
      account: makeAccount({
        config: { allowFrom: [100, 200], defaultTo: "300" },
      }),
    });
    expect(result).toEqual([
      { kind: "user", id: "100" },
      { kind: "user", id: "200" },
      { kind: "user", id: "300" },
    ]);
  });

  it("excludes group-range IDs", () => {
    const result = resolveVkDirectoryPeers({
      account: makeAccount({
        config: { allowFrom: [100, 2_000_000_001] },
      }),
    });
    expect(result).toEqual([{ kind: "user", id: "100" }]);
  });

  it("supports query filtering", () => {
    const result = resolveVkDirectoryPeers({
      account: makeAccount({ config: { allowFrom: [100, 200] } }),
      query: "20",
    });
    expect(result).toEqual([{ kind: "user", id: "200" }]);
  });
});

// ── resolveVkDirectoryGroups ────────────────────────────────────────────────

describe("resolveVkDirectoryGroups", () => {
  it("returns group-range entries from group keys and defaultTo", () => {
    const result = resolveVkDirectoryGroups({
      account: makeAccount({
        config: {
          groups: { "2000000001": { enabled: true }, "*": { requireMention: true } },
          defaultTo: "2000000002",
        },
      }),
    });
    expect(result).toEqual([
      { kind: "group", id: "2000000001" },
      { kind: "group", id: "2000000002" },
    ]);
  });

  it("excludes wildcard key and user-range IDs", () => {
    const result = resolveVkDirectoryGroups({
      account: makeAccount({
        config: {
          groups: { "*": {}, "123": {} },
        },
      }),
    });
    expect(result).toEqual([]);
  });
});

// ── Retry logic ─────────────────────────────────────────────────────────────

describe("retry logic", () => {
  beforeEach(() => {
    clearVkInstances();
    mockMessagesSend.mockReset();
    vi.mocked(VK).mockClear();
  });

  it("retries on VK error code 6 (too many requests)", async () => {
    const error = Object.assign(new Error("Too many requests"), { code: 6 });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
  });

  it("retries on timeout-like error messages", async () => {
    const error = new Error("Connection timed out");
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("does not retry on non-retryable errors", async () => {
    const error = new Error("Access denied");
    mockMessagesSend.mockRejectedValueOnce(error);

    await expect(sendMessageVk("123", "hello", { cfg })).rejects.toThrow("Access denied");
    expect(mockMessagesSend).toHaveBeenCalledTimes(1);
  });

  it("retries on VK error code 9 (flood control)", async () => {
    const error = Object.assign(new Error("Flood control"), { code: 9 });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on VK error code 10 (internal server error)", async () => {
    const error = Object.assign(new Error("Internal server error"), { code: 10 });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on ECONNRESET errors", async () => {
    const error = Object.assign(new Error("ECONNRESET"), { name: "Error" });
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("retries on error_code field (VK API style)", async () => {
    const error = { error_code: 6, message: "Too many requests per second" };
    mockMessagesSend.mockRejectedValueOnce(error).mockResolvedValueOnce(42);

    const result = await sendMessageVk("123", "hello", { cfg });
    expect(result.messageId).toBe("42");
  });

  it("gives up after max retry attempts", async () => {
    const error = Object.assign(new Error("rate limit"), { code: 6 });
    mockMessagesSend.mockRejectedValue(error);

    await expect(sendMessageVk("123", "hello", { cfg })).rejects.toThrow("rate limit");
    expect(mockMessagesSend).toHaveBeenCalledTimes(2);
  });
});
