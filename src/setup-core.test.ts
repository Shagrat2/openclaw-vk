import { afterEach, describe, expect, it, vi } from "vitest";

// ── SDK mocks ────────────────────────────────────────────────────────────────

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

const mockResolveVkAccount = vi.hoisted(() =>
  vi.fn().mockReturnValue({ token: "", tokenSource: "none", config: {} }),
);
vi.mock("./accounts.js", () => ({
  resolveVkAccount: mockResolveVkAccount,
  listVkAccountIds: vi.fn().mockReturnValue(["default"]),
}));

import {
  isVkConfigured,
  parseVkAllowFromId,
  patchVkAccountConfig,
  vkSetupAdapter,
} from "./setup-core.js";

const initialVkToken = process.env.VK_TOKEN;

afterEach(() => {
  if (initialVkToken === undefined) {
    delete process.env.VK_TOKEN;
  } else {
    process.env.VK_TOKEN = initialVkToken;
  }
});

// ── patchVkAccountConfig ─────────────────────────────────────────────────────

describe("patchVkAccountConfig", () => {
  const baseCfg = { channels: { vk: { token: "old-tok" } } };

  it("patches default account at top level", () => {
    const result = patchVkAccountConfig({
      cfg: baseCfg,
      accountId: "default",
      patch: { token: "new-tok" },
    });
    expect((result.channels as Record<string, Record<string, unknown>>).vk.token).toBe("new-tok");
  });

  it("preserves existing fields when patching default account", () => {
    const cfg = { channels: { vk: { token: "tok", dmPolicy: "pairing" } } };
    const result = patchVkAccountConfig({
      cfg,
      accountId: "default",
      patch: { groupPolicy: "open" },
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    expect(vk.token).toBe("tok");
    expect(vk.dmPolicy).toBe("pairing");
    expect(vk.groupPolicy).toBe("open");
  });

  it("clears specified fields for default account", () => {
    const cfg = { channels: { vk: { token: "tok", tokenFile: "/path" } } };
    const result = patchVkAccountConfig({
      cfg,
      accountId: "default",
      patch: {},
      clearFields: ["tokenFile"],
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    expect(vk.tokenFile).toBeUndefined();
    expect(vk.token).toBe("tok");
  });

  it("sets enabled=true when requested for default account", () => {
    const result = patchVkAccountConfig({
      cfg: baseCfg,
      accountId: "default",
      patch: {},
      enabled: true,
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    expect(vk.enabled).toBe(true);
  });

  it("patches named account inside accounts section", () => {
    const cfg = { channels: { vk: { token: "base" } } };
    const result = patchVkAccountConfig({
      cfg,
      accountId: "sales",
      patch: { token: "sales-tok" },
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    const accounts = vk.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.sales.token).toBe("sales-tok");
  });

  it("merges patch with existing named account config", () => {
    const cfg = {
      channels: {
        vk: {
          token: "base",
          accounts: { sales: { token: "old", dmPolicy: "pairing" } },
        },
      },
    };
    const result = patchVkAccountConfig({
      cfg,
      accountId: "sales",
      patch: { token: "new" },
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    const sales = (vk.accounts as Record<string, Record<string, unknown>>).sales;
    expect(sales.token).toBe("new");
    expect(sales.dmPolicy).toBe("pairing");
  });

  it("clears fields in named account", () => {
    const cfg = {
      channels: {
        vk: {
          accounts: { sales: { token: "tok", tokenFile: "/path" } },
        },
      },
    };
    const result = patchVkAccountConfig({
      cfg,
      accountId: "sales",
      patch: {},
      clearFields: ["tokenFile"],
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    const sales = (vk.accounts as Record<string, Record<string, unknown>>).sales;
    expect(sales.tokenFile).toBeUndefined();
  });

  it("sets enabled on both vk and account level for named account", () => {
    const cfg = { channels: { vk: {} } };
    const result = patchVkAccountConfig({
      cfg,
      accountId: "sales",
      patch: { token: "t" },
      enabled: true,
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    expect(vk.enabled).toBe(true);
    const sales = (vk.accounts as Record<string, Record<string, unknown>>).sales;
    expect(sales.enabled).toBe(true);
  });

  it("creates accounts section when patching named account on empty config", () => {
    const result = patchVkAccountConfig({
      cfg: { channels: {} } as never,
      accountId: "sales",
      patch: { token: "new" },
    });
    const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
    expect(vk.accounts).toEqual({
      sales: { token: "new" },
    });
  });
});

// ── isVkConfigured ───────────────────────────────────────────────────────────

describe("isVkConfigured", () => {
  it("returns true when account has a token", () => {
    mockResolveVkAccount.mockReturnValueOnce({ token: "tok", tokenSource: "config", config: {} });
    expect(isVkConfigured({} as never, "default")).toBe(true);
  });

  it("returns false when account has no token", () => {
    mockResolveVkAccount.mockReturnValueOnce({ token: "", tokenSource: "none", config: {} });
    expect(isVkConfigured({} as never, "default")).toBe(false);
  });

  it("returns false when token is whitespace", () => {
    mockResolveVkAccount.mockReturnValueOnce({ token: "   ", tokenSource: "config", config: {} });
    expect(isVkConfigured({} as never, "default")).toBe(false);
  });
});

// ── parseVkAllowFromId ───────────────────────────────────────────────────────

describe("parseVkAllowFromId", () => {
  it("returns numeric ID as-is", () => {
    expect(parseVkAllowFromId("123456")).toBe("123456");
  });

  it("strips vk: prefix", () => {
    expect(parseVkAllowFromId("vk:123456")).toBe("123456");
  });

  it("strips vk:user: prefix", () => {
    expect(parseVkAllowFromId("vk:user:789")).toBe("789");
  });

  it("strips VK: prefix case-insensitively", () => {
    expect(parseVkAllowFromId("VK:USER:111")).toBe("111");
  });

  it("returns null for non-numeric input", () => {
    expect(parseVkAllowFromId("john_doe")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseVkAllowFromId("")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseVkAllowFromId("  42  ")).toBe("42");
  });

  it("returns null for mixed alpha-numeric after prefix strip", () => {
    expect(parseVkAllowFromId("vk:abc123")).toBeNull();
  });
});

// ── vkSetupAdapter ───────────────────────────────────────────────────────────

describe("vkSetupAdapter", () => {
  describe("resolveAccountId", () => {
    it("normalises account ID", () => {
      expect(vkSetupAdapter.resolveAccountId({ accountId: "  sales  " })).toBe("sales");
    });

    it("returns default for empty/undefined", () => {
      expect(vkSetupAdapter.resolveAccountId({ accountId: undefined as never })).toBe("default");
    });
  });

  describe("validateInput", () => {
    it("rejects useEnv for non-default account", () => {
      const err = vkSetupAdapter.validateInput({
        accountId: "sales",
        input: { useEnv: true },
      });
      expect(err).toContain("VK_TOKEN");
    });

    it("rejects empty input without useEnv", () => {
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: {},
      });
      expect(err).toBe("VK requires a community access token (or --use-env).");
    });

    it("rejects a whitespace-only token", () => {
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: { token: "   \t" },
      });
      expect(err).toBe("VK requires a community access token (or --use-env).");
    });

    it("rejects a whitespace-only tokenFile", () => {
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: { tokenFile: "  \n " },
      });
      expect(err).toBe("VK requires a community access token (or --use-env).");
    });

    it("accepts input with token", () => {
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: { token: "tok" },
      });
      expect(err).toBeNull();
    });

    it("accepts input with tokenFile", () => {
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: { tokenFile: "/path" },
      });
      expect(err).toBeNull();
    });

    it("rejects useEnv when VK_TOKEN is absent", () => {
      delete process.env.VK_TOKEN;
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: { useEnv: true },
      });
      expect(err).toBe("VK_TOKEN is not set or is empty. Set it before using --use-env.");
    });

    it("rejects useEnv when VK_TOKEN is empty or whitespace", () => {
      process.env.VK_TOKEN = "   \t";
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: { useEnv: true },
      });
      expect(err).toBe("VK_TOKEN is not set or is empty. Set it before using --use-env.");
    });

    it("accepts useEnv for default account when VK_TOKEN is non-empty", () => {
      process.env.VK_TOKEN = "env-token";
      const err = vkSetupAdapter.validateInput({
        accountId: "default",
        input: { useEnv: true },
      });
      expect(err).toBeNull();
    });
  });

  describe("applyAccountConfig", () => {
    const baseCfg = { channels: { vk: {} } };

    it("applies token for default account", () => {
      const result = vkSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "default",
        input: { token: "new-tok" },
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      expect(vk.token).toBe("new-tok");
      expect(vk.enabled).toBe(true);
    });

    it("applies tokenFile for default account", () => {
      const result = vkSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "default",
        input: { tokenFile: "/path/tok" },
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      expect(vk.tokenFile).toBe("/path/tok");
    });

    it("clears token and tokenFile when useEnv for default account", () => {
      const cfg = { channels: { vk: { token: "old", tokenFile: "/old" } } };
      const result = vkSetupAdapter.applyAccountConfig({
        cfg,
        accountId: "default",
        input: { useEnv: true },
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      expect(vk.token).toBeUndefined();
      expect(vk.tokenFile).toBeUndefined();
    });

    it("applies token for named account", () => {
      const result = vkSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "sales",
        input: { token: "sales-tok" },
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      const sales = (vk.accounts as Record<string, Record<string, unknown>>).sales;
      expect(sales.token).toBe("sales-tok");
      expect(sales.enabled).toBe(true);
    });

    it("keeps default account enabled even when input has no token fields", () => {
      const result = vkSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "default",
        input: {},
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      expect(vk.enabled).toBe(true);
      expect(vk.token).toBeUndefined();
      expect(vk.tokenFile).toBeUndefined();
    });

    it("keeps named account enabled even when input has no token fields", () => {
      const result = vkSetupAdapter.applyAccountConfig({
        cfg: baseCfg,
        accountId: "sales",
        input: {},
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      const sales = (vk.accounts as Record<string, Record<string, unknown>>).sales;
      expect(sales.enabled).toBe(true);
      expect(sales.token).toBeUndefined();
      expect(sales.tokenFile).toBeUndefined();
    });
  });

  describe("applyAccountName", () => {
    it("sets account name", () => {
      const result = vkSetupAdapter.applyAccountName({
        cfg: { channels: { vk: {} } },
        accountId: "default",
        name: "Bot Name",
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      expect(vk.name).toBe("Bot Name");
    });

    it("omits name when blank", () => {
      const result = vkSetupAdapter.applyAccountName({
        cfg: { channels: { vk: {} } },
        accountId: "default",
        name: "   ",
      });
      const vk = (result.channels as Record<string, Record<string, unknown>>).vk;
      expect(vk.name).toBeUndefined();
    });
  });
});
