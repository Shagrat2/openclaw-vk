import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerVkQuestionByText,
  handleVkQuestionEvent,
  isVkQuestionAnswerer,
  type VkQuestionEvent,
} from "./question-events.js";
import {
  clearVkQuestionDeliveries,
  findOpenVkQuestionDelivery,
  findOpenVkQuestionForChat,
  rememberVkQuestionDelivery,
  resetVkQuestionRuntimeForTest,
} from "./question.js";

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/account-id", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactIdentifier: (value?: string) => `sha256:${String(value ?? "-").length}`,
  redactSensitiveText: (text: string) => text,
}));

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  pairingStore: [] as string[],
}));
// The inbound gate's pairing read, as the core does it: the store counts only
// under dmPolicy "pairing".
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingController: () => ({ readStoreForDmPolicy: async () => state.pairingStore }),
}));
vi.mock("openclaw/plugin-sdk/channel-policy", () => ({
  readStoreAllowFromForDmPolicy: async ({ dmPolicy, readStore }: { dmPolicy: string; readStore: () => Promise<string[]> }) =>
    dmPolicy === "pairing" ? await readStore() : [],
}));
vi.mock("./runtime.js", () => ({
  getVkRuntime: () => ({ config: { current: () => state.config } }),
  tryGetVkRuntime: () => null,
  readVkRuntimeConfig: () => state.config,
}));

const sendMessageVk = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ sendMessageVk }));

const QID = `ask_${"1".repeat(32)}`;
const DM = 7654321;
const CHAT = 2_000_000_005;

const resolveOption = vi.fn();
const runtimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number): never => {
    throw new Error(`exit ${code}`);
  }) as (code: number) => never,
};

function pressEvent(overrides: Partial<VkQuestionEvent> = {}) {
  const answer = vi.fn().mockResolvedValue(1);
  const event: VkQuestionEvent = {
    userId: DM,
    peerId: DM,
    eventPayload: { ocq: QID, i: 1 },
    answer,
    ...overrides,
  };
  return { event, answer: (event.answer as typeof answer) };
}

function snackbar(answer: ReturnType<typeof vi.fn>): string | undefined {
  expect(answer).toHaveBeenCalledTimes(1);
  const data = answer.mock.calls[0][0];
  expect(data.type).toBe("show_snackbar");
  return data.text;
}

beforeEach(() => {
  state.config = { channels: { vk: { token: "t", dmPolicy: "allowlist", allowFrom: [String(DM)] } } };
  state.pairingStore = [];
  resolveOption.mockReset();
  sendMessageVk.mockReset().mockResolvedValue({ messageId: "1", chatId: String(DM) });
  runtimeEnv.log.mockReset();
  runtimeEnv.error.mockReset();
  resetVkQuestionRuntimeForTest({ runtime: { resolveOption } as never });
  rememberVkQuestionDelivery(QID, { accountId: "default", peerId: DM, messageId: 77 });
});

afterEach(() => {
  clearVkQuestionDeliveries();
  resetVkQuestionRuntimeForTest();
});

