import { beforeEach, describe, expect, it, vi } from "vitest";

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
  // Ядро отдаёт стабильный `sha256:<12 hex>` — здесь важно лишь то, что
  // значение заменяется и остаётся одинаковым для одного и того же входа.
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
    // Живой случай: ENOENT приносит абсолютный путь прямо в тексте ошибки.
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
    // Не всё в плагине идёт через vkDiag: «сообщение отброшено политикой» —
    // рабочее предупреждение, оно видно всегда, но peer id в нём печатать нельзя.
    process.env.VK_DIAG_LEVEL = "redacted";
    expect(redactVkId(12324712)).not.toContain("12324712");
    expect(redactVkId(undefined)).toBe("-");
    process.env.VK_DIAG_LEVEL = "full";
    expect(redactVkId(12324712)).toBe("12324712");
  });

  it("names the kind of source without naming the source", () => {
    expect(describeVkSourceKind("/srv/media/a.jpg")).toBe("local");
    expect(describeVkSourceKind("https://example.org/a.png")).toBe("remote");
    expect(describeVkSourceKind("data:image/png;base64,AAAA")).toBe("data");
    expect(describeVkSourceKind(Buffer.from("x"))).toBe("buffer");
    expect(describeVkSourceKind(undefined)).toBe("none");
  });
});
