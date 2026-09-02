/**
 * Чтение отказов VK API.
 *
 * Живёт отдельным модулем, потому что нужно двоим: пути отправки (решить,
 * повторять ли) и диагностике (что написать в лог). Пока это были локальные
 * функции `send.ts`, диагностика доставала код и текст ошибки своими способами —
 * и в ветке голосовых читала только `message`, теряя `description`, где vk-io
 * как раз держит текст отказа по правам.
 */

/** Код отказа: vk-io кладёт его то в `code`, то в `error_code`. */
export function readVkErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.code === "number") {
    return record.code;
  }
  if (typeof record.error_code === "number") {
    return record.error_code;
  }
  return undefined;
}

/** Текст отказа, склеенный из всех полей, куда его кладут разные слои vk-io. */
export function readVkErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as Record<string, unknown>;
  return [
    typeof record.message === "string" ? record.message : "",
    typeof record.name === "string" ? record.name : "",
    typeof record.description === "string" ? record.description : "",
  ]
    .filter(Boolean)
    .join(" ");
}
