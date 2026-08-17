import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Continuation audio produced outside OpenClaw's single-shot TTS call.
 *
 * OpenClaw asks the configured TTS provider for exactly ONE audio file per
 * reply and gives up after `messages.tts.timeoutMs` (schema-capped at 120s).
 * A local neural voice cannot synthesize a long reply inside that budget, so a
 * long answer used to be summarized down to a couple of sentences before it was
 * spoken.
 *
 * A cooperating TTS command can instead speak as much as fits the budget, hand
 * that head audio back to OpenClaw, and keep synthesizing the remainder in the
 * background into a *parts directory*:
 *
 *   <parts dir>/<id>/manifest.json    // progress, updated as parts finish
 *   <parts dir>/<id>/part01.wav       // written atomically once ready
 *
 * This module lets the VK channel claim such a directory for the voice message
 * it is about to send and stream the remaining parts as follow-up voice notes,
 * so the user hears the whole reply instead of a summary.
 *
 * Matching is by head-audio duration inside a short time window: the manifest
 * records how long the head audio is, and the channel already probes exactly
 * that before sending. A directory is claimed at most once (atomic `wx` write),
 * so concurrent replies cannot steal each other's continuation.
 */

export type TtsPartStatus = "pending" | "ready" | "failed";

export type TtsPartEntry = {
  index: number;
  file: string;
  chars?: number;
  status: TtsPartStatus;
  durationMs?: number | null;
};

export type TtsPartsManifest = {
  id: string;
  createdAtMs: number;
  headDurationMs: number;
  status?: string;
  truncated?: boolean;
  parts: TtsPartEntry[];
};

const CLAIM_FILE = "claimed.json";
const MANIFEST_FILE = "manifest.json";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Directory the TTS command writes continuation parts into. */
export function getTtsPartsDir(): string {
  const raw = process.env.TTS_PARTS_DIR?.trim();
  if (raw) {
    return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  }
  return join(homedir(), ".openclaw", "tts-parts");
}

/** Continuation delivery is on unless explicitly disabled. */
export function isTtsPartsEnabled(): boolean {
  return process.env.VK_TTS_PARTS?.trim() !== "0";
}

/** How far head duration may drift from the manifest (container/codec rewrap). */
export function getTtsPartsMatchToleranceMs(): number {
  return readPositiveIntEnv("VK_TTS_PARTS_MATCH_MS", 1_500);
}

/** Manifests older than this are ignored (and swept). */
export function getTtsPartsMaxAgeMs(): number {
  return readPositiveIntEnv("VK_TTS_PARTS_MAX_AGE_MS", 600_000);
}

/** How long to wait for a single part to finish synthesizing. */
export function getTtsPartWaitMs(): number {
  return readPositiveIntEnv("VK_TTS_PARTS_WAIT_MS", 300_000);
}

function isManifest(value: unknown): value is TtsPartsManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<TtsPartsManifest>;
  return (
    typeof candidate.createdAtMs === "number" &&
    typeof candidate.headDurationMs === "number" &&
    Array.isArray(candidate.parts)
  );
}

export async function readTtsPartsManifest(dir: string): Promise<TtsPartsManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8"));
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Claims the continuation directory belonging to a head audio of `headDurationMs`.
 *
 * Returns the directory path, or null when there is nothing to continue (the
 * common case: short replies, or a TTS command that does not produce parts).
 * The claim is exclusive — a second caller with the same duration gets null.
 */
export async function claimTtsParts(headDurationMs: number | null): Promise<string | null> {
  if (!isTtsPartsEnabled() || headDurationMs === null || !Number.isFinite(headDurationMs)) {
    return null;
  }
  const root = getTtsPartsDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }

  const now = Date.now();
  const maxAgeMs = getTtsPartsMaxAgeMs();
  const toleranceMs = getTtsPartsMatchToleranceMs();
  const candidates: Array<{ dir: string; manifest: TtsPartsManifest }> = [];

  for (const entry of entries) {
    const dir = join(root, entry);
    const manifest = await readTtsPartsManifest(dir);
    if (!manifest) {
      continue;
    }
    if (now - manifest.createdAtMs > maxAgeMs) {
      continue;
    }
    if (Math.abs(manifest.headDurationMs - headDurationMs) > toleranceMs) {
      continue;
    }
    if (manifest.parts.length === 0) {
      continue;
    }
    candidates.push({ dir, manifest });
  }

  // Closest duration first, newest as the tie-break: with several replies in
  // flight the audio we are holding is the best match for exactly one of them.
  candidates.sort((a, b) => {
    const byDistance =
      Math.abs(a.manifest.headDurationMs - headDurationMs) -
      Math.abs(b.manifest.headDurationMs - headDurationMs);
    return byDistance !== 0 ? byDistance : b.manifest.createdAtMs - a.manifest.createdAtMs;
  });

  for (const candidate of candidates) {
    try {
      await writeFile(
        join(candidate.dir, CLAIM_FILE),
        JSON.stringify({ claimedAtMs: now, headDurationMs }),
        { flag: "wx" },
      );
      return candidate.dir;
    } catch {
      // Already claimed by another in-flight reply — try the next best match.
    }
  }
  return null;
}

/**
 * Waits until `index` is synthesized. Resolves with the finished entry, or null
 * if the part failed or the wait timed out (the caller then skips to the next
 * part rather than dropping the whole continuation).
 */
export async function waitForTtsPart(
  dir: string,
  index: number,
  options?: { waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<TtsPartEntry | null> {
  const waitMs = options?.waitMs ?? getTtsPartWaitMs();
  const pollMs = options?.pollMs ?? 1_500;
  const now = options?.now ?? (() => Date.now());
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + waitMs;

  for (;;) {
    const manifest = await readTtsPartsManifest(dir);
    const part = manifest?.parts.find((candidate) => candidate.index === index);
    if (!part) {
      return null;
    }
    if (part.status === "ready") {
      return part;
    }
    if (part.status === "failed") {
      return null;
    }
    if (now() >= deadline) {
      return null;
    }
    await sleep(pollMs);
  }
}

/** Drops a finished continuation directory. Never throws. */
export async function discardTtsParts(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
