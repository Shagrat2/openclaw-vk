import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimTtsParts,
  discardTtsParts,
  readTtsPartsManifest,
  waitForTtsPart,
  type TtsPartsManifest,
} from "./tts-parts.js";

let root: string;

async function writeManifest(
  id: string,
  overrides: Partial<TtsPartsManifest> = {},
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const manifest: TtsPartsManifest = {
    id,
    createdAtMs: Date.now(),
    headDurationMs: 60_000,
    status: "synthesizing",
    parts: [{ index: 1, file: "part01.wav", status: "pending", durationMs: null }],
    ...overrides,
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vk-tts-parts-test-"));
  process.env.TTS_PARTS_DIR = root;
  delete process.env.VK_TTS_PARTS;
});

afterEach(async () => {
  delete process.env.TTS_PARTS_DIR;
  delete process.env.VK_TTS_PARTS;
  delete process.env.VK_TTS_PARTS_MATCH_MS;
  delete process.env.VK_TTS_PARTS_MAX_AGE_MS;
  delete process.env.VK_TTS_PARTS_WAIT_MS;
  await rm(root, { recursive: true, force: true });
});

describe("claimTtsParts", () => {
  it("claims the manifest whose head duration matches the audio being sent", async () => {
    const dir = await writeManifest("match", { headDurationMs: 61_200 });
    await writeManifest("other", { headDurationMs: 12_000 });

    expect(await claimTtsParts(61_000)).toBe(dir);
  });

  it("does not claim when no head duration matches", async () => {
    await writeManifest("other", { headDurationMs: 12_000 });

    expect(await claimTtsParts(61_000)).toBeNull();
  });

  it("claims a directory only once so concurrent replies cannot steal it", async () => {
    const dir = await writeManifest("single", { headDurationMs: 30_000 });

    expect(await claimTtsParts(30_000)).toBe(dir);
    expect(await claimTtsParts(30_000)).toBeNull();
  });

  it("prefers the closest head duration when several replies are in flight", async () => {
    await writeManifest("far", { headDurationMs: 31_400 });
    const near = await writeManifest("near", { headDurationMs: 30_100 });

    expect(await claimTtsParts(30_000)).toBe(near);
  });

  it("ignores manifests older than the freshness window", async () => {
    await writeManifest("stale", {
      headDurationMs: 30_000,
      createdAtMs: Date.now() - 20 * 60_000,
    });

    expect(await claimTtsParts(30_000)).toBeNull();
  });

  it("ignores manifests without continuation parts", async () => {
    await writeManifest("empty", { headDurationMs: 30_000, parts: [] });

    expect(await claimTtsParts(30_000)).toBeNull();
  });

  it("stays inert when continuation delivery is disabled", async () => {
    await writeManifest("disabled", { headDurationMs: 30_000 });
    process.env.VK_TTS_PARTS = "0";

    expect(await claimTtsParts(30_000)).toBeNull();
  });

  it("returns null when the audio duration is unknown", async () => {
    await writeManifest("unknown", { headDurationMs: 30_000 });

    expect(await claimTtsParts(null)).toBeNull();
  });

  it("returns null when nothing produced parts at all", async () => {
    expect(await claimTtsParts(30_000)).toBeNull();
  });
});

describe("waitForTtsPart", () => {
  it("resolves once the background worker marks the part ready", async () => {
    const dir = await writeManifest("waiting");
    let polls = 0;

    const pending = waitForTtsPart(dir, 1, {
      waitMs: 10_000,
      pollMs: 0,
      sleep: async () => {
        polls += 1;
        if (polls === 2) {
          await writeFile(
            join(dir, "manifest.json"),
            JSON.stringify({
              id: "waiting",
              createdAtMs: Date.now(),
              headDurationMs: 60_000,
              parts: [{ index: 1, file: "part01.wav", status: "ready", durationMs: 38_000 }],
            }),
            "utf8",
          );
        }
      },
    });

    await expect(pending).resolves.toMatchObject({ status: "ready", durationMs: 38_000 });
  });

  it("gives up on a part the worker failed to synthesize", async () => {
    const dir = await writeManifest("failed", {
      parts: [{ index: 1, file: "part01.wav", status: "failed", durationMs: null }],
    });

    expect(await waitForTtsPart(dir, 1, { waitMs: 10_000, pollMs: 0 })).toBeNull();
  });

  it("times out instead of waiting forever on a stuck part", async () => {
    const dir = await writeManifest("stuck");
    let now = 0;

    const result = await waitForTtsPart(dir, 1, {
      waitMs: 5_000,
      pollMs: 0,
      now: () => now,
      sleep: async () => {
        now += 2_000;
      },
    });

    expect(result).toBeNull();
  });
});

