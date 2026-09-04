import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/setup", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  formatDocsLink: (path: string) => path,
  setSetupChannelEnabled: vi.fn(),
  setTopLevelChannelDmPolicyWithAllowFrom: vi.fn(),
  splitSetupEntries: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  resolveVkAccount: vi.fn(),
}));

vi.mock("./setup-core.js", () => ({
  isVkConfigured: vi.fn(),
  listVkAccountIds: vi.fn(),
  parseVkAllowFromId: vi.fn(),
  patchVkAccountConfig: vi.fn(),
  vkSetupAdapter: {},
}));

import { vkSetupWizard } from "./setup-surface.js";

describe("VK setup wizard help", () => {
  it("lists every scope required for Long Poll and outbound media", () => {
    const intro = vkSetupWizard.introNote as { lines: string[] };
    const credential = vkSetupWizard.credentials?.[0] as { helpLines: string[] };

    for (const scope of ["messages", "manage", "photos", "docs"]) {
      expect(intro.lines.join("\n")).toContain(`${scope}:`);
      expect(credential.helpLines.join("\n")).toContain(`${scope}:`);
    }
  });
});
