import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/core";

/**
 * Positive integer from the environment, or the fallback.
 *
 * One place rather than four: `send.ts`, `audio-chunk.ts`, `tts-parts.ts` and
 * `monitor.ts` each grew their own copy, and they did not agree — the local ones
 * used `Number.parseInt`, which reads "12abc" as 12, while the core parser
 * rejects it. Tunables that silently accept a typo are worse than tunables that
 * fall back to their default.
 */
export function envPositiveInt(name: string, fallback: number): number {
  return parseStrictPositiveInteger(process.env[name]) ?? fallback;
}
