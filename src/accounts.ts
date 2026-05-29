import {
  DEFAULT_ACCOUNT_ID,
  tryReadSecretFileSync,
} from "openclaw/plugin-sdk/core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  hasConfiguredSecretInput,
  isSecretRef,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { ResolvedVkAccount, VkAccountConfig, VkConfig, CoreConfig } from "./types.js";
export type { ResolvedVkAccount } from "./types.js";

function mergeVkAccountConfig(cfg: CoreConfig, accountId: string): VkAccountConfig {
  const vkConfig = (cfg.channels?.vk ?? {}) as VkConfig;
  const base: VkAccountConfig = {
    name: vkConfig.name,
    enabled: vkConfig.enabled,
    token: vkConfig.token,
    tokenFile: vkConfig.tokenFile,
    dmPolicy: vkConfig.dmPolicy,
    allowFrom: vkConfig.allowFrom,
    defaultTo: vkConfig.defaultTo,
    groupPolicy: vkConfig.groupPolicy,
    groupAllowFrom: vkConfig.groupAllowFrom,
    groups: vkConfig.groups,
  };

  if (accountId !== DEFAULT_ACCOUNT_ID && vkConfig.accounts?.[accountId]) {
    const accountConfig = vkConfig.accounts[accountId];
    return {
      ...base,
      ...accountConfig,
      // Merge groups from base and account
      groups: { ...base.groups, ...accountConfig.groups },
    };
  }

  return base;
}

function logSecretRefNotice(path: string): void {
  if (process.env.OPENCLAW_VK_SECRETREF_WARNED === "1") {
    return;
  }
  process.env.OPENCLAW_VK_SECRETREF_WARNED = "1";
  // eslint-disable-next-line no-console
  console.warn(
    `[vk] ${path} is a SecretRef object — runtime SecretRef resolution is not yet ` +
      "implemented for the VK channel. Falling back to no-token (channel will be skipped). " +
      "Use a plain-string token, VK_TOKEN env, or tokenFile until SecretRef support lands.",
  );
}

function resolveVkToken(
  accountId: string,
  config: VkAccountConfig,
  configPath: string,
): { token: string; source: "env" | "tokenFile" | "config" | "none" } {
  // 1. Environment variable
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envToken = process.env.VK_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  // 2. Token file
  if (config.tokenFile?.trim()) {
    const fileValue = tryReadSecretFileSync(config.tokenFile.trim(), "VK token");
    if (fileValue?.trim()) {
      return { token: fileValue.trim(), source: "tokenFile" };
    }
  }

  // 3. Config value — plain string OR SecretRef
  const tokenValue = config.token;
  const plainToken = normalizeSecretInputString(tokenValue);
  if (plainToken) {
    return { token: plainToken, source: "config" };
  }
  if (isSecretRef(tokenValue)) {
    // SecretRef objects need async resolution via secrets.providers; not wired in
    // the synchronous account-resolution path yet. Warn once per process and fall
    // through so the channel reports as "no token" instead of throwing on .trim().
    logSecretRefNotice(configPath);
  }

  return { token: "", source: "none" };
}

export function resolveVkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedVkAccount {
  const accountId = normalizeAccountId(params.accountId ?? undefined);
  const config = mergeVkAccountConfig(params.cfg, accountId);
  const configPath =
    accountId === DEFAULT_ACCOUNT_ID
      ? "channels.vk.token"
      : `channels.vk.accounts.${accountId}.token`;
  const { token, source } = resolveVkToken(accountId, config, configPath);

  return {
    accountId,
    enabled: config.enabled !== false,
    name: config.name?.trim() || undefined,
    token,
    tokenSource: source,
    config,
  };
}

function hasVkTokenInput(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return hasConfiguredSecretInput(value);
}

export function listVkAccountIds(cfg: CoreConfig): string[] {
  const vkConfig = cfg.channels?.vk as VkConfig | undefined;
  if (!vkConfig) {
    return [];
  }

  const ids: string[] = [];
  // Include default account if top-level token/tokenFile is present
  if (
    hasVkTokenInput(vkConfig.token) ||
    vkConfig.tokenFile?.trim() ||
    process.env.VK_TOKEN?.trim()
  ) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  if (vkConfig.accounts) {
    for (const id of Object.keys(vkConfig.accounts)) {
      if (id !== DEFAULT_ACCOUNT_ID && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }

  // If no accounts found but config section exists, include default
  if (ids.length === 0 && vkConfig) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  return ids;
}

export function resolveDefaultVkAccountId(cfg: CoreConfig): string {
  const ids = listVkAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function listEnabledVkAccounts(cfg: CoreConfig): ResolvedVkAccount[] {
  return listVkAccountIds(cfg)
    .map((accountId) => resolveVkAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