describe("handleVkQuestionEvent", () => {
  it("leaves presses that are not question buttons alone", async () => {
    const { event, answer } = pressEvent({ eventPayload: { oc: "/models" } });
    expect(await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv })).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    expect(resolveOption).not.toHaveBeenCalled();
  });

  it("passes the pressed option to the core with the presser and an authorizer", async () => {
    resolveOption.mockResolvedValue({ status: "answered", questionId: "q1", optionValue: "Увеличить ×2" });
    const { event, answer } = pressEvent();
    expect(await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv })).toBe(true);

    expect(resolveOption).toHaveBeenCalledTimes(1);
    const args = resolveOption.mock.calls[0][0];
    expect(args).toMatchObject({
      cfg: state.config,
      questionId: QID,
      optionIndex: 1,
      senderId: String(DM),
      clientDisplayName: `VK question (${DM})`,
    });
    expect(args).not.toHaveProperty("customInput");
    // The authorizer is re-run by the core right before the answer is written.
    expect(await args.authorize()).toBe(true);
    expect(snackbar(answer)).toBe("Ответ принят: Увеличить ×2");
  });

  it("the authorizer turns false once the question is closed or access is lost", async () => {
    resolveOption.mockResolvedValue({ status: "answered", questionId: "q1", optionValue: "A" });
    const { event } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    const { authorize } = resolveOption.mock.calls[0][0];
    clearVkQuestionDeliveries();
    expect(await authorize()).toBe(false);
  });

  it("the authorizer turns false when the person leaves the DM allowlist meanwhile", async () => {
    resolveOption.mockResolvedValue({ status: "answered", questionId: "q1", optionValue: "A" });
    const { event } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    const { authorize } = resolveOption.mock.calls[0][0];
    state.config = { channels: { vk: { token: "t", dmPolicy: "allowlist", allowFrom: [] } } };
    expect(await authorize()).toBe(false);
  });

  it("a DM press from someone no longer allowed is refused without asking the core", async () => {
    state.config = { channels: { vk: { token: "t", dmPolicy: "allowlist", allowFrom: ["1"] } } };
    const { event, answer } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(resolveOption).not.toHaveBeenCalled();
    expect(snackbar(answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
  });

  it("refuses a press from someone else's direct chat without asking the core", async () => {
    const { event, answer } = pressEvent({ userId: 555 });
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(resolveOption).not.toHaveBeenCalled();
    expect(snackbar(answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
    expect(runtimeEnv.log).toHaveBeenCalledWith(expect.stringContaining("press refused"));
  });

  it("says the question is closed when it is not open in this chat", async () => {
    const { event, answer } = pressEvent({ peerId: 999, userId: 999 });
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(resolveOption).not.toHaveBeenCalled();
    expect(snackbar(answer)).toBe("Этот вопрос уже закрыт");
  });

  it("'Свой вариант' asks for a typed answer and leaves the question open", async () => {
    resolveOption.mockResolvedValue({ status: "custom-input", questionId: "q1" });
    const { event, answer } = pressEvent({ eventPayload: JSON.stringify({ ocq: QID, o: 1 }) });
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });

    const args = resolveOption.mock.calls[0][0];
    expect(args.customInput).toBe(true);
    expect(args).not.toHaveProperty("optionIndex");
    expect(snackbar(answer)).toBe("Напишите свой вариант ответа сообщением");
    expect(sendMessageVk).toHaveBeenCalledWith(
      String(DM),
      "✍️ Напишите свой вариант ответа одним сообщением.",
      { accountId: "default" },
    );
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: DM })).toBeDefined();
  });

  it("a failed hint message does not answer the press twice", async () => {
    resolveOption.mockResolvedValue({ status: "custom-input", questionId: "q1" });
    sendMessageVk.mockRejectedValueOnce(new Error("VK API error 10"));
    const { event, answer } = pressEvent({ eventPayload: { ocq: QID, o: 1 } });
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(snackbar(answer)).toBe("Напишите свой вариант ответа сообщением");
    expect(runtimeEnv.log).toHaveBeenCalledWith(expect.stringContaining("custom-input hint failed"));
  });

  it("an already answered question closes here too", async () => {
    resolveOption.mockResolvedValue({ status: "already-terminal", reason: "already-terminal" });
    const { event, answer } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(snackbar(answer)).toBe("Этот вопрос уже закрыт");
    expect(findOpenVkQuestionDelivery({ questionId: QID, accountId: "default", peerId: DM })).toBeUndefined();
  });

  it("a denial from the authorizer is reported as such", async () => {
    resolveOption.mockResolvedValue({ status: "denied" });
    const { event, answer } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(snackbar(answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
  });

  it("a failing core answers the press once and tells how to answer by text", async () => {
    resolveOption.mockRejectedValue(new Error("gateway unavailable"));
    const { event, answer } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(snackbar(answer)).toBe(
      "Не получилось передать ответ. Ответьте текстом: номер варианта или свой ответ",
    );
    expect(runtimeEnv.error).toHaveBeenCalledWith(expect.stringContaining("gateway unavailable"));
  });

  it("without the core's question runtime the press is answered, not left spinning", async () => {
    resetVkQuestionRuntimeForTest({ runtime: undefined });
    const { event, answer } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(snackbar(answer)).toMatch(/^Не получилось/);
  });

  it("a failing snackbar is logged, not thrown", async () => {
    resolveOption.mockResolvedValue({ status: "answered", questionId: "q1", optionValue: "A" });
    const { event } = pressEvent({ answer: vi.fn().mockRejectedValue(new Error("event expired")) });
    await expect(
      handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv }),
    ).resolves.toBe(true);
    expect(runtimeEnv.log).toHaveBeenCalledWith(expect.stringContaining("event expired"));
  });

  it("keeps a long option label within VK's snackbar limit", async () => {
    resolveOption.mockResolvedValue({ status: "answered", questionId: "q1", optionValue: "я".repeat(200) });
    const { event, answer } = pressEvent();
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(Array.from(snackbar(answer)!)).toHaveLength(90);
  });
});

