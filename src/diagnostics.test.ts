import { beforeEach, describe, expect, it, vi } from "vitest";

// The `openclaw` peer is optional and absent in CI's unit-test job, so every SDK
// subpath the module imports is mocked here. `diagnostics.sdk.test.ts` runs the
// same contract against the real redactor wherever the peer is installed.

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({ current: vi.fn().mockReturnValue({}) }));

const mockRuntime = vi.hoisted(() => ({
  config: mockConfig,
  logging: { getChildLogger: vi.fn().mockReturnValue(mockLogger) },
}));

const mockTryGetVkRuntime = vi.hoisted(() => vi.fn().mockReturnValue(mockRuntime));

vi.mock("./runtime.js", () => ({
  getVkRuntime: mockTryGetVkRuntime,
  setVkRuntime: vi.fn(),
  tryGetVkRuntime: mockTryGetVkRuntime,
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  // The core returns a stable `sha256:<12 hex>` — all that matters here is that
  // the value is replaced and stays the same for the same input.
  redactIdentifier: (value?: string) => `sha256:${String(value ?? "-").length}`,
  // Deliberately a pass-through. The previous double redacted `vk1.a.…` tokens,
  // which the real core does not do, so the tests were promising a guarantee
  // the SDK never gave. Everything asserted here is the plugin's own doing;
  // `diagnostics.sdk.test.ts` covers what the core adds on top.
  redactSensitiveText: (text: string) => text,
}));

const { describeVkSourceKind, redactVkId, resolveVkDiagLevel, vkDiag, vkDiagFailure } =
  await import("./diagnostics.js");

function lastFields(spy: typeof mockLogger.info): Record<string, unknown> {
  const [, fields] = spy.mock.calls.at(-1) ?? [];
  return (fields ?? {}) as Record<string, unknown>;
}

function rendered(spy: typeof mockLogger.info): string {
  return JSON.stringify(lastFields(spy));
}

// The two inputs from the review that the previous, pattern-based scrubber let
// through untouched: a Unicode path inside a filesystem error, and a data URI
// embedded in a message.
const UNICODE_PATH_ERROR = "ENOENT: open '/данные/клиент/запись.wav'";
const EMBEDDED_DATA_URI = "failed to read data:audio/wav;base64,SGVsbG8=";

