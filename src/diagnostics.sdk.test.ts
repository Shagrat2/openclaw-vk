import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The same redaction contract as `diagnostics.test.ts`, but through the real
 * `openclaw/plugin-sdk/logging-core` instead of a test double: a double can only
 * promise what the author remembered to write into it. The `openclaw` peer is
 * optional, so this file skips itself where it is not installed and runs in
 * CI's runtime-compatibility job, which installs the host.
 */
// Resolved through Node first and imported only when present: Vite treats a
// missing optional peer as a stub that throws on import, and that failure is
// not a rejection this file could catch — it failed the whole suite in the CI
// job that runs without the host. The specifier is a variable so that Vite's
// import analysis leaves the import to Node.
const LOGGING_CORE = "openclaw/plugin-sdk/logging-core";
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve(LOGGING_CORE);
    return true;
  } catch {
    return false;
  }
})();
const sdk: typeof import("openclaw/plugin-sdk/logging-core") | null = sdkInstalled
  ? await import(/* @vite-ignore */ LOGGING_CORE)
  : null;
// The module under test imports the SDK statically, so it is loaded only once
// the SDK is known to be there — otherwise its own import is what fails.
const diag: typeof import("./diagnostics.js") | null = sdkInstalled
  ? await import("./diagnostics.js")
  : null;

const mockLogger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const mockRuntime = vi.hoisted(() => ({
  config: { current: vi.fn().mockReturnValue({}) },
  logging: { getChildLogger: vi.fn().mockReturnValue(mockLogger) },
}));

vi.mock("./runtime.js", () => ({
  getVkRuntime: () => mockRuntime,
  setVkRuntime: vi.fn(),
  tryGetVkRuntime: () => mockRuntime,
}));

function lastFields(spy: typeof mockLogger.info): Record<string, unknown> {
  const [, fields] = spy.mock.calls.at(-1) ?? [];
  return (fields ?? {}) as Record<string, unknown>;
}

describe.skipIf(!sdk || !diag)("VK diagnostics through the real SDK redactor", () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    delete process.env.VK_DIAG_LEVEL;
  });

  it("hashes identifiers with the core's sha256 prefix", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    diag!.vkDiag("send text", { to: "12324712", peerId: 12324712 });
    const fields = lastFields(mockLogger.info);
    expect(fields.to).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(fields.peerId).toBe(fields.to);
    expect(fields.to).toBe(sdk!.redactIdentifier("12324712"));
  });

  it("keeps the review's two inputs out of a failure logged at off", () => {
    diag!.vkDiagFailure(
      "tts failed",
      Object.assign(new Error("ENOENT: open '/данные/клиент/запись.wav'"), { code: "ENOENT" }),
    );
    diag!.vkDiagFailure("tts failed", new Error("failed to read data:audio/wav;base64,SGVsbG8="));
    const out = JSON.stringify(mockLogger.error.mock.calls.map((call) => call[1]));
    expect(out).not.toContain("данные");
    expect(out).not.toContain("SGVsbG8");
    expect(out).toContain('"errno":"ENOENT"');
  });

  it("strips what the core covers and what it does not from a failure at full", () => {
    // `api_key=…` is the core's; the access token in the query string, the bare
    // VK token and the data URI payload are the plugin's own — the real core
    // leaves all three untouched, which is why the double cannot stand in for it.
    process.env.VK_DIAG_LEVEL = "full";
    diag!.vkDiagFailure(
      "vk upload failed",
      new Error(
        "GET https://api.vk.com/method/photos.save?access_token=vk1.a.SECRET-TOKEN-VALUE&v=5.199 " +
          "with api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789 " +
          "for vk1.a.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 " +
          "after data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      ),
    );
    const reason = String(lastFields(mockLogger.error).reason);
    expect(reason).toContain("https://api.vk.com/method/photos.save?access_token=<redacted>&v=5.199");
    expect(reason).not.toContain("SECRET-TOKEN-VALUE");
    expect(reason).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(reason).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(reason).not.toContain("/9j/4AAQ");
    expect(reason).toContain("data:image/jpeg;base64,<16 chars>");
  });
});