describe("isVkQuestionAnswerer", () => {
  const ask = (config: Record<string, unknown>, userId: number, peerId = CHAT) =>
    isVkQuestionAnswerer({ config: config as never, accountId: "default", peerId, userId });
  const dm = (vk: Record<string, unknown>, userId = DM) => ask({ channels: { vk } }, userId, DM);

  it("in a direct chat only its other side, and only while the DM policy admits them", async () => {
    expect(await dm({ dmPolicy: "open" })).toBe(true);
    expect(await dm({ dmPolicy: "open" }, 1)).toBe(false);
    expect(await dm({ dmPolicy: "allowlist", allowFrom: [`vk:${DM}`] })).toBe(true);
    expect(await dm({ dmPolicy: "allowlist", allowFrom: ["1"] })).toBe(false);
    expect(await dm({ dmPolicy: "allowlist", allowFrom: ["*"] })).toBe(true);
    expect(await dm({ dmPolicy: "disabled", allowFrom: ["*"] })).toBe(false);
  });

  it("pairing: an approved sender from the store answers, an unknown one does not", async () => {
    expect(await dm({})).toBe(false);
    state.pairingStore = [String(DM)];
    expect(await dm({})).toBe(true);
    // The store does not widen an allowlist policy, as on the inbound gate.
    expect(await dm({ dmPolicy: "allowlist" })).toBe(false);
  });

  it("an unreadable pairing store admits nobody extra", async () => {
    const failing = async () => {
      throw new Error("store down");
    };
    expect(
      await isVkQuestionAnswerer({
        config: { channels: { vk: { allowFrom: [] } } } as never,
        accountId: "default",
        peerId: DM,
        userId: DM,
        readStoreAllowFrom: failing,
      }),
    ).toBe(false);
  });

  it("in a group chat a sender on the group allowlist", async () => {
    const config = { channels: { vk: { groupPolicy: "allowlist", groupAllowFrom: ["vk:42"] } } };
    expect(await ask(config, 42)).toBe(true);
    expect(await ask(config, 43)).toBe(false);
  });

  it("a per-chat allowlist overrides the account one", async () => {
    const config = {
      channels: { vk: { groupAllowFrom: ["42"], groups: { [String(CHAT)]: { allowFrom: ["43"] } } } },
    };
    expect(await ask(config, 43)).toBe(true);
    expect(await ask(config, 42)).toBe(false);
  });

  it("an empty allowlist admits everyone only in an open group", async () => {
    expect(await ask({ channels: { vk: { groupPolicy: "open" } } }, 7)).toBe(true);
    expect(await ask({ channels: { vk: {} } }, 7)).toBe(false);
  });

  it("nobody in a disabled group", async () => {
    expect(await ask({ channels: { vk: { groupPolicy: "disabled", groupAllowFrom: ["*"] } } }, 7)).toBe(false);
    expect(
      await ask({ channels: { vk: { groupAllowFrom: ["*"], groups: { "*": { enabled: false } } } } }, 7),
    ).toBe(false);
  });
});

