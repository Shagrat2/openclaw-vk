/**
 * Reading VK API failures.
 *
 * A module of its own because two callers need it: the send path (to decide
 * whether to retry) and diagnostics (what to write to the log). While these were
 * local helpers in `send.ts`, diagnostics extracted the code and message its own
 * way — and the voice branch read only `message`, losing `description`, which is
 * exactly where vk-io keeps permission failure text.
 */

/** Failure code: vk-io puts it either in `code` or in `error_code`. */
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

/** Failure text, joined from every field the vk-io layers put it in. */
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
