import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupAudioSegments,
  getVkAudioMessageMaxMs,
  parseSilenceWindows,
  probeAudioDurationMs,
  selectCutPointsMs,
  splitAudioAtSilence,
} from "./audio-chunk.js";

/**
 * Makes the mocked execFile resolve with the given stdout/stderr by invoking
 * its node-style callback (last argument).
 */
function stubExecFile(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
    cb(null, stdout, stderr);
  });
}

function stubExecFileError(message: string, stderr = ""): void {
  mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
    const error = new Error(message) as Error & { stderr?: string };
    error.stderr = stderr;
    cb(error, "", stderr);
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
  delete process.env.VK_AUDIO_MESSAGE_MAX_MS;
  delete process.env.FFPROBE_BIN;
  delete process.env.FFMPEG_BIN;
  delete process.env.VK_AUDIO_SPLIT_MAX_INPUT_BYTES;
});

describe("getVkAudioMessageMaxMs", () => {
  it("defaults to 270000 ms (4.5 min)", () => {
    expect(getVkAudioMessageMaxMs()).toBe(270_000);
  });

  it("honors VK_AUDIO_MESSAGE_MAX_MS env override", () => {
    process.env.VK_AUDIO_MESSAGE_MAX_MS = "60000";
    expect(getVkAudioMessageMaxMs()).toBe(60_000);
  });

  it("ignores invalid env values", () => {
    process.env.VK_AUDIO_MESSAGE_MAX_MS = "not-a-number";
    expect(getVkAudioMessageMaxMs()).toBe(270_000);
  });
});

describe("probeAudioDurationMs", () => {
  it("parses ffprobe duration seconds into ms", async () => {
    stubExecFile("123.456\n");
    await expect(probeAudioDurationMs("/tmp/a.ogg")).resolves.toBe(123_456);
  });

  it("returns null when ffprobe output is not a positive number", async () => {
    stubExecFile("N/A\n");
    await expect(probeAudioDurationMs("/tmp/a.ogg")).resolves.toBeNull();
  });

  it("returns null (never throws) when ffprobe fails", async () => {
    stubExecFileError("ffprobe not found");
    await expect(probeAudioDurationMs("/tmp/a.ogg")).resolves.toBeNull();
  });
});

describe("parseSilenceWindows", () => {
  it("pairs silence_start with silence_end", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 10.5",
      "[silencedetect @ 0x1] silence_end: 11.2 | silence_duration: 0.7",
      "[silencedetect @ 0x1] silence_start: 250.0",
      "[silencedetect @ 0x1] silence_end: 251.0 | silence_duration: 1.0",
    ].join("\n");
    expect(parseSilenceWindows(stderr)).toEqual([
      { start: 10.5, end: 11.2 },
      { start: 250.0, end: 251.0 },
    ]);
  });

  it("returns empty for output with no silence", () => {
    expect(parseSilenceWindows("nothing here")).toEqual([]);
  });
});

describe("selectCutPointsMs", () => {
  it("returns no cuts when total ≤ max", () => {
    expect(selectCutPointsMs([], 100_000, 270_000)).toEqual([]);
  });

  it("prefers the last silence midpoint before the max boundary", () => {
    // total 600s, max 270s. Silence windows at 100s, 260s, 280s.
    const windows = [
      { start: 100, end: 100.5 },
      { start: 260, end: 260.5 },
      { start: 280, end: 280.5 },
    ];
    const cuts = selectCutPointsMs(windows, 600_000, 270_000);
    // First cut: last silence ≤ 270s → midpoint of 260..260.5 = 260250 ms.
    expect(cuts[0]).toBe(260_250);
    // Every segment must be ≤ max.
    let prev = 0;
    for (const cut of cuts) {
      expect(cut - prev).toBeLessThanOrEqual(270_000);
      prev = cut;
    }
    expect(600_000 - prev).toBeLessThanOrEqual(270_000);
  });

  it("cuts hard at max when no silence fits in the window", () => {
    // Cuts are planned with a 250 ms margin: stream copy moves the boundary
    // forward to a key frame, and without the margin a segment would exceed the
    // VK limit.
    const cuts = selectCutPointsMs([], 600_000, 270_000);
    expect(cuts).toEqual([269_750, 539_500]);
  });
});

