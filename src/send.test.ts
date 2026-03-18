import { beforeEach, describe, expect, it, vi } from "vitest";
import { VK } from "vk-io";
import {
  clearVkInstances,
  sendDocumentVk,
  sendMessageVk,
  sendPhotoVk,
  sendTypingVk,
} from "./send.js";
import { makeAccount } from "./test-helpers.js";

// ── SDK mocks (for transitive accounts.ts import) ───────────────────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/compat", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

vi.mock("./runtime.js", () => ({
  getVkRuntime: vi.fn().mockReturnValue({
    channel: { activity: { record: vi.fn() } },
    config: { loadConfig: vi.fn().mockReturnValue({}) },
  }),
}));

const mockMessagesSend = vi.hoisted(() => vi.fn());
const mockSetActivity = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockUploadPhoto = vi.hoisted(() => vi.fn().mockResolvedValue("photo123_456"));
const mockUploadDocument = vi.hoisted(() => vi.fn().mockResolvedValue("doc123_789"));
const mockGetRandomId = vi.hoisted(() => vi.fn().mockReturnValue(99999));

vi.mock("vk-io", () => ({
  // Must use a regular function (not an arrow) so `new VK(...)` works.
  VK: vi.fn().mockImplementation(function () {
    return {
      api: {
        messages: { send: mockMessagesSend, setActivity: mockSetActivity },
      },
      upload: {
        messagePhoto: mockUploadPhoto,
        messageDocument: mockUploadDocument,
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
    mockSetActivity.mockReset().mockResolvedValue(1);
    mockUploadPhoto.mockReset().mockResolvedValue("photo123_456");
    mockUploadDocument.mockReset().mockResolvedValue("doc123_789");
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

  it("throws when peer ID is not a number", async () => {
    await expect(
      sendMessageVk("not-a-number", "text", { cfg }),
    ).rejects.toThrow("Invalid VK peer ID: not-a-number");
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

// ── sendTypingVk ─────────────────────────────────────────────────────────────

describe("sendTypingVk", () => {
  beforeEach(() => {
    clearVkInstances();
    mockSetActivity.mockReset().mockResolvedValue(1);
    vi.mocked(VK).mockClear();
  });

  it("sends typing indicator", async () => {
    await sendTypingVk("123", makeAccount());

    expect(mockSetActivity).toHaveBeenCalledWith({
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

  it("swallows errors without throwing", async () => {
    mockSetActivity.mockRejectedValueOnce(new Error("VK API error"));

    // Should not throw
    await sendTypingVk("123", makeAccount());
  });
});
