import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

// ── SDK mocks ────────────────────────────────────────────────────────────────

const mockTryReadSecretFileSync = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/core", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  tryReadSecretFileSync: mockTryReadSecretFileSync,
}));

vi.mock("openclaw/plugin-sdk/compat", () => ({
  normalizeAccountId: (id?: string) => id?.trim() || "default",
}));

import {
  listEnabledVkAccounts,
  listVkAccountIds,
  resolveDefaultVkAccountId,
  resolveVkAccount,
} from "./accounts.js";

// ── Env helpers ──────────────────────────────────────────────────────────────

let savedVkToken: string | undefined;

beforeEach(() => {
  savedVkToken = process.env.VK_TOKEN;
  delete process.env.VK_TOKEN;
  mockTryReadSecretFileSync.mockReset();
});

afterEach(() => {
  if (savedVkToken !== undefined) {
    process.env.VK_TOKEN = savedVkToken;
  } else {
    delete process.env.VK_TOKEN;
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function cfg(vk: Record<string, unknown> = {}): CoreConfig {
  return { channels: { vk } };
}

// ── resolveVkAccount ─────────────────────────────────────────────────────────

describe("resolveVkAccount", () => {
  it("resolves token from config", () => {
    const result = resolveVkAccount({ cfg: cfg({ token: "tok123" }) });
    expect(result.token).toBe("tok123");
    expect(result.tokenSource).toBe("config");
  });

  it("resolves token from VK_TOKEN env for default account", () => {
    process.env.VK_TOKEN = "env-token";
    const result = resolveVkAccount({ cfg: cfg({}) });
    expect(result.token).toBe("env-token");
    expect(result.tokenSource).toBe("env");
  });

  it("does not use VK_TOKEN env for named accounts", () => {
    process.env.VK_TOKEN = "env-token";
    const result = resolveVkAccount({
      cfg: cfg({ accounts: { sales: { token: "sales-tok" } } }),
      accountId: "sales",
    });
    expect(result.token).toBe("sales-tok");
    expect(result.tokenSource).toBe("config");
  });

  it("resolves token from tokenFile", () => {
    mockTryReadSecretFileSync.mockReturnValue("file-token");
    const result = resolveVkAccount({ cfg: cfg({ tokenFile: "/path/to/token" }) });
    expect(result.token).toBe("file-token");
    expect(result.tokenSource).toBe("tokenFile");
  });

  it("prioritises env > tokenFile > config", () => {
    process.env.VK_TOKEN = "env-token";
    mockTryReadSecretFileSync.mockReturnValue("file-token");
    const result = resolveVkAccount({
      cfg: cfg({ tokenFile: "/path", token: "cfg-token" }),
    });
    expect(result.token).toBe("env-token");
    expect(result.tokenSource).toBe("env");
  });

  it("falls back tokenFile > config when no env", () => {
    mockTryReadSecretFileSync.mockReturnValue("file-token");
    const result = resolveVkAccount({
      cfg: cfg({ tokenFile: "/path", token: "cfg-token" }),
    });
    expect(result.token).toBe("file-token");
    expect(result.tokenSource).toBe("tokenFile");
  });

  it("returns empty token and source=none when nothing configured", () => {
    const result = resolveVkAccount({ cfg: cfg({}) });
    expect(result.token).toBe("");
    expect(result.tokenSource).toBe("none");
  });

  it("defaults enabled to true", () => {
    const result = resolveVkAccount({ cfg: cfg({ token: "t" }) });
    expect(result.enabled).toBe(true);
  });

  it("respects enabled=false", () => {
    const result = resolveVkAccount({ cfg: cfg({ token: "t", enabled: false }) });
    expect(result.enabled).toBe(false);
  });

  it("trims name whitespace", () => {
    const result = resolveVkAccount({ cfg: cfg({ token: "t", name: "  My Bot  " }) });
    expect(result.name).toBe("My Bot");
  });

  it("returns undefined for blank name", () => {
    const result = resolveVkAccount({ cfg: cfg({ token: "t", name: "   " }) });
    expect(result.name).toBeUndefined();
  });

  it("merges named account config with base config", () => {
    const result = resolveVkAccount({
      cfg: cfg({
        token: "base-token",
        dmPolicy: "pairing",
        accounts: {
          sales: { token: "sales-token", dmPolicy: "open", allowFrom: ["*"] },
        },
      }),
      accountId: "sales",
    });
    expect(result.token).toBe("sales-token");
    expect(result.config.dmPolicy).toBe("open");
  });

  it("merges groups from base and named account", () => {
    const result = resolveVkAccount({
      cfg: cfg({
        token: "base-token",
        groups: { "*": { requireMention: true } },
        accounts: {
          sales: {
            token: "sales-token",
            groups: { "2000000001": { requireMention: false } },
          },
        },
      }),
      accountId: "sales",
    });
    expect(result.config.groups).toEqual({
      "*": { requireMention: true },
      "2000000001": { requireMention: false },
    });
  });

  it("named account groups override base groups for same key", () => {
    const result = resolveVkAccount({
      cfg: cfg({
        groups: { "*": { requireMention: true } },
        accounts: {
          sales: { token: "t", groups: { "*": { requireMention: false } } },
        },
      }),
      accountId: "sales",
    });
    expect(result.config.groups?.["*"]?.requireMention).toBe(false);
  });

  it("returns base config for default account", () => {
    const result = resolveVkAccount({
      cfg: cfg({ token: "t", dmPolicy: "open" }),
    });
    expect(result.config.dmPolicy).toBe("open");
    expect(result.accountId).toBe("default");
  });

  it("trims token whitespace", () => {
    const result = resolveVkAccount({ cfg: cfg({ token: "  tok  " }) });
    expect(result.token).toBe("tok");
  });

  it("skips blank tokenFile", () => {
    mockTryReadSecretFileSync.mockReturnValue("should-not-use");
    const result = resolveVkAccount({ cfg: cfg({ tokenFile: "   ", token: "cfg" }) });
    expect(result.token).toBe("cfg");
    expect(result.tokenSource).toBe("config");
  });

  it("skips tokenFile when file returns empty content", () => {
    mockTryReadSecretFileSync.mockReturnValue("  ");
    const result = resolveVkAccount({ cfg: cfg({ tokenFile: "/path", token: "cfg" }) });
    expect(result.token).toBe("cfg");
    expect(result.tokenSource).toBe("config");
  });

  it("handles missing channels.vk section gracefully", () => {
    const result = resolveVkAccount({ cfg: {} });
    expect(result.token).toBe("");
    expect(result.tokenSource).toBe("none");
    expect(result.enabled).toBe(true);
  });
});

// ── listVkAccountIds ─────────────────────────────────────────────────────────

describe("listVkAccountIds", () => {
  it("returns empty array when no vk config section", () => {
    expect(listVkAccountIds({})).toEqual([]);
  });

  it("returns default when top-level token present", () => {
    expect(listVkAccountIds(cfg({ token: "tok" }))).toContain("default");
  });

  it("returns default when VK_TOKEN env present", () => {
    process.env.VK_TOKEN = "env-tok";
    expect(listVkAccountIds(cfg({}))).toContain("default");
  });

  it("returns default when tokenFile present", () => {
    expect(listVkAccountIds(cfg({ tokenFile: "/path" }))).toContain("default");
  });

  it("includes named accounts from accounts section", () => {
    const ids = listVkAccountIds(
      cfg({ token: "tok", accounts: { sales: {}, support: {} } }),
    );
    expect(ids).toEqual(expect.arrayContaining(["default", "sales", "support"]));
  });

  it("falls back to default when config section exists but has no tokens", () => {
    const ids = listVkAccountIds(cfg({ dmPolicy: "open" }));
    expect(ids).toEqual(["default"]);
  });

  it("does not duplicate default account ID", () => {
    const ids = listVkAccountIds(cfg({ token: "tok", accounts: { default: {} } }));
    expect(ids.filter((id) => id === "default")).toHaveLength(1);
  });
});

// ── resolveDefaultVkAccountId ────────────────────────────────────────────────

describe("resolveDefaultVkAccountId", () => {
  it("returns first account ID when accounts exist", () => {
    expect(resolveDefaultVkAccountId(cfg({ token: "tok" }))).toBe("default");
  });

  it("returns default when no config", () => {
    expect(resolveDefaultVkAccountId({})).toBe("default");
  });
});

// ── listEnabledVkAccounts ────────────────────────────────────────────────────

describe("listEnabledVkAccounts", () => {
  it("returns only enabled accounts", () => {
    const accounts = listEnabledVkAccounts(
      cfg({
        token: "tok",
        accounts: {
          sales: { token: "s", enabled: true },
          support: { token: "t", enabled: false },
        },
      }),
    );
    const ids = accounts.map((a) => a.accountId);
    expect(ids).toContain("sales");
    expect(ids).not.toContain("support");
  });

  it("includes accounts that default to enabled (no explicit enabled field)", () => {
    const accounts = listEnabledVkAccounts(cfg({ token: "tok" }));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].enabled).toBe(true);
  });

  it("returns empty when all accounts are disabled", () => {
    const accounts = listEnabledVkAccounts(
      cfg({ enabled: false, token: "tok" }),
    );
    expect(accounts).toEqual([]);
  });
});
