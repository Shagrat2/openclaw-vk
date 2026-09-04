import { beforeEach, describe, expect, it, vi } from "vitest";

// The `openclaw` peer is optional and absent in CI's unit-test job, so every SDK
// subpath a module under test imports has to be mocked — including the ones it
// reaches transitively, here through `settings.ts`.
vi.mock("openclaw/plugin-sdk/core", () => ({
  parseStrictPositiveInteger: (value: unknown) => {
    const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
    if (!/^\d+$/.test(raw.trim())) return undefined;
    const parsed = Number.parseInt(raw.trim(), 10);
    return parsed > 0 ? parsed : undefined;
  },
}));

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
  redactSensitiveText: (text: string) => text.replace(/vk1\.a\.\S+/g, "[REDACTED]"),
}));

const { describeVkSourceKind, redactVkId, resolveVkDiagLevel, vkDiag, vkDiagFailure } =
  await import("./diagnostics.js");

function lastFields(spy: typeof mockLogger.info): Record<string, unknown> {
  const [, fields] = spy.mock.calls.at(-1) ?? [];
  return (fields ?? {}) as Record<string, unknown>;
}

describe("VK diagnostics levels", () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    mockConfig.current.mockReturnValue({});
    mockTryGetVkRuntime.mockReturnValue(mockRuntime);
    delete process.env.VK_DIAG_LEVEL;
    delete process.env.VK_VOICE_DEBUG_LOG;
  });

  it("says nothing by default", () => {
    expect(resolveVkDiagLevel()).toBe("off");
    vkDiag("send media", { to: "12324712", mediaUrl: "/srv/media/a.jpg" });
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("still reports failures when switched off, and redacts them", () => {
    vkDiagFailure("vk upload failed", Object.assign(new Error("boom"), { code: 100 }), {
      kind: "photo",
      source: "/srv/media/a.jpg",
    });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(lastFields(mockLogger.error)).toEqual({
      kind: "photo",
      source: "local",
      code: 100,
      reason: "boom Error",
    });
  });

  it("keeps a filesystem error from smuggling a path into an off-level log", () => {
    // A real case: ENOENT carries an absolute path inside the error text.
    vkDiagFailure(
      "tts continuation failed",
      new Error("ENOENT: no such file or directory, open '/srv/agent/renders/frame.jpg'"),
    );
    expect(JSON.stringify(lastFields(mockLogger.error))).not.toContain("/srv/agent");
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
    vkDiag("vk upload ok", { source: Buffer.from("jpeg-bytes") });
    expect(lastFields(mockLogger.info)).toEqual({ source: "buffer" });
  });

  it("keeps names at the full level but still strips secrets", () => {
    process.env.VK_DIAG_LEVEL = "full";
    vkDiag("send media", { to: "12324712", mediaUrl: "/srv/media/a.jpg", token: "vk1.a.SECRET" });
    expect(lastFields(mockLogger.info)).toEqual({
      to: "12324712",
      mediaUrl: "/srv/media/a.jpg",
      token: "[REDACTED]",
    });
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

  it("falls back to off on an unknown level instead of leaking", () => {
    process.env.VK_DIAG_LEVEL = "verbose";
    mockConfig.current.mockReturnValue({ channels: { vk: { diagnostics: { level: "loud" } } } });
    expect(resolveVkDiagLevel()).toBe("off");
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

  it("не пропускает имена мимо редактора ни одним из обходных путей", () => {
    // Every case here was found by probing — all of them reached the log as is.
    process.env.VK_DIAG_LEVEL = "redacted";
    vkDiag("probe", {
      windows: "C:\\Users\\ivan\\Secret\\frame.jpg",
      bareFile: "frame-024-secret.jpg",
      nested: { path: "/srv/media/secret.jpg", peerId: 12324712 },
      // peerId as a number: the identifier check used to run after non-strings
      // were returned early, so a numeric id reached the log raw.
      peerId: 12324712,
      failure: new Error("ENOENT: open '/srv/media/secret.jpg'"),
    });
    const f = lastFields(mockLogger.info);
    const rendered = JSON.stringify(f);
    expect(rendered).not.toContain("Secret");
    expect(rendered).not.toContain("frame-024-secret");
    expect(rendered).not.toContain("/srv/media");
    expect(rendered).not.toContain("12324712");
    expect(f.peerId).toBe("sha256:8");
    expect((f.nested as Record<string, unknown>).peerId).toBe("sha256:8");
    // The error message survives — it used to be lost as `{}`.
    expect(String(f.failure)).toContain("ENOENT");
  });

  it("не падает на циклическом МАССИВЕ", () => {
    // The depth guard was only in the object branch, so a self-referencing
    // array recursed forever and took the send down.
    process.env.VK_DIAG_LEVEL = "full";
    const arr: unknown[] = ["x"];
    arr.push(arr);
    expect(() => vkDiag("probe", { arr })).not.toThrow();
  });

  it("не падает на циклической ссылке в поле", () => {
    // JSON.stringify sits on the send path: an exception here would drop the reply.
    process.env.VK_DIAG_LEVEL = "full";
    process.env.VK_VOICE_DEBUG_LOG = "/dev/null";
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    expect(() => vkDiag("probe", { cyclic })).not.toThrow();
    delete process.env.VK_VOICE_DEBUG_LOG;
  });

  it("names the kind of source without naming the source", () => {
    expect(describeVkSourceKind("/srv/media/a.jpg")).toBe("local");
    expect(describeVkSourceKind("https://example.org/a.png")).toBe("remote");
    expect(describeVkSourceKind("data:image/png;base64,AAAA")).toBe("data");
    expect(describeVkSourceKind(Buffer.from("x"))).toBe("buffer");
    expect(describeVkSourceKind(undefined)).toBe("none");
  });
});
