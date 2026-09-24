/**
 * A pressed question button (`message_event`) → the core's answer to the question.
 *
 * VK delivers a callback button press as `message_event` and keeps the button
 * spinning until the bot answers the event, so every press we recognise is
 * answered exactly once, with a snackbar saying what happened.
 *
 * Who may answer: in a direct chat only its other side — the question was put
 * to them; in a group chat only a sender the account's group allowlist admits,
 * and in an open group anyone in it. The check runs before the press is passed
 * on and again as the resolver's `authorize`, right before the answer is
 * written, so access lost in between cannot answer.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { resolveVkAccount } from "./accounts.js";
import { redactVkId, vkDiag } from "./diagnostics.js";
import {
  isVkGroupPeerId,
  normalizeVkAllowlist,
  resolveVkAllowlistMatch,
} from "./send-support.js";
import {
  findOpenVkQuestionDelivery,
  loadVkQuestionRuntime,
  markVkQuestionTerminal,
  parseVkQuestionCallback,
} from "./question.js";
import { getVkRuntime, readVkRuntimeConfig } from "./runtime.js";
import { sendMessageVk } from "./send.js";
import type { CoreConfig } from "./types.js";

/** The part of vk-io's `MessageEventContext` this handler uses. */
export type VkQuestionEvent = {
  userId: number;
  peerId: number;
  eventPayload: unknown;
  answer: (eventData: { type: "show_snackbar"; text: string }) => Promise<unknown>;
};

const TEXT = {
  closed: "Этот вопрос уже закрыт",
  notYours: "Ответить на этот вопрос может только тот, кому он задан",
  answered: (label: string) => `Ответ принят: ${label}`,
  customInputSnackbar: "Напишите свой вариант ответа сообщением",
  customInputMessage: "✍️ Напишите свой вариант ответа одним сообщением.",
  failed: "Не получилось передать ответ. Ответьте текстом: номер варианта или свой ответ",
} as const;

/** VK snackbar text limit. */
const SNACKBAR_MAX_CHARS = 90;

function snackbarText(text: string): string {
  const chars = Array.from(text);
  return chars.length <= SNACKBAR_MAX_CHARS ? text : `${chars.slice(0, SNACKBAR_MAX_CHARS - 1).join("")}…`;
}

/** May `userId` answer a question delivered to `peerId`, under the current config? */
export function isVkQuestionAnswerer(params: {
  config: CoreConfig;
  accountId: string;
  peerId: number;
  userId: number;
}): boolean {
  if (!isVkGroupPeerId(params.peerId)) {
    return params.userId === params.peerId;
  }
  const account = resolveVkAccount({ cfg: params.config, accountId: params.accountId });
  const groupConfig =
    account.config.groups?.[String(params.peerId)] ?? account.config.groups?.["*"];
  if (groupConfig?.enabled === false || account.config.groupPolicy === "disabled") {
    return false;
  }
  const allowFrom =
    groupConfig && Object.hasOwn(groupConfig, "allowFrom")
      ? normalizeVkAllowlist(groupConfig.allowFrom)
      : normalizeVkAllowlist(account.config.groupAllowFrom);
  if (allowFrom.length === 0) {
    return account.config.groupPolicy === "open";
  }
  return resolveVkAllowlistMatch({ allowFrom, senderId: params.userId }).allowed;
}

/**
 * Handles one `message_event`. Returns false when the press is not a question
 * button, so the caller can leave it alone.
 */
export async function handleVkQuestionEvent(params: {
  event: VkQuestionEvent;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<boolean> {
  const { event, accountId, runtime } = params;
  const callback = parseVkQuestionCallback(event.eventPayload);
  if (!callback) {
    return false;
  }
  const { questionId } = callback;
  const reply = async (text: string): Promise<void> => {
    try {
      await event.answer({ type: "show_snackbar", text: snackbarText(text) });
    } catch (error) {
      runtime.log?.(`vk: question event answer failed: ${String(error)}`);
    }
  };
  const isOpenHere = () =>
    findOpenVkQuestionDelivery({ questionId, accountId, peerId: event.peerId }) !== undefined;
  const mayAnswer = () =>
    isOpenHere() &&
    isVkQuestionAnswerer({
      config: readVkRuntimeConfig(getVkRuntime()),
      accountId,
      peerId: event.peerId,
      userId: event.userId,
    });

  vkDiag("question button", {
    questionId,
    intent: callback.intent,
    peerId: event.peerId,
    userId: event.userId,
  });
  if (!isOpenHere()) {
    await reply(TEXT.closed);
    return true;
  }
  if (!mayAnswer()) {
    runtime.log?.(
      `vk: question ${questionId} press refused for user=${redactVkId(event.userId)} peer=${redactVkId(event.peerId)}`,
    );
    await reply(TEXT.notYours);
    return true;
  }
  const questionRuntime = await loadVkQuestionRuntime();
  if (!questionRuntime) {
    await reply(TEXT.failed);
    return true;
  }

  const common = {
    cfg: readVkRuntimeConfig(getVkRuntime()) as OpenClawConfig,
    questionId,
    senderId: String(event.userId),
    clientDisplayName: `VK question (${event.userId})`,
    authorize: mayAnswer,
  };
  try {
    const result =
      callback.intent === "custom-input"
        ? await questionRuntime.resolveOption({ ...common, customInput: true })
        : await questionRuntime.resolveOption({ ...common, optionIndex: callback.optionIndex });
    vkDiag("question button resolved", { questionId, status: result.status });
    switch (result.status) {
      case "answered":
        await reply(TEXT.answered(result.optionValue));
        return true;
      case "custom-input":
        // The typed answer arrives as an ordinary message; the core claims it
        // for the pending question at ingress. Buttons stay: a person who
        // changes their mind can still press one.
        await reply(TEXT.customInputSnackbar);
        try {
          await sendMessageVk(String(event.peerId), TEXT.customInputMessage, { accountId });
        } catch (error) {
          // The snackbar already asked for the answer; the hint is a courtesy.
          runtime.log?.(`vk: question ${questionId} custom-input hint failed: ${String(error)}`);
        }
        return true;
      case "denied":
        await reply(TEXT.notYours);
        return true;
      default:
        markVkQuestionTerminal(questionId);
        await reply(TEXT.closed);
        return true;
    }
  } catch (error) {
    runtime.error?.(`vk: question ${questionId} answer failed: ${String(error)}`);
    await reply(TEXT.failed);
    return true;
  }
}
