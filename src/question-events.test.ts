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
import { resetVkQuestionGatewayForTest, type VkQuestionGateway } from "./question-gateway.js";

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
// The channel diagnostics' logger: failures are written there, at every level.
const diagLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
// The inbound gate's pairing read, as the core does it: the store counts only
// under dmPolicy "pairing".
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingController: () => ({ readStoreForDmPolicy: async () => state.pairingStore }),
}));
vi.mock("openclaw/plugin-sdk/channel-policy", () => ({
  readStoreAllowFromForDmPolicy: async ({ dmPolicy, readStore }: { dmPolicy: string; readStore: () => Promise<string[]> }) =>
    dmPolicy === "pairing" ? await readStore() : [],
  // The core's group list: groupAllowFrom when set, no fallback to allowFrom here.
  resolveEffectiveAllowFromLists: ({ groupAllowFrom }: { groupAllowFrom?: string[] }) => ({
    effectiveAllowFrom: [],
    effectiveGroupAllowFrom: groupAllowFrom?.length ? groupAllowFrom : [],
  }),
}));
// The core's resolvers as they are: the channel's own policy, else the
// inherited default, else "allowlist".
vi.mock("openclaw/plugin-sdk/runtime-group-policy", () => ({
  resolveDefaultGroupPolicy: (cfg: { channels?: { defaults?: { groupPolicy?: string } } }) =>
    cfg.channels?.defaults?.groupPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy: (params: {
    providerConfigPresent: boolean;
    groupPolicy?: string;
    defaultGroupPolicy?: string;
  }) => ({
    groupPolicy: params.providerConfigPresent
      ? (params.groupPolicy ?? params.defaultGroupPolicy ?? "allowlist")
      : (params.groupPolicy ?? "allowlist"),
    providerMissingFallbackApplied: !params.providerConfigPresent && params.groupPolicy === undefined,
  }),
}));
vi.mock("./runtime.js", () => {
  const runtime = {
    config: { current: () => state.config },
    logging: { getChildLogger: () => diagLog },
  };
  return {
    getVkRuntime: () => runtime,
    tryGetVkRuntime: () => runtime,
    readVkRuntimeConfig: () => state.config,
  };
});

// What `callGatewayFromCli` throws when the gateway is down: its text names the
// gateway's address and the config file it read.
function gatewayDown(): Error {
  return Object.assign(
    new Error(
      "Gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)\nGateway target: ws://127.0.0.1:18789\nSource: local loopback\nConfig: /Users/someone/.openclaw/openclaw.json",
    ),
    { name: "GatewayTransportError" },
  );
}

/** Every line the plugin wrote, to the runtime log and to the diagnostics logger. */
function everyLogLine(): string {
  return JSON.stringify([
    runtimeEnv.log.mock.calls,
    runtimeEnv.error.mock.calls,
    diagLog.error.mock.calls,
    diagLog.info.mock.calls,
  ]);
}

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
  for (const log of Object.values(diagLog)) {
    log.mockReset();
  }
  resetVkQuestionRuntimeForTest({ runtime: { resolveOption } as never });
  resetVkQuestionGatewayForTest({ gateway: undefined });
  rememberVkQuestionDelivery(QID, { accountId: "default", peerId: DM, messageId: 77 });
});

