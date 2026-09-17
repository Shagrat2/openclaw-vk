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
      vkCode: 100,
      errorName: "Error",
    });
  });

  it("reports the errno-style code of a system error without its text", () => {
    vkDiagFailure(
      "audio read failed",
      Object.assign(new Error(UNICODE_PATH_ERROR), { code: "ENOENT" }),
    );
    expect(lastFields(mockLogger.error)).toEqual({
      vkCode: null,
      errorName: "Error",
      errno: "ENOENT",
    });
  });

  describe("failures at off and redacted carry no free text at all", () => {
    for (const level of ["off", "redacted"] as const) {
      it(`keeps a Unicode path out of a failure at ${level}`, () => {
        process.env.VK_DIAG_LEVEL = level;
        vkDiagFailure("tts failed", new Error(UNICODE_PATH_ERROR));
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        const out = rendered(mockLogger.error);
        expect(out).not.toContain("данные");
        expect(out).not.toContain("запись");
        expect(out).not.toContain("ENOENT: open");
      });

      it(`keeps an embedded data URI out of a failure at ${level}`, () => {
        process.env.VK_DIAG_LEVEL = level;
        vkDiagFailure("tts failed", new Error(EMBEDDED_DATA_URI));
        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        const out = rendered(mockLogger.error);
        expect(out).not.toContain("SGVsbG8");
        expect(out).not.toContain("failed to read");
      });

      it(`keeps the text of a non-Error throw out of a failure at ${level}`, () => {
        process.env.VK_DIAG_LEVEL = level;
        vkDiagFailure("tts failed", UNICODE_PATH_ERROR);
        vkDiagFailure("tts failed", { message: EMBEDDED_DATA_URI, description: "/tmp/x y/файл.ogg" });
        expect(mockLogger.error).toHaveBeenCalledTimes(2);
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

  it("hides numeric identifiers under any id-shaped name, not only the listed ones", () => {
    // VK hands ids out in snake_case (`peer_id`, `from_id`), and a caller may
    // write `userId` or `groupId`. A number is text-free, but a number can still
    // name a person: failures log at `off`, so this is the default level.
    delete process.env.VK_DIAG_LEVEL;
    vkDiagFailure("send failed", Object.assign(new Error("x"), { code: 901 }), {
      peer_id: 2000000001,
      userId: 12324712,
      from_id: 777,
      ownerId: -142153191,
    });
    const out = rendered(mockLogger.error);
    for (const raw of ["2000000001", "12324712", "777", "142153191"]) {
      expect(out).not.toContain(raw);
    }
    // Hashed, not dropped: two sends to different people stay distinguishable.
    expect(lastFields(mockLogger.error)).toMatchObject({
      peer_id: "sha256:10",
      userId: "sha256:8",
      from_id: "sha256:3",
      ownerId: "sha256:10",
      vkCode: 901,
    });
  });

  it("hashes an id-shaped name that arrives as a string too", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("probe", { peer_id: "2000000001", groupId: "239104331" });
    expect(lastFields(mockLogger.info)).toEqual({ peer_id: "sha256:10", groupId: "sha256:9" });
  });

  it("keeps the numeric fields the send path logs", () => {
    // The field set of the vkDiag calls in the voice and media delivery path:
    // none of them may turn into a placeholder below full.
    process.env.VK_DIAG_LEVEL = "redacted";
    const fields = { textLen: 3, media: 1, index: 1, total: 2, bytes: 4096, attempt: 2, segments: 3, measuredMs: 61000, maxMs: 240000 };
    vkDiag("send payload", fields);
    expect(lastFields(mockLogger.info)).toEqual(fields);
  });

  it("keeps counters and replaces any other number below full", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("send voice", {
      textLen: 3,
      index: 1,
      total: 2,
      bytes: 4096,
      attempt: 2,
      measuredMs: 61000,
      maxMs: 240000,
      balance: 12324712,
    });
    expect(lastFields(mockLogger.info)).toEqual({
      textLen: 3,
      index: 1,
      total: 2,
      bytes: 4096,
      attempt: 2,
      measuredMs: 61000,
      maxMs: 240000,
      balance: "<number>",
    });
  });

  it("never writes the bytes of a buffer that arrives serialized", () => {
    // JSON.parse(JSON.stringify(buffer)) is `{ type: "Buffer", data: [...] }`:
    // no longer a Buffer, but still the attachment.
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("inbound", { data: { type: "Buffer", data: [82, 73, 70, 70] } });
    expect(rendered(mockLogger.info)).not.toContain("82");
    expect(lastFields(mockLogger.info)).toEqual({ data: "buffer" });
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

  /** What `full` leaves of a text from its first data URI on. */
  const cut = (rest: string): string => `<data URI cut, ${rest.length} chars>`;

  it("cuts a text at its first data URI at full, and describes one under a source field", () => {
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("send media", {
      inline: "data:audio/wav;base64,SGVsbG8=",
      failure: new Error(EMBEDDED_DATA_URI),
      note: "two: data:image/png;base64,AAAA and data:,plain",
    });
    expect(lastFields(mockLogger.info)).toEqual({
      inline: "data (audio/wav, 8 chars)",
      failure: `Error: failed to read ${cut("data:audio/wav;base64,SGVsbG8=")}`,
      note: `two: ${cut("data:image/png;base64,AAAA and data:,plain")}`,
    });
  });

  describe("a data URI cannot carry its payload out at full, whatever its form", () => {
    // The review's input: a percent-encoded parameter broke the old pattern, and
    // the whole URI, payload included, reached the log.
    const PERCENT_DATA_URI = "data:audio/wav;name=voice%20note.wav;base64,SGVsbG8=";
    // Built from char codes: the escapes themselves are what is being tested,
    // and a literal escape in the source is too easy to get unescaped on the way.
    const backslash = String.fromCharCode(92);
    const tab = String.fromCharCode(9);
    const nbsp = String.fromCharCode(160);
    const esc = String.fromCharCode(27);

    beforeEach(() => {
      process.env.VK_DIAG_LEVEL = "full";
    });

    /** One call, and nothing of `secret` in it — the event name included. */
    const expectOneCallWithout = (spy: typeof mockLogger.info, secret: string): void => {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    };

    it("describes it under a source field and cuts it anywhere else, through vkDiag", () => {
      vkDiag("send media", {
        source: PERCENT_DATA_URI,
        note: PERCENT_DATA_URI,
        failure: new Error(`failed to read ${PERCENT_DATA_URI}`),
        text: `failed to read ${PERCENT_DATA_URI}`,
      });
      expect(lastFields(mockLogger.info)).toEqual({
        source: "data (audio/wav, name=voice%20note.wav, 8 chars)",
        note: cut(PERCENT_DATA_URI),
        failure: `Error: failed to read ${cut(PERCENT_DATA_URI)}`,
        text: `failed to read ${cut(PERCENT_DATA_URI)}`,
      });
    });

    it("cuts it from a failure's text and fields, through vkDiagFailure", () => {
      vkDiagFailure("tts failed", new Error(`failed to read ${PERCENT_DATA_URI}`), {
        inline: PERCENT_DATA_URI,
        note: `retry of ${PERCENT_DATA_URI}`,
      });
      expect(lastFields(mockLogger.error)).toEqual({
        inline: "data (audio/wav, name=voice%20note.wav, 8 chars)",
        note: `retry of ${cut(PERCENT_DATA_URI)}`,
        vkCode: null,
        errorName: "Error",
        reason: `failed to read ${cut(PERCENT_DATA_URI)}`,
      });
    });

    it("describes a source-field URI by what it is, with no type, no name or no comma", () => {
      vkDiag("send media", {
        source: "data:;base64,SGVsbG8=",
        inline: "data:,SGVsbG8=",
        mediaUrl: "data:SGVsbG8=",
      });
      expect(lastFields(mockLogger.info)).toEqual({
        source: "data (8 chars)",
        inline: "data (8 chars)",
        mediaUrl: "data",
      });
    });

    it("shows a source's file name only when it is one, and through the redactors", () => {
      // A parameter is written by whoever built the URI, so it gets what any
      // text at `full` gets, and markup in it is not a file name at all.
      vkDiag("send media", {
        source: "data:text/plain;name=vk1.a.SECRETTOKEN12345;base64,SGVsbG8=",
        inline: "data:image/svg+xml;name=<svg>secret</svg>,x",
      });
      expect(lastFields(mockLogger.info)).toEqual({
        source: "data (text/plain, name=vk1.a.<redacted>, 8 chars)",
        inline: "data (image/svg+xml, 1 chars)",
      });
    });

    it("shows no part of a source's file name that runs past what a name may be", () => {
      vkDiag("send media", {
        source: `data:text/plain;name=${"x".repeat(129)};base64,SGVsbG8=`,
        inline: `data:text/plain;name=${"y".repeat(200)},SGVsbG8=`,
      });
      expect(lastFields(mockLogger.info)).toEqual({
        source: "data (text/plain, 8 chars)",
        inline: "data (text/plain, 8 chars)",
      });
    });

    it("cuts headers the old grammar never knew: spaces, quotes, upper case, no type", () => {
      const headers = [
        "data:audio/wav;name=voice note.wav;base64,SGVsbG8=",
        'data:audio/wav;name="a b";base64,SGVsbG8=',
        "DATA:AUDIO/WAV;BASE64,SGVsbG8=",
        "data:;charset=utf-8;base64,SGVsbG8=",
        "src=data:audio/wav;x=%E2%9C%93,SGVsbG8=",
        "data:;name=voice note.wav;base64,SGVsbG8=",
      ];
      vkDiag("probe", { list: headers.map((uri) => `got ${uri} back`) });
      vkDiagFailure("probe failed", new Error(headers.join(" | ")));
      expectOneCallWithout(mockLogger.info, "SGVsbG8");
      expectOneCallWithout(mockLogger.error, "SGVsbG8");
    });

    it("cuts payloads no pattern could pick out: wrapped, percent-encoded, glued, SVG, long header", () => {
      // Real base64 of binary data carries `+` and `/`; 300 bytes wrap into
      // lines of 76 with a short last one.
      const payload = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256)).toString(
        "base64",
      );
      const wrapped = (payload.match(/.{1,76}/g) ?? []).join("\n");
      const encoded = encodeURIComponent(`data:image/png;base64,${payload}`);
      vkDiag("probe", {
        wrapped: `read data:image/png;base64,${wrapped} failed`,
        proxied: `GET https://proxy.example/?u=${encoded}`,
        glued: `${esc}[32mdata:image/png;base64,${payload}${esc}[0m`,
        svg: "failed: data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><text>secret caption</text></svg>",
        text: "data:text/plain;charset=utf-8,Hello (private note) from Ivan",
        longHeader: `read data:text/plain;name=${"x".repeat(300)},secret%20message`,
      });
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const out = rendered(mockLogger.info);
      for (const piece of payload.match(/.{12}/g) ?? []) {
        expect(out).not.toContain(piece);
      }
      expect(out).not.toContain("secret caption");
      expect(out).not.toContain("private note");
      expect(out).not.toContain("secret%20message");
      expect(lastFields(mockLogger.info).proxied).toBe(`GET https://proxy.example/?u=${cut(encoded)}`);
    });

    it("cuts the rarer spellings: escaped colon or slash, whitespace before the type, untyped headers", () => {
      const inner = "data:image/png;base64,SGVsbG8=";
      const spellings: Record<string, string> = {
        doubleEncoded: `GET https://p.example/?u=${encodeURIComponent(encodeURIComponent(inner))}`,
        htmlEntity: "src=data&#58;text/plain,SGVsbG8= done",
        hexEntity: "src=data&#x3A;text/plain,SGVsbG8= done",
        jsonEscape: `{"src":"data${backslash}u003atext/plain,SGVsbG8="}`,
        jsEscape: `src=data${backslash}x3atext/plain,SGVsbG8= done`,
        // PHP's JSON — and so VK's API — escapes the slash.
        phpSlash: `{"value":"data:text${backslash}/plain;charset=utf-8,SGVsbG8="}`,
        htmlSlash: "src=data:image&#x2F;svg+xml,SGVsbG8= done",
        percentSlash: "src=data:image%2Fsvg+xml,SGVsbG8= done",
        spacedType: "read data: text/plain,SGVsbG8= done",
        tabbedType: `read data:${tab}text/plain,SGVsbG8= done`,
        nbspType: `read data:${nbsp}text/plain,SGVsbG8= done`,
        customType: "read data:x-custom/y;name=a b,SGVsbG8= done",
        untypedSpaced: "read data:;name=voice note.txt,SGVsbG8= done",
        untypedLong: `read data:;name=${"x".repeat(300)},SGVsbG8= done`,
        untypedEmpty: "read data:,SGVsbG8= done",
        // A text already cut short before it got here: only the marker is left.
        fragment: "tail of an upload: …png;base64,SGVsbG8= done",
      };
      vkDiag("probe", spellings);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const fields = lastFields(mockLogger.info);
      for (const key of Object.keys(spellings)) {
        // Each is cut, not merely missing the payload by luck of another rule.
        expect(fields[key], key).toMatch(/<data URI cut, \d+ chars>$/);
        expect(String(fields[key]), key).not.toContain("SGVsbG8");
      }
    });

    it("leaves prose that merely mentions data alone, and keeps the text before a URI", () => {
      const prose = {
        plain: "Invalid data: expected number, got string",
        meta: "metadata: missing, retrying",
        metaTight: "metadata:missing,retrying",
        metaType: "metadata: image/jpeg, 1024 bytes",
        io: "Failed to read data: I/O error",
        na: "last data: n/a, retrying",
        andOr: "no data: and/or attachment",
        state: "state={data:1,size:2} failed",
        stamp: "last data:2026-09-15T10:00:00Z, next try",
      };
      vkDiag("probe", {
        ...prose,
        json: '{"code":913,"field":"attachment","src":"data:image/png;base64,AAAA"}',
        quoted: "read 'data:audio/wav;base64,SGVsbG8=': ENOENT",
      });
      expect(lastFields(mockLogger.info)).toEqual({
        ...prose,
        json: `{"code":913,"field":"attachment","src":"${cut('data:image/png;base64,AAAA"}')}`,
        quoted: `read '${cut("data:audio/wav;base64,SGVsbG8=': ENOENT")}`,
      });
    });

    it("keeps its cut mark past the length cap, and looks no further than the cap needs", () => {
      const before = "x".repeat(2_100);
      const uri = "data:image/png;base64,SGVsbG8=";
      vkDiag("probe", {
        pastCap: `${before} ${uri}`,
        beyondScan: `${"y".repeat(5_000)} ${uri}`,
      });
      const fields = lastFields(mockLogger.info);
      expect(fields.pastCap).toBe(`${before.slice(0, 2_000)}…${cut(uri)}`);
      // A URI past what can reach the log is dropped with the rest of the text.
      expect(fields.beyondScan).toBe(`${"y".repeat(2_000)}…`);
    });

    it("never shows a secret cut in half by the edge of what is looked at", () => {
      // The token at the edge of the 2,000 + 2,048 characters looked at is cut
      // to `vk1.a.ZZZ` — too short for any pattern to know it. Thirty tokens
      // before it shrink to `vk1.a.<redacted>`, and the text shrinks so much that
      // only the part within the margin, where the cut token sits, would be left;
      // the margin is never shown, so nothing is.
      const token = (c: string): string => `vk1.a.${c.repeat(80)}`;
      const filler = Array.from({ length: 30 }, () => token("A")).join(" ");
      const edge = 2_000 + 2_048;
      const pad = "p".repeat(edge - 9 - filler.length - 1);
      vkDiag("probe", { note: `${filler} ${pad}${token("Z")}` });
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const note = String(lastFields(mockLogger.info).note);
      expect(note).not.toContain("ZZZ");
      expect(note).toBe("…");
    });

    it.each(["redacted", "full"] as const)("cuts a data URI out of nested keys and the event name at %s", (level) => {
      process.env.VK_DIAG_LEVEL = level;
      const uri = "data:image/png;base64,SGVsbG8=";
      vkDiag(`send ${uri} failed`, { byUri: { [uri]: "failed" } });
      vkDiagFailure(`read ${uri} failed`, new Error("boom"), { byUri: { [uri]: 1 } });
      expectOneCallWithout(mockLogger.info, "SGVsbG8");
      expectOneCallWithout(mockLogger.error, "SGVsbG8");
    });

    it("keeps nested keys and event names below full to names that look like code", () => {
      process.env.VK_DIAG_LEVEL = "redacted";
      vkDiag("send", { byPath: { "/Users/ivan/клиент/запись.wav": "failed", ok: 1 }, byPeer: { "12324712": 1 } });
      vkDiagFailure("read /Users/ivan/private.jpg failed", new Error("boom"));
      expect(mockLogger.info.mock.calls[0]?.[0]).toBe("send");
      expect(lastFields(mockLogger.info)).toEqual({
        // A number under a name that does not say "counter" is replaced like text.
        byPath: { "<key>": "<text>", ok: "<number>" },
        byPeer: { "<key>": "<number>" },
      });
      expect(mockLogger.error.mock.calls[0]?.[0]).toBe("<event>");
    });

    it("keeps keys that come out the same apart, even past a key already named like a copy", () => {
      const mark = cut("data:image/png;base64,AAAA");
      vkDiag("probe", {
        byUri: {
          [`${mark} #2`]: "literal",
          "data:image/png;base64,AAAA": "ok",
          "data:image/png;base64,BBBB": "failed",
        },
      });
      expect(lastFields(mockLogger.info).byUri).toEqual({
        [`${mark} #2`]: "literal",
        [mark]: "ok",
        [`${mark} #3`]: "failed",
      });
    });

    it("stays linear on text full of data:, and on megabytes in a text, a key, an event and a source", () => {
      const flood = `read ${"data:".repeat(40_000)}`;
      const huge = `read ${"z".repeat(5_000_000)} data:image/png;base64,SGVsbG8=`;
      const startedAt = performance.now();
      vkDiag(`probe ${"e".repeat(5_000_000)}`, {
        flood,
        huge,
        nested: { [`data:${"a".repeat(5_000_000)}`]: 1 },
        inline: `data:${";x".repeat(2_500_000)},a`,
      });
      vkDiagFailure("probe failed", new Error(flood));
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });

    it("cuts a long payload before the length cap, so no prefix of it survives", () => {
      const uri = `data:audio/wav;name=voice%20note.wav;base64,${"QUJD".repeat(2_000)}`;
      vkDiag("probe", { note: `failed to read ${uri}` });
      expect(lastFields(mockLogger.info).note).toBe(`failed to read ${cut(uri)}`);
    });
  });

  it("keeps a failure's text at full up to its data URI, with secrets redacted", () => {
    process.env.VK_DIAG_LEVEL = "full";
    vkDiagFailure(
      "vk upload failed",
      Object.assign(new Error(`token vk1.a.SECRETVALUE0123 ${EMBEDDED_DATA_URI}`), { code: 100 }),
      { mediaUrl: "/srv/media/a.jpg" },
    );
    expect(lastFields(mockLogger.error)).toEqual({
      mediaUrl: "/srv/media/a.jpg",
      vkCode: 100,
      errorName: "Error",
      reason: `token vk1.a.<redacted> failed to read ${cut("data:audio/wav;base64,SGVsbG8=")}`,
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
      failure: { errorName: "Error", vkCode: null },
      flag: true,
      nothing: null,
      fn: "[function]",
      big: "<number>",
      seen: "[Set, 2]",
    });
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("probe", { big: 10n, balance: 7 });
    expect(lastFields(mockLogger.info)).toEqual({ big: "10", balance: 7 });
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