describe("VK diagnostics levels", () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    mockConfig.current.mockReturnValue({});
    mockTryGetVkRuntime.mockReturnValue(mockRuntime);
    delete process.env.VK_DIAG_LEVEL;
  });

  it("says nothing by default", () => {
    expect(resolveVkDiagLevel()).toBe("off");
    vkDiag("send media", { to: "12324712", mediaUrl: "/srv/media/a.jpg" });
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("still reports failures when switched off, by class and code only", () => {
    vkDiagFailure("vk upload failed", Object.assign(new Error("boom"), { code: 100 }), {
      kind: "photo",
      source: "/srv/media/a.jpg",
    });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(lastFields(mockLogger.error)).toEqual({
      kind: "photo",
      source: "local",
      code: 100,
      errorName: "Error",
    });
  });

  it("reports the errno-style code of a system error without its text", () => {
    vkDiagFailure(
      "audio read failed",
      Object.assign(new Error(UNICODE_PATH_ERROR), { code: "ENOENT" }),
    );
    expect(lastFields(mockLogger.error)).toEqual({
      code: null,
      errorName: "Error",
      errno: "ENOENT",
    });
  });

  describe("failures at off and redacted carry no free text at all", () => {
    for (const level of ["off", "redacted"] as const) {
      it(`keeps a Unicode path out of a failure at ${level}`, () => {
        process.env.VK_DIAG_LEVEL = level;
        vkDiagFailure("tts failed", new Error(UNICODE_PATH_ERROR));
        const out = rendered(mockLogger.error);
        expect(out).not.toContain("данные");
        expect(out).not.toContain("запись");
        expect(out).not.toContain("ENOENT: open");
      });

      it(`keeps an embedded data URI out of a failure at ${level}`, () => {
        process.env.VK_DIAG_LEVEL = level;
        vkDiagFailure("tts failed", new Error(EMBEDDED_DATA_URI));
        const out = rendered(mockLogger.error);
        expect(out).not.toContain("SGVsbG8");
        expect(out).not.toContain("failed to read");
      });

      it(`keeps the text of a non-Error throw out of a failure at ${level}`, () => {
        process.env.VK_DIAG_LEVEL = level;
        vkDiagFailure("tts failed", UNICODE_PATH_ERROR);
        vkDiagFailure("tts failed", { message: EMBEDDED_DATA_URI, description: "/tmp/x y/файл.ogg" });
        for (const call of mockLogger.error.mock.calls) {
          const out = JSON.stringify(call[1]);
          expect(out).not.toContain("данные");
          expect(out).not.toContain("SGVsbG8");
          expect(out).not.toContain("файл");
        }
      });
    }
  });

  it("replaces names with their source kind at the redacted level", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("send media", {
      to: "12324712",
      mediaUrl: "/srv/media/a.jpg",
      remote: "https://cdn.example.org/a.jpg",
      inline: "data:image/png;base64,AAAA",
      textLen: 3,
    });
    expect(lastFields(mockLogger.info)).toEqual({
      to: "sha256:8",
      mediaUrl: "local",
      remote: "remote",
      inline: "data",
      textLen: 3,
    });
  });

  it("turns any string that is not an identifier, a token or a source into a placeholder", () => {
    // Paths in every shape the previous scrubber missed: Unicode, spaces,
    // relative, Windows, UNC, a bare file name, and a URL that does not start
    // the string. None of them are recognised — they never have to be, because
    // free text under a non-allowlisted field is not logged at all.
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("probe", {
      unicode: "/данные/клиент/запись.wav",
      spaced: "/Users/ivan/My Files/frame 24.jpg",
      relative: "renders/frame-024.jpg",
      windows: "C:\\Users\\ivan\\Secret\\frame.jpg",
      unc: "\\\\nas\\share\\frame.jpg",
      bareFile: "frame-024-secret.jpg",
      sentence: "see https://cdn.example.org/a.jpg?sig=abc for details",
      reason: UNICODE_PATH_ERROR,
    });
    expect(lastFields(mockLogger.info)).toEqual({
      unicode: "<text>",
      spaced: "<text>",
      relative: "<text>",
      windows: "<text>",
      unc: "<text>",
      bareFile: "<text>",
      sentence: "<text>",
      reason: "<text>",
    });
  });

  it("keeps a token only under an allowlisted field, and only when it looks like one", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("probe", {
      kind: "photo",
      mime: "audio/ogg",
      stage: "upload",
      kindAsPath: "/srv/x.jpg",
      kindWithPath: "photo /srv/x.jpg",
      label: "photo",
    });
    expect(lastFields(mockLogger.info)).toEqual({
      kind: "photo",
      mime: "audio/ogg",
      stage: "upload",
      kindAsPath: "<text>",
      kindWithPath: "<text>",
      label: "<text>",
    });
    vkDiag("probe", { kind: "/srv/x.jpg", mime: "../secret/a.jpg" });
    expect(lastFields(mockLogger.info)).toEqual({ kind: "<text>", mime: "<text>" });
  });

  it("hashes identifiers so two failures stay distinguishable without naming anyone", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("send text", { to: "111" });
    const first = lastFields(mockLogger.info).to;
    vkDiag("send text", { to: "111" });
    expect(lastFields(mockLogger.info).to).toBe(first);
    expect(String(first)).not.toContain("111");
  });

  it("never writes attachment contents, at any level", () => {
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("vk upload ok", {
      source: Buffer.from("jpeg-bytes"),
      view: new Uint8Array([1, 2, 3]),
      raw: new ArrayBuffer(4),
    });
    expect(lastFields(mockLogger.info)).toEqual({ source: "buffer", view: "buffer", raw: "buffer" });
  });

  it("replaces a data URI payload by its length at full, standalone and embedded", () => {
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("send media", {
      inline: "data:audio/wav;base64,SGVsbG8=",
      failure: new Error(EMBEDDED_DATA_URI),
      note: "two: data:image/png;base64,AAAA and data:,plain",
    });
    expect(lastFields(mockLogger.info)).toEqual({
      inline: "data:audio/wav;base64,<8 chars>",
      failure: "Error: failed to read data:audio/wav;base64,<8 chars>",
      note: "two: data:image/png;base64,<4 chars> and data:,<5 chars>",
    });
    expect(rendered(mockLogger.info)).not.toContain("SGVsbG8");
  });

  it("keeps a failure's text at full, with the payload stripped and secrets redacted", () => {
    process.env.VK_DIAG_LEVEL = "full";
    vkDiagFailure(
      "vk upload failed",
      Object.assign(new Error(`${EMBEDDED_DATA_URI} token vk1.a.SECRETVALUE0123`), { code: 100 }),
      { mediaUrl: "/srv/media/a.jpg" },
    );
    expect(lastFields(mockLogger.error)).toEqual({
      mediaUrl: "/srv/media/a.jpg",
      code: 100,
      errorName: "Error",
      reason: "failed to read data:audio/wav;base64,<8 chars> token vk1.a.<redacted>",
    });
  });

  it("keeps names at the full level but still strips VK credentials", () => {
    // The core's redactor does not know VK tokens or credentials in a query
    // string (checked against the real SDK, not assumed), so this is ours.
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("send media", {
      to: "12324712",
      mediaUrl: "/srv/media/a.jpg",
      token: "vk1.a.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      url: "https://api.vk.com/method/photos.save?access_token=vk1.a.SECRET-TOKEN-VALUE&v=5.199",
      signed: "https://cdn.example.org/a.jpg?expires=1750000000&sig=abc",
    });
    expect(lastFields(mockLogger.info)).toEqual({
      to: "12324712",
      mediaUrl: "/srv/media/a.jpg",
      token: "vk1.a.<redacted>",
      url: "https://api.vk.com/method/photos.save?access_token=<redacted>&v=5.199",
      signed: "https://cdn.example.org/a.jpg?expires=1750000000&sig=abc",
    });
  });

  it("caps a text field at full so a log line cannot carry a document away", () => {
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("probe", { body: "x".repeat(5_000) });
    expect(String(lastFields(mockLogger.info).body).length).toBeLessThan(2_100);
  });

  it("reads the level from the channel config", () => {
    mockConfig.current.mockReturnValue({ channels: { vk: { diagnostics: { level: "redacted" } } } });
    expect(resolveVkDiagLevel()).toBe("redacted");
  });

  it("lets the environment override the configured level", () => {
    mockConfig.current.mockReturnValue({ channels: { vk: { diagnostics: { level: "redacted" } } } });
    process.env.VK_DIAG_LEVEL = "full";
    expect(resolveVkDiagLevel()).toBe("full");
  });

  it("falls back to off on an unknown configured level instead of leaking", () => {
    mockConfig.current.mockReturnValue({ channels: { vk: { diagnostics: { level: "loud" } } } });
    expect(resolveVkDiagLevel()).toBe("off");
  });

  it("fails closed on an unknown environment value even when the config says full", () => {
    // A typo in the override used to fall through to the configured level —
    // the one place where a mistake could widen what is logged.
    mockConfig.current.mockReturnValue({ channels: { vk: { diagnostics: { level: "full" } } } });
    process.env.VK_DIAG_LEVEL = "verbose";
    expect(resolveVkDiagLevel()).toBe("off");
    vkDiag("send media", { mediaUrl: "/srv/media/a.jpg" });
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("treats an empty environment value as unset", () => {
    mockConfig.current.mockReturnValue({ channels: { vk: { diagnostics: { level: "redacted" } } } });
    process.env.VK_DIAG_LEVEL = "  ";
    expect(resolveVkDiagLevel()).toBe("redacted");
  });

  it("never throws when the plugin runtime is not registered yet", () => {
    mockTryGetVkRuntime.mockReturnValue(null);
    process.env.VK_DIAG_LEVEL = "full";
    expect(() => vkDiag("send media", { textLen: 1 })).not.toThrow();
    expect(() => vkDiagFailure("vk upload failed", new Error("boom"))).not.toThrow();
  });

  it("hides identifiers in plain operational log lines too", () => {
    // Not everything goes through vkDiag: "message dropped by policy" is an
    // operational warning, always visible, but its peer id must not be printed.
    process.env.VK_DIAG_LEVEL = "redacted";
    expect(redactVkId(12324712)).not.toContain("12324712");
    expect(redactVkId(undefined)).toBe("-");
    process.env.VK_DIAG_LEVEL = "full";
    expect(redactVkId(12324712)).toBe("12324712");
  });

  it("redacts nested objects, arrays and numeric identifiers the same way", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("probe", {
      nested: { path: "/srv/media/secret.jpg", peerId: 12324712, note: "x" },
      list: ["/srv/a.jpg", { mediaUrl: "https://cdn.example.org/a.jpg" }],
      peerId: 12324712,
      failure: new Error("ENOENT: open '/srv/media/secret.jpg'"),
      flag: true,
      nothing: null,
      fn: () => 1,
      big: 10n,
      seen: new Set([1, 2]),
    });
    expect(lastFields(mockLogger.info)).toEqual({
      nested: { path: "local", peerId: "sha256:8", note: "<text>" },
      list: ["<text>", { mediaUrl: "remote" }],
      peerId: "sha256:8",
      failure: { errorName: "Error", code: null },
      flag: true,
      nothing: null,
      fn: "[function]",
      big: "10",
      seen: "[Set, 2]",
    });
  });

  it("does not throw on a cyclic array", () => {
    // The depth guard was only in the object branch, so a self-referencing
    // array recursed forever and took the send down.
    process.env.VK_DIAG_LEVEL = "full";
    const arr: unknown[] = ["x"];
    arr.push(arr);
    expect(() => vkDiag("probe", { arr })).not.toThrow();
  });

  it("does not throw on a cyclic object", () => {
    process.env.VK_DIAG_LEVEL = "full";
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(() => vkDiag("probe", { cyclic })).not.toThrow();
    expect(rendered(mockLogger.info)).toContain("deeper than 4 levels");
  });

  it("names the kind of source without naming the source", () => {
    expect(describeVkSourceKind("/srv/media/a.jpg")).toBe("local");
    expect(describeVkSourceKind("https://example.org/a.png")).toBe("remote");
    expect(describeVkSourceKind("data:image/png;base64,AAAA")).toBe("data");
    expect(describeVkSourceKind(Buffer.from("x"))).toBe("buffer");
    expect(describeVkSourceKind(undefined)).toBe("none");
  });
});