describe("answerVkQuestionByText", () => {
  const TQ = `ask_${"2".repeat(32)}`;
  const typed = (text: string, senderId = DM, peerId = DM) =>
    answerVkQuestionByText({ accountId: "default", peerId, senderId, text, runtime: runtimeEnv });

  beforeEach(() => {
    rememberVkQuestionDelivery(
      TQ,
      { accountId: "default", peerId: DM, messageId: 90 },
      { questionId: TQ, options: ["Белый", "Чёрный"], customInput: true },
    );
  });

  it("a typed number answers with that option's label, and the message is consumed", async () => {
    resolveOption.mockResolvedValue({ status: "answered", questionId: "q", optionValue: "Чёрный" });
    expect(await typed("2")).toBe(true);
    const args = resolveOption.mock.calls[0][0];
    expect(args).toMatchObject({
      questionId: TQ,
      optionValue: "Чёрный",
      senderId: String(DM),
      cfg: state.config,
    });
    expect(args).not.toHaveProperty("optionIndex");
    expect(await args.authorize()).toBe(true);
  });

  it("free text goes as it is where the question allows its own answer", async () => {
    resolveOption.mockResolvedValue({ status: "answered", questionId: "q", optionValue: "Бирюзовый" });
    expect(await typed("  Бирюзовый ")).toBe(true);
    expect(resolveOption.mock.calls[0][0].optionValue).toBe("Бирюзовый");
  });

  it("a stray message to a question with fixed options is left alone", async () => {
    clearVkQuestionDeliveries();
    rememberVkQuestionDelivery(
      TQ,
      { accountId: "default", peerId: DM, messageId: 90 },
      { questionId: TQ, options: ["Белый", "Чёрный"], customInput: false },
    );
    expect(await typed("а что это за вопрос?")).toBe(false);
    expect(resolveOption).not.toHaveBeenCalled();
  });

  it("no open question in this chat: an ordinary message", async () => {
    expect(await typed("2", 1, 1)).toBe(false);
    expect(resolveOption).not.toHaveBeenCalled();
  });

  it("a sender who may not answer: an ordinary message, the core is not asked", async () => {
    state.config = { channels: { vk: { token: "t", dmPolicy: "allowlist", allowFrom: ["1"] } } };
    expect(await typed("2")).toBe(false);
    expect(resolveOption).not.toHaveBeenCalled();
  });

  it("already answered or expired: an ordinary message, and the question closes here", async () => {
    resolveOption.mockResolvedValue({ status: "already-terminal", reason: "already-terminal" });
    expect(await typed("2")).toBe(false);
    expect(findOpenVkQuestionForChat({ accountId: "default", peerId: DM })).toBeUndefined();
  });

  it("denied at the write: an ordinary message", async () => {
    resolveOption.mockResolvedValue({ status: "denied" });
    expect(await typed("2")).toBe(false);
    expect(findOpenVkQuestionForChat({ accountId: "default", peerId: DM })?.questionId).toBe(TQ);
  });

  it("a record a typed answer cannot settle: once refused, not tried again", async () => {
    resolveOption.mockRejectedValue(new Error("question button resolution requires one tappable question"));
    expect(await typed("2")).toBe(false);
    expect(runtimeEnv.log).toHaveBeenCalledWith(expect.stringContaining("typed answer not accepted"));
    expect(await typed("1")).toBe(false);
    expect(resolveOption).toHaveBeenCalledTimes(1);
  });

  it("a gateway failure is not a property of the question: the next answer is tried again", async () => {
    resolveOption.mockRejectedValueOnce(new Error("gateway timeout"));
    expect(await typed("2")).toBe(false);
    resolveOption.mockResolvedValue({ status: "answered", questionId: TQ, optionValue: "x" });
    expect(await typed("2")).toBe(true);
    expect(resolveOption).toHaveBeenCalledTimes(2);
  });

  it("without the core's question runtime: an ordinary message", async () => {
    resetVkQuestionRuntimeForTest({ runtime: undefined });
    expect(await typed("2")).toBe(false);
  });
});
