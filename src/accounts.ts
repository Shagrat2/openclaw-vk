import {
  DEFAULT_ACCOUNT_ID,
  tryReadSecretFileSync,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { normalizeAccountId } from "openclaw/plugin-sdk/compat";
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

function resolveVkToken(
  accountId: string,
  config: VkAccountConfig,
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

  // 3. Config value
  if (config.token?.trim()) {
    return { token: config.token.trim(), source: "config" };
  }

  return { token: "", source: "none" };
}

export function resolveVkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedVkAccount {
  const accountId = normalizeAccountId(params.accountId ?? undefined);
  const config = mergeVkAccountConfig(params.cfg, accountId);
  const { token, source } = resolveVkToken(accountId, config);

  return {
    accountId,
    enabled: config.enabled !== false,
    name: config.name?.trim() || undefined,
    token,
    tokenSource: source,
    config,
  };
}

export function listVkAccountIds(cfg: CoreConfig): string[] {
  const vkConfig = cfg.channels?.vk as VkConfig | undefined;
  if (!vkConfig) {
    return [];
  }

  const ids: string[] = [];
  // Include default account if top-level token/tokenFile is present
  if (vkConfig.token?.trim() || vkConfig.tokenFile?.trim() || process.env.VK_TOKEN?.trim()) {
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
