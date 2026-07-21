import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateCompositor = vi.hoisted(() =>
  vi.fn((params: Record<string, unknown>) => ({
    __params: params,
    markFinalReplyStarted: vi.fn(),
    markFinalReplyDelivered: vi.fn(),
  })),
);
const mockSendMessage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ messageId: "55", chatId: "42" }),
);
const mockEditMessage = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockDeleteMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("openclaw/plugin-sdk/channel-message", () => ({
  createChannelProgressDraftCompositor: mockCreateCompositor,
}));

vi.mock("./send.js", () => ({
  sendMessageVk: mockSendMessage,
  editMessageVk: mockEditMessage,
  deleteMessageVk: mockDeleteMessage,
}));

import { createVkProgressDraftCompositor } from "./progress-draft.js";
import { makeAccount } from "./test-helpers.js";

function make(overrides: Record<string, unknown> = {}) {
  return createVkProgressDraftCompositor({
    to: "42",
    account: makeAccount(),
    accountId: "default",
    entry: { channels: { vk: {} } } as never,
    mode: "progress",
    seed: "turn-1",
    ...overrides,
  });
}

function capturedParams() {
  return mockCreateCompositor.mock.calls[0]?.[0] as {
    mode: string;
    seed: string;
    active: boolean;
    update: unknown;
    deleteCurrent: unknown;
  };
}

describe("createVkProgressDraftCompositor", () => {
  beforeEach(() => {
    mockCreateCompositor.mockClear();
    mockSendMessage.mockReset().mockResolvedValue({ messageId: "55", chatId: "42" });
    mockEditMessage.mockReset().mockResolvedValue(true);
    mockDeleteMessage.mockReset().mockResolvedValue(undefined);
  });

  it("wires entry/mode/seed and the update/deleteCurrent primitives into the core compositor", () => {
    make();
    expect(mockCreateCompositor).toHaveBeenCalledTimes(1);
    const p = capturedParams();
    expect(p.mode).toBe("progress");
    expect(p.seed).toBe("turn-1");
    expect(p.active).toBe(true);
    expect(typeof p.update).toBe("function");
    expect(typeof p.deleteCurrent).toBe("function");
  });

  it("creates the draft with sendMessageVk on first render, then edits in place", async () => {
    const handle = make();
    expect(handle.currentMessageId()).toBeUndefined();

    await handle.overwrite("🛠️ Bash");
    expect(mockSendMessage).toHaveBeenCalledWith("42", "🛠️ Bash", {
      cfg: undefined,
      accountId: "default",
    });
    expect(handle.currentMessageId()).toBe(55);

    await handle.overwrite("🛠️ Bash\n🔎 Web Search");
    expect(mockEditMessage).toHaveBeenCalledWith(
      "42",
      55,
      "🛠️ Bash\n🔎 Web Search",
      expect.anything(),
    );
    // The draft is edited, not re-sent.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to a fresh send when an in-place edit fails", async () => {
    const handle = make();
    await handle.overwrite("a"); // send → id 55
    mockEditMessage.mockResolvedValueOnce(false);
    await handle.overwrite("b"); // edit fails → forget the id
    expect(handle.currentMessageId()).toBeUndefined();
    await handle.overwrite("c"); // sends a fresh draft
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("removes the draft via deleteMessageVk and clears the id", async () => {
    const handle = make();
    await handle.overwrite("a");
    await handle.remove();
    expect(mockDeleteMessage).toHaveBeenCalledWith("42", 55, expect.anything());
    expect(handle.currentMessageId()).toBeUndefined();
  });

  it("remove is a no-op when there is no draft yet", async () => {
    const handle = make();
    await handle.remove();
    expect(mockDeleteMessage).not.toHaveBeenCalled();
  });

  it("routes send failures to onError without throwing", async () => {
    const onError = vi.fn();
    mockSendMessage.mockRejectedValueOnce(new Error("boom"));
    const handle = make({ onError });
    await handle.overwrite("a");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(handle.currentMessageId()).toBeUndefined();
  });
});
