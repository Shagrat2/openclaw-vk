import { describe, expect, it, vi } from "vitest";

// ── SDK mock ─────────────────────────────────────────────────────────────────
// Provide real-shaped Zod schemas so VkConfigSchema can be parsed end-to-end.

vi.mock("openclaw/plugin-sdk/channel-config-schema", async () => {
  const { z } = await import("zod");
  return {
    DmPolicySchema: z.enum(["pairing", "allowlist", "open", "disabled"]),
    GroupPolicySchema: z.enum(["allowlist", "open", "disabled"]),
    // The streaming section now comes from the core schema rather than a local
    // copy; the mock mirrors the shape the tests exercise.
    ChannelPreviewStreamingConfigSchema: z
      .object({
        mode: z.enum(["off", "partial", "block", "progress"]).optional(),
        preview: z.object({ toolProgress: z.boolean().optional() }).optional(),
      })
      .strict(),
  };
});

import { VkAccountSchema, VkConfigSchema } from "./config-schema.js";

// ── VkAccountSchema ──────────────────────────────────────────────────────────

describe("VkAccountSchema", () => {
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

  it("accepts streaming.mode=progress (step-progress opt-in)", () => {
    const result = VkAccountSchema.safeParse({ streaming: { mode: "progress" } });
    expect(result.success).toBe(true);
  });

  it("accepts every valid streaming mode", () => {
    for (const mode of ["off", "partial", "block", "progress"]) {
      expect(VkAccountSchema.safeParse({ streaming: { mode } }).success).toBe(true);
    }
  });

  it("rejects an invalid streaming mode", () => {
    const result = VkAccountSchema.safeParse({ streaming: { mode: "turbo" } });
    expect(result.success).toBe(false);
  });

  it("accepts streaming.preview.toolProgress boolean", () => {
    const result = VkAccountSchema.safeParse({
      streaming: { mode: "progress", preview: { toolProgress: true } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-boolean toolProgress", () => {
    const result = VkAccountSchema.safeParse({
      streaming: { preview: { toolProgress: "yes" } },
    });
    expect(result.success).toBe(false);
  });

  it("validates the streaming section against the core schema", () => {
    // The section used to be a local `.passthrough()` copy, which accepted a
    // typo in a streaming key silently. It is the core schema now, so a
    // misspelled key is a config error instead of a setting that does nothing.
    expect(
      VkAccountSchema.safeParse({ streaming: { mode: "progress" } }).success,
    ).toBe(true);
    expect(
      VkAccountSchema.safeParse({ streaming: { moed: "progress" } }).success,
    ).toBe(false);
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
});