afterEach(() => {
  clearVkQuestionDeliveries();
  resetVkQuestionRuntimeForTest();
  resetVkQuestionGatewayForTest();
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

describe("a group question while the inherited policy changes", () => {
  const GQ = `ask_${"4".repeat(32)}`;
  const inGroup = (groupPolicy: string) => ({
    channels: { defaults: { groupPolicy }, vk: { token: "t", groupAllowFrom: [String(DM)] } },
  });

  beforeEach(() => {
    rememberVkQuestionDelivery(GQ, { accountId: "default", peerId: CHAT, messageId: 80 });
  });

  it("a press after the default turned disabled is refused, the core is not asked", async () => {
    state.config = inGroup("disabled");
    const { event, answer } = pressEvent({ peerId: CHAT, eventPayload: { ocq: GQ, i: 0 } });
    expect(await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv })).toBe(true);
    expect(snackbar(answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
    expect(resolveOption).not.toHaveBeenCalled();
  });

  it("disabled between the press and the write: the authorizer refuses, nothing is resolved", async () => {
    state.config = inGroup("allowlist");
    resolveOption.mockImplementation(async ({ authorize }: { authorize: () => Promise<boolean> }) => {
      state.config = inGroup("disabled");
      return (await authorize()) ? { status: "answered", questionId: GQ, optionValue: "x" } : { status: "denied" };
    });
    const { event, answer } = pressEvent({ peerId: CHAT, eventPayload: { ocq: GQ, i: 0 } });
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(await resolveOption.mock.results[0].value).toEqual({ status: "denied" });
    expect(snackbar(answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
  });

  describe("a multi-select in the group", () => {
    const GM = `ask_${"5".repeat(32)}`;
    const call = vi.fn();
    const redraw = vi.fn();
    const press = (payload: Record<string, unknown>) =>
      pressEvent({ peerId: CHAT, eventPayload: { ocq: GM, ...payload } });

    beforeEach(() => {
      call.mockReset().mockResolvedValue({});
      redraw.mockReset().mockResolvedValue(undefined);
      resetVkQuestionGatewayForTest({ gateway: { call, buildAnswers: () => ({ answers: {} }) } });
      rememberVkQuestionDelivery(
        GM,
        { accountId: "default", peerId: CHAT, messageId: 81 },
        { questionId: GM, options: ["Первый", "Второй"], customInput: false, multiSelect: { answerKey: "m" } },
        redraw,
      );
    });

    it("after the default turned disabled neither a toggle nor «Готово» gets through; nothing is resolved", async () => {
      state.config = inGroup("allowlist");
      const first = press({ t: 0 });
      await handleVkQuestionEvent({ event: first.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(first.answer)).toBe("Отмечено: Первый");

      state.config = inGroup("disabled");
      const toggle = press({ t: 1 });
      await handleVkQuestionEvent({ event: toggle.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(toggle.answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
      expect(redraw).toHaveBeenCalledTimes(1);

      const done = press({ d: 1 });
      await handleVkQuestionEvent({ event: done.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(done.answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
      expect(call).not.toHaveBeenCalledWith("question.resolve", expect.anything());
    });
  });
});

describe("a group question's buttons", () => {
  const GQ = `ask_${"5".repeat(32)}`;

  beforeEach(() => {
    state.config = { channels: { vk: { token: "t", groupPolicy: "open" } } };
    rememberVkQuestionDelivery(GQ, { accountId: "default", peerId: CHAT, messageId: 81 });
  });

  it("'Свой вариант' from an older keyboard asks for no typed answer and leaves the core alone", async () => {
    const { event, answer } = pressEvent({ peerId: CHAT, eventPayload: { ocq: GQ, o: 1 } });
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(snackbar(answer)).toBe("В беседе ответ принимается только кнопками");
    expect(resolveOption).not.toHaveBeenCalled();
    expect(sendMessageVk).not.toHaveBeenCalled();
    expect(findOpenVkQuestionDelivery({ questionId: GQ, accountId: "default", peerId: CHAT })).toBeDefined();
  });

  it("a failing core does not recommend a typed answer in a group", async () => {
    resolveOption.mockRejectedValue(new Error("gateway unavailable"));
    const { event, answer } = pressEvent({ peerId: CHAT, eventPayload: { ocq: GQ, i: 0 } });
    await handleVkQuestionEvent({ event, accountId: "default", runtime: runtimeEnv });
    expect(snackbar(answer)).toBe("Не получилось передать ответ. Нажмите кнопку ещё раз");
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

  describe("the inbound gate's effective group policy (review of #20)", () => {
    const withDefault = (groupPolicy: string, vk: Record<string, unknown> = {}) => ({
      channels: { defaults: { groupPolicy }, vk },
    });

    it("an inherited open admits anyone, as the inbound gate does", async () => {
      expect(await ask(withDefault("open"), 7)).toBe(true);
    });

    it("an inherited allowlist admits only the listed", async () => {
      expect(await ask(withDefault("allowlist", { groupAllowFrom: ["42"] }), 42)).toBe(true);
      expect(await ask(withDefault("allowlist", { groupAllowFrom: ["42"] }), 7)).toBe(false);
    });

    it("an inherited disabled admits nobody, listed or not", async () => {
      expect(await ask(withDefault("disabled", { groupAllowFrom: ["42"] }), 42)).toBe(false);
    });

    it("an explicit open ignores the channel and per-chat allowlists", async () => {
      expect(await ask({ channels: { vk: { groupPolicy: "open", groupAllowFrom: ["42"] } } }, 7)).toBe(true);
      expect(
        await ask(
          { channels: { vk: { groupPolicy: "open", groups: { [String(CHAT)]: { allowFrom: ["42"] } } } } },
          7,
        ),
      ).toBe(true);
    });

    it("the channel's own policy wins over the inherited default", async () => {
      expect(await ask(withDefault("disabled", { groupPolicy: "open" }), 7)).toBe(true);
      expect(await ask(withDefault("open", { groupPolicy: "disabled" }), 7)).toBe(false);
    });
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

  describe("multi-select buttons", () => {
    const MQ = `ask_${"3".repeat(32)}`;
    const call = vi.fn();
    const redraw = vi.fn();
    const press = (payload: Record<string, unknown>, userId = DM) =>
      pressEvent({ userId, eventPayload: { ocq: MQ, ...payload } });

    beforeEach(() => {
      call.mockReset().mockResolvedValue({});
      redraw.mockReset().mockResolvedValue(undefined);
      resetVkQuestionGatewayForTest({ gateway: { call, buildAnswers: () => ({ answers: {} }) } });
      rememberVkQuestionDelivery(
        MQ,
        { accountId: "default", peerId: DM, messageId: 95 },
        { questionId: MQ, options: ["Первый", "Второй", "Третий"], customInput: false, multiSelect: { answerKey: "test_multi" } },
        redraw,
      );
    });

    it("a toggle marks and unmarks in place and says what is marked; nothing is written", async () => {
      const first = press({ t: 2 });
      expect(await handleVkQuestionEvent({ event: first.event, accountId: "default", runtime: runtimeEnv })).toBe(true);
      expect(snackbar(first.answer)).toBe("Отмечено: Третий");
      const again = press({ t: 2 });
      await handleVkQuestionEvent({ event: again.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(again.answer)).toBe("Ничего не отмечено");
      expect(redraw).toHaveBeenCalledTimes(2);
      expect(call).not.toHaveBeenCalled();
    });

    it("«Готово» writes the marked options under the record's question id", async () => {
      for (const t of [0, 2]) {
        await handleVkQuestionEvent({ event: press({ t }).event, accountId: "default", runtime: runtimeEnv });
      }
      const done = press({ d: 1 });
      await handleVkQuestionEvent({ event: done.event, accountId: "default", runtime: runtimeEnv });
      expect(call).toHaveBeenCalledWith("question.resolve", {
        id: MQ,
        answers: { answers: { test_multi: ["Первый", "Третий"] } },
        resolvedBy: String(DM),
      });
      expect(snackbar(done.answer)).toBe("Ответ принят: Первый, Третий");
    });

    it("«Готово» with nothing marked asks to mark something first", async () => {
      const done = press({ d: 1 });
      await handleVkQuestionEvent({ event: done.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(done.answer)).toContain("хотя бы один");
      expect(call).not.toHaveBeenCalled();
    });

    it("typed «1, 3» answers it over the gateway, the single-option parse is not asked", async () => {
      // 28.09.2026: the prompt had buttons, so the typed reply went to the
      // single-option parse, was "not an answer" and queued behind the run.
      call.mockImplementation(async (method: string) =>
        method === "question.get"
          ? {
              question: {
                id: MQ,
                status: "pending",
                questions: [
                  {
                    questionId: "test_multi",
                    header: "Тест",
                    question: "?",
                    multiSelect: true,
                    options: [{ label: "Первый" }, { label: "Второй" }, { label: "Третий" }],
                  },
                ],
              },
            }
          : {},
      );
      resetVkQuestionGatewayForTest({
        gateway: {
          call,
          buildAnswers: (questions, text) => ({
            answers: {
              [questions[0].id]: {
                answers: text.split(",").map((n) => questions[0].options?.[Number(n.trim()) - 1]?.label ?? ""),
              },
            },
          }),
        },
      });
      clearVkQuestionDeliveries();
      rememberVkQuestionDelivery(
        MQ,
        { accountId: "default", peerId: DM, messageId: 95 },
        { questionId: MQ, options: ["Первый", "Второй", "Третий"], customInput: true, multiSelect: { answerKey: "test_multi" } },
        redraw,
      );
      expect(
        await answerVkQuestionByText({ accountId: "default", peerId: DM, senderId: DM, text: "1, 3", runtime: runtimeEnv }),
      ).toBe(true);
      expect(resolveOption).not.toHaveBeenCalled();
      expect(call).toHaveBeenLastCalledWith("question.resolve", {
        id: MQ,
        answers: { answers: { test_multi: ["Первый", "Третий"] } },
        resolvedBy: String(DM),
      });
    });

    it("«Свой вариант» asks for a typed answer without asking the core", async () => {
      const own = press({ o: 1 });
      await handleVkQuestionEvent({ event: own.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(own.answer)).toBe("Напишите свой вариант ответа сообщением");
      expect(sendMessageVk).toHaveBeenCalledWith(String(DM), expect.stringContaining("свой вариант"), {
        accountId: "default",
      });
      expect(resolveOption).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    });

    it("someone the question was not put to can neither toggle nor send", async () => {
      const other = press({ t: 0 }, 1);
      await handleVkQuestionEvent({ event: other.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(other.answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
      expect(redraw).not.toHaveBeenCalled();
      const send = press({ d: 1 }, 1);
      await handleVkQuestionEvent({ event: send.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(send.answer)).toBe("Ответить на этот вопрос может только тот, кому он задан");
      expect(call).not.toHaveBeenCalled();
    });

    it("a typed answer from someone the question was not put to never reaches the gateway", async () => {
      expect(
        await answerVkQuestionByText({ accountId: "default", peerId: DM, senderId: 1, text: "1, 3", runtime: runtimeEnv }),
      ).toBe(false);
      expect(call).not.toHaveBeenCalled();
    });

    it("a gateway failure on «Готово» is logged by class, without the gateway's address or config path", async () => {
      await handleVkQuestionEvent({ event: press({ t: 0 }).event, accountId: "default", runtime: runtimeEnv });
      call.mockRejectedValue(gatewayDown());
      const done = press({ d: 1 });
      await handleVkQuestionEvent({ event: done.event, accountId: "default", runtime: runtimeEnv });
      expect(snackbar(done.answer)).toBe("Не получилось передать ответ. Ответьте текстом: номер варианта или свой ответ");
      expect(diagLog.error).toHaveBeenCalledWith(
        "question answer failed",
        expect.objectContaining({ errorName: "GatewayTransportError" }),
      );
      expect(everyLogLine()).not.toContain("openclaw.json");
      expect(everyLogLine()).not.toContain("ws://");
    });
  });

  describe("a record one button cannot settle, over the gateway", () => {
    const folders = ["banya", "cx7", "kodeks", "qwen21"];
    const record = (overrides: Record<string, unknown> = {}) => ({
      id: TQ,
      status: "pending",
      questions: [
        {
          questionId: "spornye",
          header: "Спорные",
          question: "Какие оставить?",
          multiSelect: true,
          options: folders.map((label) => ({ label })),
          ...overrides,
        },
      ],
    });
    const call = vi.fn();
    // The core's rules, reduced to what these cases need: numbers → labels.
    const buildAnswers: VkQuestionGateway["buildAnswers"] = (questions, text) => ({
      answers: Object.fromEntries(
        questions.map((question) => [
          question.id,
          {
            answers: text
              .split(/[,;\n]/u)
              .map((part) => question.options?.[Number(part.trim()) - 1]?.label)
              .filter((label): label is string => Boolean(label)),
          },
        ]),
      ),
    });

    beforeEach(() => {
      call.mockReset();
      resolveOption.mockRejectedValue(new Error("question button resolution requires one tappable question"));
      resetVkQuestionGatewayForTest({ gateway: { call, buildAnswers } });
    });

    it("a multi-select answered by numbers is written for every question, and the message is consumed", async () => {
      call.mockImplementation(async (method: string) => (method === "question.get" ? { question: record() } : {}));
      expect(await typed("1, 3")).toBe(true);
      expect(call).toHaveBeenLastCalledWith("question.resolve", {
        id: TQ,
        answers: { answers: { spornye: ["banya", "kodeks"] } },
        resolvedBy: String(DM),
      });
      expect(sendMessageVk).not.toHaveBeenCalled();
    });

    it("a reply that is not an answer is consumed with a hint, not handed to the core that refuses it", async () => {
      call.mockResolvedValue({ question: record() });
      expect(await typed("а зачем?")).toBe(true);
      expect(call).toHaveBeenCalledTimes(1);
      expect(sendMessageVk).toHaveBeenCalledWith(String(DM), expect.stringContaining("«1, 3»"), {
        accountId: "default",
      });
      expect(findOpenVkQuestionForChat({ accountId: "default", peerId: DM })?.questionId).toBe(TQ);
    });

    it("a secret question is never answered from chat text", async () => {
      call.mockResolvedValue({ question: record({ isSecret: true }) });
      expect(await typed("1")).toBe(false);
      expect(call).toHaveBeenCalledTimes(1);
      expect(findOpenVkQuestionForChat({ accountId: "default", peerId: DM })).toBeUndefined();
    });

    it("access lost before the write: nothing is written", async () => {
      call.mockResolvedValue({ question: record() });
      state.config = { channels: { vk: { token: "t", dmPolicy: "allowlist", allowFrom: [String(DM)] } } };
      const answering = typed("2");
      state.config = { channels: { vk: { token: "t", dmPolicy: "allowlist", allowFrom: ["1"] } } };
      expect(await answering).toBe(false);
      expect(call).not.toHaveBeenCalledWith("question.resolve", expect.anything());
    });

    it("already closed on the gateway: an ordinary message, and the question closes here", async () => {
      call.mockRejectedValue(Object.assign(new Error("not found"), { details: { reason: "QUESTION_NOT_FOUND" } }));
      expect(await typed("1")).toBe(false);
      expect(findOpenVkQuestionForChat({ accountId: "default", peerId: DM })).toBeUndefined();
    });

    it("a gateway failure leaves the question open for the next answer", async () => {
      call.mockRejectedValueOnce(gatewayDown());
      expect(await typed("1")).toBe(false);
      // Logged by class; the client's text with its address and config path is `full`-only.
      expect(diagLog.error).toHaveBeenCalledWith(
        "question typed answer not accepted",
        expect.objectContaining({ errorName: "GatewayTransportError" }),
      );
      expect(everyLogLine()).not.toContain("openclaw.json");
      expect(everyLogLine()).not.toContain("ws://");
      call.mockImplementation(async (method: string) => (method === "question.get" ? { question: record() } : {}));
      expect(await typed("1")).toBe(true);
    });

    describe("several questions in one call", () => {
      const two = () => ({
        id: TQ,
        status: "pending",
        questions: [
          { questionId: "first", header: "A", question: "?", options: [{ label: "a1" }, { label: "a2" }] },
          { questionId: "second", header: "B", question: "?", options: [{ label: "b1" }, { label: "b2" }] },
        ],
      });
      // The core's rule for several questions: a line per question, in order.
      const byLine: VkQuestionGateway["buildAnswers"] = (questions, text) => {
        const lines = text.split("\n");
        return {
          answers: Object.fromEntries(
            questions.map((question, index) => {
              const label = question.options?.[Number(lines[index]?.trim()) - 1]?.label;
              return [question.id, { answers: label ? [label] : [] }];
            }),
          ),
        };
      };

      beforeEach(() => {
        resetVkQuestionGatewayForTest({ gateway: { call, buildAnswers: byLine } });
        call.mockImplementation(async (method: string) => (method === "question.get" ? { question: two() } : {}));
      });

      it("a line per question answers every one of them", async () => {
        expect(await typed("2\n1")).toBe(true);
        expect(call).toHaveBeenLastCalledWith("question.resolve", {
          id: TQ,
          answers: { answers: { first: ["a2"], second: ["b1"] } },
          resolvedBy: String(DM),
        });
      });

      it("an answer that misses a question is not written: a hint, and the question stays open", async () => {
        expect(await typed("2")).toBe(true);
        expect(call).not.toHaveBeenCalledWith("question.resolve", expect.anything());
        expect(sendMessageVk).toHaveBeenCalledWith(String(DM), expect.stringContaining("по строке на каждый"), {
          accountId: "default",
        });
        expect(findOpenVkQuestionForChat({ accountId: "default", peerId: DM })?.questionId).toBe(TQ);
      });
    });
  });
});
