import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which token paths the contract hands the core for resolution, whose they are
 * and whether they are active. The core's collector is replaced by a recorder
 * here; `secret-contract.sdk.test.ts` runs the same flow on the real SDK.
 */
type Collected = {
  value: unknown;
  path: string;
  active?: boolean;
  inactiveReason?: string;
  owner?: { ownerId: string; contract: unknown };
  apply: (value: unknown) => void;
};
const collected: Collected[] = [];

vi.mock("openclaw/plugin-sdk/channel-secret-basic-runtime", () => {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  return {
    isRecord,
    hasOwnProperty: (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key),
    getChannelRecord: (config: { channels?: Record<string, unknown> }, key: string) => {
      const channel = config.channels?.[key];
      return isRecord(channel) ? channel : undefined;
    },
    createChannelSecretTargetRegistryEntries: (params: unknown) => [params],
    collectSecretInputAssignment: (params: Collected) => {
      collected.push(params);
    },
  };
});
vi.mock("openclaw/plugin-sdk/account-id", () => ({
  normalizeAccountId: (id?: string) => id?.trim().toLowerCase() || "default",
}));

const contract = await import("./secret-contract.js");
const api = await import("../secret-contract-api.js");

const ref = { source: "exec", provider: "openclaw-keychain", id: "vk-group-token" };
const collect = (vk: unknown, env: NodeJS.ProcessEnv = {}) =>
  contract.collectRuntimeConfigAssignments({ config: { channels: { vk } }, context: { env } as never });

beforeEach(() => {
  collected.length = 0;
});

describe("registry", () => {
  it("covers the channel token and every account token", () => {
    expect(contract.secretTargetRegistryEntries).toEqual([
      { channelKey: "vk", account: ["token"], channel: ["token"] },
    ]);
  });

  it("the entry point the core loads re-exports the same contract", () => {
    expect(api.secretTargetRegistryEntries).toBe(contract.secretTargetRegistryEntries);
    expect(api.collectRuntimeConfigAssignments).toBe(contract.collectRuntimeConfigAssignments);
    expect(api.channelSecrets).toEqual({
      secretTargetRegistryEntries: contract.secretTargetRegistryEntries,
      collectRuntimeConfigAssignments: contract.collectRuntimeConfigAssignments,
    });
  });
});

describe("collector", () => {
  it("collects nothing without a VK channel or a token", () => {
    contract.collectRuntimeConfigAssignments({ config: {}, context: { env: {} } as never });
    collect(undefined);
    collect({ dmPolicy: "open" });
    expect(collected).toEqual([]);
  });

  it("the root token belongs to the default account and the resolved value lands in place", () => {
    const vk: Record<string, unknown> = { token: ref };
    collect(vk);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ value: ref, path: "channels.vk.token", owner: { ownerId: "vk:default" } });
    collected[0].apply("resolved");
    expect(vk.token).toBe("resolved");
  });

  it("named accounts without a token inherit the root one; their own tokens are collected separately", () => {
    const work = { token: ref };
    collect({
      token: { source: "env", provider: "default", id: "VK_ROOT" },
      accounts: { work, spare: {}, off: { enabled: false }, junk: "not-an-object" },
    });

    const root = collected.filter((c) => c.path === "channels.vk.token");
    expect(root.map((c) => c.owner?.ownerId)).toEqual(["vk:default", "vk:spare"]);
    expect(root[0].owner?.contract).toBe(root[1].owner?.contract);

    const own = collected.filter((c) => c.path !== "channels.vk.token");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ path: "channels.vk.accounts.work.token", active: true, owner: { ownerId: "vk:work" } });
    own[0].apply("w");
    expect(work.token).toBe("w");
  });

  it("VK_TOKEN wins for the default account, so the root reference has no default consumer", () => {
    collect({ token: ref }, { VK_TOKEN: "env-token" });
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ path: "channels.vk.token", active: false });
    expect(collected[0].inactiveReason).toContain("VK_TOKEN");

    collected.length = 0;
    collect({ token: ref, accounts: { work: {} } }, { VK_TOKEN: "env-token" });
    expect(collected.map((c) => c.owner?.ownerId)).toEqual(["vk:work"]);
  });

  it("a disabled channel leaves the root inactive unless an account enables itself and inherits it", () => {
    const vk: Record<string, unknown> = { enabled: false, token: ref };
    collect(vk);
    expect(collected[0]).toMatchObject({ path: "channels.vk.token", active: false });
    expect(collected[0].inactiveReason).toContain("disabled");
    collected[0].apply("x");
    expect(vk.token).toBe("x");

    collected.length = 0;
    collect({ enabled: false, token: ref, accounts: { work: { enabled: true } } });
    expect(collected.map((c) => c.owner?.ownerId)).toEqual(["vk:work"]);
  });

  it("a disabled account with its own token is collected as inactive", () => {
    collect({ accounts: { off: { enabled: false, token: ref } } });
    expect(collected[0]).toMatchObject({ path: "channels.vk.accounts.off.token", active: false });
    expect(collected[0].inactiveReason).toContain("disabled");
  });

  it("accounts.default is never read by resolveVkAccount and is not collected", () => {
    collect({ token: "root", accounts: { default: { token: ref } } });
    expect(collected.map((c) => c.path)).toEqual(["channels.vk.token"]);
  });

  it("an unusual account id is written into the path the way the core writes it", () => {
    collect({ accounts: { "1bot": { token: ref }, "a.b": { token: ref } } });
    expect(collected.map((c) => c.path)).toEqual([
      'channels.vk.accounts["1bot"].token',
      'channels.vk.accounts["a.b"].token',
    ]);
  });
});