describe("splitAudioAtSilence temp dir cleanup", () => {
  async function vkVoiceDirs(): Promise<string[]> {
    const entries = await readdir(tmpdir());
    return entries.filter((e) => e.startsWith("vk-voice-")).sort();
  }

  it("removes the temp dir when the first ffmpeg extraction fails", async () => {
    // Regression guard for finding #3: on the first-segment failure `outputs`
    // is empty, so cleanupAudioSegments can't derive the mkdtemp dir — it must
    // be removed explicitly or the vk-voice-* dir (and a partial file) leaks.
    const before = await vkVoiceDirs();

    mockExecFile.mockImplementation(
      (
        _bin: string,
        args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const a = args.join(" ");
        if (a.includes("format=duration")) {
          cb(null, "100.0\n", ""); // 100s >> maxMs → will split
        } else if (a.includes("silencedetect")) {
          cb(null, "", ""); // no silence → even cuts by maxMs still apply
        } else {
          // extraction of the very first segment fails
          const err = Object.assign(new Error("ffmpeg boom"), { stderr: "boom" });
          cb(err, "", "boom");
        }
      },
    );

    const result = await splitAudioAtSilence("/tmp/in.ogg", 40_000);
    expect(result).toEqual([]);
    expect(await vkVoiceDirs()).toEqual(before); // no leaked vk-voice-* dir
  });
});

