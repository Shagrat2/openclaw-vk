import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The host validates `channels.vk` against `channelConfigs.vk.schema` in
 * `openclaw.plugin.json`, not against the zod schema in `config-schema.ts`, so a
 * key the zod schema rejects is still accepted by `openclaw config validate`
 * unless the manifest says so. This runs the manifest schema through the host's
 * own JSON Schema validator; like `diagnostics.sdk.test.ts`, it skips itself
 * where the optional `openclaw` peer is not installed.
 */
const require = createRequire(import.meta.url);
const Ajv = (() => {
  try {
    const hostRequire = createRequire(require.resolve("openclaw/plugin-sdk/logging-core"));
    const mod = hostRequire("ajv");
    return (mod.default ?? mod) as new (options?: object) => { compile: (schema: object) => (value: unknown) => boolean };
  } catch {
    return null;
  }
})();

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

describe.skipIf(!Ajv)("openclaw.plugin.json channel config schema", () => {
  const validate = Ajv ? new Ajv({ strict: false }).compile(manifest.channelConfigs.vk.schema) : () => false;

  it("accepts the diagnostics level at channel level", () => {
    expect(validate({ token: "tok", diagnostics: { level: "full" } })).toBe(true);
  });

  it("rejects a diagnostics level under an account", () => {
    expect(
      validate({ diagnostics: { level: "full" }, accounts: { work: { token: "tok", diagnostics: { level: "off" } } } }),
    ).toBe(false);
  });

  // `openclaw config validate` reads this schema, so a level it accepts and the
  // runtime then fails closed on reports success while diagnostics stay off.
  it("rejects an unknown diagnostics level", () => {
    expect(validate({ diagnostics: { level: "verbose" } })).toBe(false);
  });

  it("rejects a diagnostics value that is not an object", () => {
    expect(validate({ diagnostics: "oops" })).toBe(false);
  });

  it("rejects an unknown key inside diagnostics", () => {
    expect(validate({ diagnostics: { level: "redacted", extra: true } })).toBe(false);
  });

  it("accepts the voice limits at channel level", () => {
    expect(validate({ token: "tok", audio: { maxVoiceMs: 240_000, maxSegments: 12 } })).toBe(true);
  });

  // The limits are read from `channels.vk.audio` for every account, so an
  // account block would be a setting that silently does nothing.
  it("rejects voice limits under an account", () => {
    expect(validate({ accounts: { work: { token: "tok", audio: { maxSegments: 4 } } } })).toBe(false);
  });

  it("rejects an unknown key inside audio", () => {
    expect(validate({ audio: { maxSegments: 4, maxChunks: 4 } })).toBe(false);
  });

  it("rejects an audio value that is not an object", () => {
    expect(validate({ audio: 240_000 })).toBe(false);
  });

  it("rejects a non-positive or fractional voice limit", () => {
    expect(validate({ audio: { maxSegments: 0 } })).toBe(false);
    expect(validate({ audio: { maxVoiceMs: -1 } })).toBe(false);
    expect(validate({ audio: { splitTimeoutMs: 1.5 } })).toBe(false);
  });

  it("still accepts an ordinary account and keys it does not describe", () => {
    // The root stays open: tightening it would fail existing configs on keys the
    // manifest has never listed.
    expect(validate({ streaming: { mode: "progress" }, accounts: { work: { token: "tok", dmPolicy: "open" } } })).toBe(true);
  });
});
