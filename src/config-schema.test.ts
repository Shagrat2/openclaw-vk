import { describe, expect, it, vi } from "vitest";

// ── SDK mock ─────────────────────────────────────────────────────────────────
// Provide real-shaped Zod schemas so VkConfigSchema can be parsed end-to-end.

vi.mock("openclaw/plugin-sdk/channel-config-schema", async () => {
  const { z } = await import("zod");
  return {
    DmPolicySchema: z.enum(["pairing", "allowlist", "open", "disabled"]),
    GroupPolicySchema: z.enum(["allowlist", "open", "disabled"]),
  };
});

import { VkAccountSchema, VkConfigSchema } from "./config-schema.js";

// ── VkAccountSchema ──────────────────────────────────────────────────────────

describe("VkAccountSchema", () => {
  it("accepts the core context visibility modes and rejects anything else", () => {
    for (const mode of ["all", "allowlist", "allowlist_quote"]) {
      expect(VkAccountSchema.safeParse({ contextVisibility: mode }).success).toBe(true);
    }
    expect(VkAccountSchema.safeParse({ contextVisibility: "everyone" }).success).toBe(false);
  });

  it("accepts minimal valid config", () => {
    const result = VkAccountSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts full valid config", () => {
    const result = VkAccountSchema.safeParse({
      name: "My Bot",
      enabled: true,
      token: "vk1.a.xxx",
      tokenFile: "/path/to/token",
      dmPolicy: "pairing",
      allowFrom: [123, "456"],
      defaultTo: "some-target",
      groupPolicy: "open",
      groupAllowFrom: ["*"],
      groups: {
        "2000000001": {
          enabled: true,
          allowFrom: [111],
          requireMention: true,
          systemPrompt: "Be helpful.",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = VkAccountSchema.safeParse({ unknownField: true });
    expect(result.success).toBe(false);
  });

  it("accepts all valid dmPolicy values", () => {
    for (const policy of ["pairing", "allowlist", "open", "disabled"]) {
      const result = VkAccountSchema.safeParse({
        dmPolicy: policy,
        ...(policy === "open" ? { allowFrom: ["*"] } : {}),
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid dmPolicy value", () => {
    const result = VkAccountSchema.safeParse({ dmPolicy: "yolo" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid groupPolicy values", () => {
    for (const policy of ["allowlist", "open", "disabled"]) {
      const result = VkAccountSchema.safeParse({ groupPolicy: policy });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid groupPolicy value", () => {
    const result = VkAccountSchema.safeParse({ groupPolicy: "pairing" });
    expect(result.success).toBe(false);
  });

  it("rejects dmPolicy=open without allowFrom containing '*'", () => {
    const result = VkAccountSchema.safeParse({
      dmPolicy: "open",
      allowFrom: [123],
    });
    expect(result.success).toBe(false);
  });

  it("accepts dmPolicy=open when allowFrom includes '*'", () => {
    const result = VkAccountSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts allowFrom with mixed string and number entries", () => {
    const result = VkAccountSchema.safeParse({
      allowFrom: [123, "456", 789],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid group config fields (strict)", () => {
    const result = VkAccountSchema.safeParse({
      groups: { "2000000001": { bogus: true } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts groups with wildcard key", () => {
    const result = VkAccountSchema.safeParse({
      groups: { "*": { requireMention: false } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with tools policy", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": {
          tools: {
            allow: ["web_search"],
            alsoAllow: ["calculator"],
            deny: ["code_exec"],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with partial tools policy (only allow)", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: { allow: ["web_search"] } },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups with empty tools object", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: {} },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields in tools policy (strict)", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: { customField: true } },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string arrays in tools policy", () => {
    const result = VkAccountSchema.safeParse({
      groups: {
        "2000000001": { tools: { allow: [123] } },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── VkConfigSchema ───────────────────────────────────────────────────────────

describe("VkConfigSchema", () => {
  it("accepts config with accounts section", () => {
    const result = VkConfigSchema.safeParse({
      accounts: {
        sales: { token: "tok", dmPolicy: "allowlist", allowFrom: [1] },
        support: { token: "tok2" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("validates nested account schemas inside accounts", () => {
    const result = VkConfigSchema.safeParse({
      accounts: {
        bad: { dmPolicy: "nope" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects dmPolicy=open at root level without allowFrom '*'", () => {
    const result = VkConfigSchema.safeParse({
      dmPolicy: "open",
    });
    expect(result.success).toBe(false);
  });

  it("accepts dmPolicy=open at root level with allowFrom '*'", () => {
    const result = VkConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty config", () => {
    const result = VkConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // The diagnostics level is read from channels.vk.diagnostics only, for every
  // account. Accepting it under an account would be a setting that silently does
  // nothing — worst when an account asks for "off" and still logs at "full".
  it("accepts the diagnostics level at channel level", () => {
    const result = VkConfigSchema.safeParse({ diagnostics: { level: "full" } });
    expect(result.success).toBe(true);
  });

  it("rejects a diagnostics level under an account", () => {
    const result = VkConfigSchema.safeParse({
      diagnostics: { level: "full" },
      accounts: { work: { token: "tok", diagnostics: { level: "off" } } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("accounts.work");
  });
  // Voice limits are read from channels.vk.audio only (settings.ts), for every
  // account; accepting them under an account would be a setting that does nothing.
  it("accepts audio limits at channel level", () => {
    expect(VkConfigSchema.safeParse({ audio: {} }).success).toBe(true);
  });

  it("rejects audio limits under an account", () => {
    const result = VkConfigSchema.safeParse({ accounts: { work: { token: "tok", audio: {} } } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("accounts.work");
  });

  // The step-progress draft is read from channels.vk.streaming only (inbound.ts).
  it("accepts the progress streaming mode at channel level, with core-owned draft keys", () => {
    const result = VkConfigSchema.safeParse({
      streaming: { mode: "progress", progress: { label: "Working", maxLines: 8 } },
    });
    expect(result.success).toBe(true);
    expect(VkConfigSchema.safeParse({ streaming: { mode: "off" } }).success).toBe(true);
  });

  it("rejects streaming modes VK does not implement", () => {
    for (const mode of ["partial", "block", "preview"]) {
      expect(VkConfigSchema.safeParse({ streaming: { mode } }).success).toBe(false);
    }
  });

  it("rejects streaming under an account", () => {
    const result = VkConfigSchema.safeParse({
      accounts: { work: { token: "tok", streaming: { mode: "progress" } } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("accounts.work");
  });
});

// ── Transport ────────────────────────────────────────────────────────────────

describe("VkAccountSchema transport", () => {
  it("accepts a positive silence threshold", () => {
    const result = VkAccountSchema.safeParse({ transport: { silenceMs: 30_000 } });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive or fractional threshold", () => {
    expect(VkAccountSchema.safeParse({ transport: { silenceMs: 0 } }).success).toBe(false);
    expect(VkAccountSchema.safeParse({ transport: { silenceMs: 1.5 } }).success).toBe(false);
  });

  it("rejects unknown transport fields (strict)", () => {
    const result = VkAccountSchema.safeParse({ transport: { silence: 30_000 } });
    expect(result.success).toBe(false);
  });
});

// ── SecretRef token ──────────────────────────────────────────────────────────

describe("token as a SecretRef", () => {
  const ok = (token: unknown) => VkConfigSchema.safeParse({ token }).success;

  it("accepts a string and every reference source the host resolves", () => {
    expect(ok("vk1.a.xxx")).toBe(true);
    expect(ok({ source: "exec", provider: "openclaw-keychain", id: "vk-group-token" })).toBe(true);
    expect(ok({ source: "env", provider: "default", id: "VK_GROUP_TOKEN" })).toBe(true);
    expect(ok({ source: "store", provider: "default", id: "VK_GROUP_TOKEN" })).toBe(true);
    expect(ok({ source: "file", provider: "secrets-file", id: "/vk/token" })).toBe(true);
  });

  it("rejects a malformed reference the host would reject too", () => {
    expect(ok({ source: "exec" })).toBe(false);
    expect(ok({ source: "vault", provider: "default", id: "X" })).toBe(false);
    expect(ok({ source: "env", provider: "default", id: "lowercase" })).toBe(false);
    expect(ok({ source: "exec", provider: "Bad Provider", id: "x" })).toBe(false);
    expect(ok({ source: "exec", provider: "p", id: "x", extra: true })).toBe(false);
    expect(ok(42)).toBe(false);
  });

  // The review's input: these passed the schema and then threw while the
  // gateway resolved secrets, failing activation instead of isolating VK.
  const BAD_IDS: Array<[string, string]> = [
    ["file", "relative"],
    ["file", "/bad~escape"],
    ["file", ""],
    ["exec", "../token"],
    ["exec", "vault/./key"],
    ["exec", "vault/.."],
    ["exec", ""],
  ];
  const GOOD_IDS: Array<[string, string]> = [
    ["file", "value"],
    ["file", "/vk/token"],
    ["file", "/a~0b/~1c"],
    ["exec", "vault/openai/api-key"],
    ["exec", "aws/secret#json_key"],
    ["exec", "a..b/c.d"],
  ];

  it("rejects file and exec ids outside the host's grammar, at channel and account level", () => {
    for (const [source, id] of BAD_IDS) {
      const token = { source, provider: "p", id };
      expect(ok(token), `${source} ${JSON.stringify(id)}`).toBe(false);
      expect(VkConfigSchema.safeParse({ accounts: { work: { token } } }).success, `${source} ${id}`).toBe(false);
    }
  });

  it("accepts file and exec ids the host resolves", () => {
    for (const [source, id] of GOOD_IDS) {
      expect(ok({ source, provider: "p", id }), `${source} ${id}`).toBe(true);
    }
  });

  it("gives the host's verdict on every id the manifest test runs through the host", () => {
    // The verdicts of the host's `buildSecretInputSchema` (2026.9.7) on the ids
    // in `manifest.sdk.test.ts`, which pins the manifest to the host directly.
    const ids = [
      "relative", "/bad~escape", "", "value", "/vk/token", "/a~0b/~1c", "/", "//",
      "../token", "vault/./key", "vault/..", "./x", "vault/openai/api-key", "aws/secret#json_key",
      "a..b/c.d", "-lead", "a b", `a${"b".repeat(255)}`, `a${"b".repeat(256)}`,
    ];
    const accepted: Record<string, string[]> = {
      file: ["value", "/vk/token", "/a~0b/~1c", "/", "//"],
      exec: ["relative", "value", "vault/openai/api-key", "aws/secret#json_key", "a..b/c.d", `a${"b".repeat(255)}`],
    };
    for (const source of ["file", "exec"]) {
      for (const id of ids) {
        const token = { source, provider: "p", id };
        const expected = accepted[source]!.includes(id);
        expect(ok(token), `${source} ${JSON.stringify(id)}`).toBe(expected);
        expect(VkConfigSchema.safeParse({ accounts: { work: { token } } }).success, `${source} ${id}`).toBe(expected);
      }
    }
  });

  it("accepts a reference in a named account", () => {
    const result = VkConfigSchema.safeParse({
      accounts: { work: { token: { source: "exec", provider: "openclaw-keychain", id: "vk-work" } } },
    });
    expect(result.success).toBe(true);
  });
});
