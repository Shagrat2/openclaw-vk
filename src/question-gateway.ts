/**
 * Typed answers to questions a single button cannot settle: several questions in
 * one call, or a multi-select one.
 *
 * The SDK resolver (`questionGatewayRuntime.resolveOption`) settles only one
 * tappable question and refuses the rest before writing anything. The core's own
 * ingress claim then refuses the typed reply as well ("question answer caller
 * policy does not match its creator"), so the run held `ask_user` and every
 * message in the chat came back as "The answer was not sent" until somebody
 * stopped the run (27.09.2026, ask_51c8eb48…, a multi-select).
 *
 * Here the record is read with `question.get`, the text parsed by the core's own
 * rules (`buildAgentHarnessUserInputAnswers`: "1, 3", an option's text, one line
 * or `id: answer` per question) and written with `question.resolve`. Secret
 * questions are never answered from chat text.
 *
 * Dynamic imports on purpose, as `loadVkQuestionRuntime`: without these subpaths
 * the question stays unanswerable by text, as it was before.
 */
import { vkDiag } from "./diagnostics.js";
import type { VkQuestionPrompt } from "./question.js";

type GatewayCall = (method: string, params: unknown) => Promise<Record<string, unknown>>;

type HarnessQuestion = {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  isOther?: boolean;
  options?: readonly { label: string }[] | null;
};

type AnswerBuilder = (
  questions: readonly HarnessQuestion[],
  text: string,
) => { answers: Record<string, { answers: string[] }> };

export type VkQuestionGateway = { call: GatewayCall; buildAnswers: AnswerBuilder };

type RecordQuestion = HarnessQuestion & { questionId: string; isSecret?: boolean };

export type VkQuestionGatewayResult =
  | { status: "answered"; answers: Record<string, string[]> }
  | { status: "not-an-answer" }
  | { status: "secret" }
  | { status: "already-terminal" }
  | { status: "denied" }
  | { status: "unavailable" };

let gatewayPromise: Promise<VkQuestionGateway | undefined> | undefined;

export function loadVkQuestionGateway(): Promise<VkQuestionGateway | undefined> {
  gatewayPromise ??= Promise.all([
    import("openclaw/plugin-sdk/gateway-runtime"),
    import("openclaw/plugin-sdk/agent-harness-runtime"),
  ])
    .then(([gateway, harness]): VkQuestionGateway => ({
      call: (method, params) =>
        gateway.callGatewayFromCli(method, {}, params, {
          scopes: ["operator.questions"],
          progress: false,
        }),
      buildAnswers: harness.buildAgentHarnessUserInputAnswers as AnswerBuilder,
    }))
    .catch((error: unknown) => {
      vkDiag("question gateway unavailable", { reason: String(error) });
      return undefined;
    });
  return gatewayPromise;
}

/** Forget the loaded gateway; with `preset`, pretend the load gave that instead. */
export function resetVkQuestionGatewayForTest(preset?: { gateway: VkQuestionGateway | undefined }): void {
  gatewayPromise = preset ? Promise.resolve(preset.gateway) : undefined;
}

function isTerminalError(error: unknown): boolean {
  const reason = (error as { details?: { reason?: unknown } } | undefined)?.details?.reason;
  return reason === "QUESTION_ALREADY_TERMINAL" || reason === "QUESTION_NOT_FOUND";
}

/**
 * Answers every question of the record from one typed message, or leaves it
 * untouched: an answer that misses a question is not written.
 */
export async function resolveVkQuestionTextOverGateway(params: {
  questionId: string;
  text: string;
  senderId: string;
  authorize: () => Promise<boolean>;
}): Promise<VkQuestionGatewayResult> {
  const gateway = await loadVkQuestionGateway();
  if (!gateway) {
    return { status: "unavailable" };
  }
  let record: { status?: unknown; questions?: RecordQuestion[] } | undefined;
  try {
    const result = await gateway.call("question.get", { id: params.questionId });
    record = result.question as typeof record;
  } catch (error) {
    if (isTerminalError(error)) {
      return { status: "already-terminal" };
    }
    throw error;
  }
  if (!record || record.status !== "pending" || !record.questions?.length) {
    return { status: "already-terminal" };
  }
  if (record.questions.some((question) => question.isSecret)) {
    return { status: "secret" };
  }
  const questions: HarnessQuestion[] = record.questions.map((question) => ({
    id: question.questionId,
    header: question.header,
    question: question.question,
    multiSelect: question.multiSelect,
    isOther: question.isOther,
    options: question.options,
  }));
  const built = gateway.buildAnswers(questions, params.text);
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const given = built.answers[question.id]?.answers ?? [];
    if (given.length === 0) {
      return { status: "not-an-answer" };
    }
    answers[question.id] = given;
  }
  return await writeAnswers(gateway, { ...params, answers });
}

/** Writes the answers after a last access check; "denied" writes nothing. */
async function writeAnswers(
  gateway: VkQuestionGateway,
  params: {
    questionId: string;
    answers: Record<string, string[]>;
    senderId: string;
    authorize: () => Promise<boolean>;
  },
): Promise<VkQuestionGatewayResult> {
  if (!(await params.authorize())) {
    return { status: "denied" };
  }
  try {
    await gateway.call("question.resolve", {
      id: params.questionId,
      answers: { answers: params.answers },
      resolvedBy: params.senderId,
    });
  } catch (error) {
    if (isTerminalError(error)) {
      return { status: "already-terminal" };
    }
    throw error;
  }
  return { status: "answered", answers: params.answers };
}

/** The options marked with the buttons of a multi-select question, sent by "Готово". */
export async function resolveVkQuestionMarkedOverGateway(params: {
  questionId: string;
  answerKey: string;
  labels: string[];
  senderId: string;
  authorize: () => Promise<boolean>;
}): Promise<VkQuestionGatewayResult> {
  const gateway = await loadVkQuestionGateway();
  if (!gateway) {
    return { status: "unavailable" };
  }
  return await writeAnswers(gateway, {
    questionId: params.questionId,
    answers: { [params.answerKey]: params.labels },
    senderId: params.senderId,
    authorize: params.authorize,
  });
}

/**
 * A multi-select question as toggle buttons: the core renders none for it, so
 * the options are read from the record. Only one question, not secret, and as
 * many options as fit beside "Свой вариант" (when an own answer is allowed) and
 * "Готово" in VK's ten buttons; anything else stays text-only and is answered
 * by typing.
 */
export async function readVkMultiSelectPrompt(
  questionId: string,
  maxOptions: number,
): Promise<VkQuestionPrompt | undefined> {
  const gateway = await loadVkQuestionGateway();
  if (!gateway) {
    return undefined;
  }
  try {
    const result = await gateway.call("question.get", { id: questionId });
    const record = result.question as { status?: unknown; questions?: RecordQuestion[] } | undefined;
    const [question, ...rest] = record?.questions ?? [];
    const options = (question?.options ?? []).map((option) => option.label).filter(Boolean);
    if (
      record?.status !== "pending" ||
      !question ||
      rest.length > 0 ||
      !question.multiSelect ||
      question.isSecret ||
      options.length === 0 ||
      options.length + (question.isOther ? 1 : 0) > maxOptions
    ) {
      return undefined;
    }
    return {
      questionId,
      options,
      customInput: question.isOther === true,
      multiSelect: { answerKey: question.questionId },
    };
  } catch (error) {
    vkDiag("question record unavailable", { questionId, reason: String(error) });
    return undefined;
  }
}