describe("manifest lifecycle", () => {
  it("reads back a manifest written by the TTS command", async () => {
    const dir = await writeManifest("read", { headDurationMs: 45_000 });

    expect(await readTtsPartsManifest(dir)).toMatchObject({ headDurationMs: 45_000 });
  });

  it("rejects a manifest that is not shaped like one", async () => {
    const dir = join(root, "garbage");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), "{\"nope\":true}", "utf8");

    expect(await readTtsPartsManifest(dir)).toBeNull();
    expect(await claimTtsParts(30_000)).toBeNull();
  });

  it("removes the directory after the continuation is delivered", async () => {
    const dir = await writeManifest("done");
    await writeFile(join(dir, "part01.wav"), "audio", "utf8");

    await discardTtsParts(dir);

    expect(existsSync(dir)).toBe(false);
  });
});

describe("claim marker", () => {
  it("records the claim so a restarted gateway does not resend parts", async () => {
    const dir = await writeManifest("marker", { headDurationMs: 30_000 });

    await claimTtsParts(30_000);

    const claim: unknown = JSON.parse(await readFile(join(dir, "claimed.json"), "utf8"));
    expect(claim).toMatchObject({ headDurationMs: 30_000 });
  });
});

describe("tunables and guards", () => {
  it("expands a ~/ prefixed parts directory to the home directory", async () => {
    const { getTtsPartsDir } = await import("./tts-parts.js");
    process.env.TTS_PARTS_DIR = "~/custom-tts-parts";
    const { homedir } = await import("node:os");

    expect(getTtsPartsDir()).toBe(join(homedir(), "custom-tts-parts"));
  });

  it("falls back to ~/.openclaw/tts-parts when nothing is configured", async () => {
    const { getTtsPartsDir } = await import("./tts-parts.js");
    delete process.env.TTS_PARTS_DIR;
    const { homedir } = await import("node:os");

    expect(getTtsPartsDir()).toBe(join(homedir(), ".openclaw", "tts-parts"));
  });

  it("treats continuation as enabled unless explicitly switched off", async () => {
    const { isTtsPartsEnabled } = await import("./tts-parts.js");

    expect(isTtsPartsEnabled()).toBe(true);
    process.env.VK_TTS_PARTS = "0";
    expect(isTtsPartsEnabled()).toBe(false);
  });

  it("reads the per-part wait from the environment, ignoring nonsense", async () => {
    const { getTtsPartWaitMs } = await import("./tts-parts.js");

    expect(getTtsPartWaitMs()).toBe(300_000);
    process.env.VK_TTS_PARTS_WAIT_MS = "1000";
    expect(getTtsPartWaitMs()).toBe(1_000);
    process.env.VK_TTS_PARTS_WAIT_MS = "not-a-number";
    expect(getTtsPartWaitMs()).toBe(300_000);
    delete process.env.VK_TTS_PARTS_WAIT_MS;
  });

  it("rejects a manifest that is not shaped like one", async () => {
    // A half-written manifest must not be treated as a claimable directory.
    const dir = join(root, "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ id: "broken" }), "utf8");

    expect(await readTtsPartsManifest(dir)).toBeNull();
  });

  it("returns null for unreadable or absent manifests", async () => {
    expect(await readTtsPartsManifest(join(root, "does-not-exist"))).toBeNull();
  });

  it("claims nothing when the head duration is unknown", async () => {
    // Without a head duration there is nothing to match parts against.
    expect(await claimTtsParts(null)).toBeNull();
    expect(await claimTtsParts(Number.NaN)).toBeNull();
  });

  it("claims nothing when the parts root does not exist", async () => {
    process.env.TTS_PARTS_DIR = join(root, "missing-root");
    expect(await claimTtsParts(60_000)).toBeNull();
  });
});