describe("предохранители нарезки", () => {
  it("не режет, когда кусков вышло бы больше потолка — и не тратит на это ffmpeg", async () => {
    mockExecFile.mockClear();
    // Two hours at a four-minute ceiling would mean three dozen voice messages.
    const out = await splitAudioAtSilence("/tmp/huge.ogg", 240_000, {
      knownDurationMs: 2 * 60 * 60 * 1000,
    });
    expect(out).toEqual([]);
    // Decided from the known duration — the expensive silence search never ran.
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("не мерит длительность второй раз, если её передали", async () => {
    mockExecFile.mockClear();
    const out = await splitAudioAtSilence("/tmp/x.ogg", 240_000, {
      knownDurationMs: 100_000,
    });
    // 100s is under the 240s ceiling — nothing to split, and no need for ffprobe.
    expect(out).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});


describe("splitAudioAtSilence — full extraction path", () => {
  /**
   * ffmpeg/ffprobe are mocked, so nothing is written to disk; the function only
   * builds paths. `respond` picks an answer per invocation kind, because a
   * single split calls three different tools in turn.
   */
  function stubTools(opts: {
    durationSec?: string;
    silence?: string;
    extractFails?: boolean;
    segmentDurationSec?: string | ((path: string) => string | Error);
  }): void {
    mockExecFile.mockImplementation(
      (
        _bin: string,
        args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const line = args.join(" ");
        if (line.includes("format=duration")) {
          const target = args[args.length - 1] as string;
          if (target.includes("part-") && opts.segmentDurationSec !== undefined) {
            const answer =
              typeof opts.segmentDurationSec === "function"
                ? opts.segmentDurationSec(target)
                : opts.segmentDurationSec;
            if (answer instanceof Error) {
              cb(answer, "", "");
              return;
            }
            cb(null, `${answer}\n`, "");
            return;
          }
          cb(null, `${opts.durationSec ?? "100.0"}\n`, "");
          return;
        }
        if (line.includes("silencedetect")) {
          cb(null, "", opts.silence ?? "");
          return;
        }
        if (opts.extractFails) {
          cb(Object.assign(new Error("ffmpeg boom"), { stderr: "boom" }), "", "boom");
          return;
        }
        cb(null, "", "");
      },
    );
  }

  it("returns one file per range when every segment fits the limit", async () => {
    stubTools({ durationSec: "100.0", segmentDurationSec: "20.0" });

    const parts = await splitAudioAtSilence("/tmp/voice.ogg", 30_000);

    // 100s at a 30s limit: four ranges, so four files.
    expect(parts).toHaveLength(4);
    expect(parts.every((p) => p.includes("vk-voice-"))).toBe(true);
    // The extension follows the source: `-c copy` keeps the container.
    expect(parts.every((p) => p.endsWith(".ogg"))).toBe(true);
    await cleanupAudioSegments(parts);
  });

  it("discards the whole split when a segment came out longer than the limit", async () => {
    // The point of the post-check: VK rejects an over-long segment exactly as it
    // rejected the original, so half a split is worse than none — the caller
    // falls back to sending a document.
    stubTools({
      durationSec: "100.0",
      segmentDurationSec: (path) => (path.endsWith("002.ogg") ? "45.0" : "20.0"),
    });

    expect(await splitAudioAtSilence("/tmp/voice.ogg", 30_000)).toEqual([]);
  });

  it("keeps the split when a segment duration cannot be probed", async () => {
    // An unreadable segment is not proof of a bad split; refusing here would
    // throw away a usable result.
    stubTools({
      durationSec: "100.0",
      segmentDurationSec: () => new Error("ffprobe unavailable"),
    });

    expect(await splitAudioAtSilence("/tmp/voice.ogg", 30_000)).toHaveLength(4);
  });

  it("gives up when the source is longer than the segment ceiling allows", async () => {
    // Two hours at a 30s limit would mean 240 voice messages; the guard stops
    // before the expensive silence search.
    stubTools({ durationSec: "7200.0" });

    expect(await splitAudioAtSilence("/tmp/voice.ogg", 30_000)).toEqual([]);
  });

  it("does nothing for an empty path or a non-positive limit", async () => {
    expect(await splitAudioAtSilence("", 30_000)).toEqual([]);
    expect(await splitAudioAtSilence("/tmp/voice.ogg", 0)).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns nothing when the source is shorter than the limit", async () => {
    stubTools({ durationSec: "10.0" });
    expect(await splitAudioAtSilence("/tmp/voice.ogg", 30_000)).toEqual([]);
  });

  it("gives up when the duration cannot be measured at all", async () => {
    stubExecFileError("ffprobe missing");
    expect(await splitAudioAtSilence("/tmp/voice.ogg", 30_000)).toEqual([]);
  });
});

describe("cleanupAudioSegments", () => {
  it("removes both the files and the directory holding them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vk-voice-test-"));
    const file = join(dir, "part-000.ogg");
    await writeFile(file, "x");

    await cleanupAudioSegments([file]);

    await expect(stat(dir)).rejects.toThrow();
  });

  it("ignores empty entries and missing files instead of throwing", async () => {
    await expect(
      cleanupAudioSegments(["", "/tmp/vk-voice-does-not-exist/part-000.ogg"]),
    ).resolves.toBeUndefined();
  });
});

describe("selectCutPointsMs — degenerate silence layouts", () => {
  it("advances by the limit when the only candidate would make a zero-length segment", () => {
    // A silence window sitting exactly at the previous cut would otherwise pick
    // the same boundary again and loop forever, producing empty segments.
    const windows = [{ start: 0, end: 0.2 }];
    const cuts = selectCutPointsMs(windows, 60_000, 20_000);

    let prev = 0;
    for (const cut of cuts) {
      expect(cut).toBeGreaterThan(prev);
      expect(cut - prev).toBeLessThanOrEqual(20_000);
      prev = cut;
    }
    expect(cuts.length).toBeGreaterThan(0);
  });

  it("falls back to even cuts when there is no silence at all", () => {
    const cuts = selectCutPointsMs([], 60_000, 20_000);
    // 60s at a 20s limit needs cuts, and the planning margin keeps each segment
    // just under the limit rather than exactly on it.
    expect(cuts.length).toBeGreaterThanOrEqual(2);
    let prev = 0;
    for (const cut of cuts) {
      expect(cut - prev).toBeLessThanOrEqual(20_000);
      prev = cut;
    }
  });

  it("ignores silence found beyond the source duration", () => {
    const cuts = selectCutPointsMs([{ start: 500, end: 501 }], 60_000, 20_000);
    for (const cut of cuts) {
      expect(cut).toBeLessThan(60_000);
    }
  });
});

describe("splitAudioAtSilence — input size ceiling", () => {
  it("refuses a file larger than the configured ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vk-voice-size-"));
    const file = join(dir, "huge.ogg");
    await writeFile(file, "0123456789");
    process.env.VK_AUDIO_SPLIT_MAX_INPUT_BYTES = "5";

    try {
      // A gigabyte recording is not worth opening; the caller falls back to
      // sending the original as a document.
      expect(await splitAudioAtSilence(file, 30_000)).toEqual([]);
      expect(mockExecFile).not.toHaveBeenCalled();
    } finally {
      delete process.env.VK_AUDIO_SPLIT_MAX_INPUT_BYTES;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanupAudioSegments — path safety", () => {
  it("never derives a directory from a bare filename", async () => {
    // `slice(0, -1)` on a name with no separator yields the name minus its last
    // character, and this function removes what it collects recursively.
    const dir = await mkdtemp(join(tmpdir(), "vk-voice-bare-"));
    const sibling = join(dir, "part-00");
    await writeFile(sibling, "x");
    const cwd = process.cwd();

    try {
      process.chdir(dir);
      await cleanupAudioSegments(["part-000"]);
      // The neighbour that a truncated name would have matched is untouched.
      await expect(stat(sibling)).resolves.toBeTruthy();
    } finally {
      process.chdir(cwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
