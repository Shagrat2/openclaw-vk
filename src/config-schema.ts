import {
  ChannelPreviewStreamingConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { VK_DIAG_LEVELS } from "./types.js";
import { z } from "zod";

function requireOpenAllowFrom(params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}): void {
  if (params.policy === "open" && !params.allowFrom?.map(String).includes("*")) {
    params.ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: params.path,
      message: params.message,
    });
  }
}

const OPEN_DM_POLICY_ALLOW_FROM_ERROR =
  'channels.vk.dmPolicy="open" requires channels.vk.allowFrom to include "*"';

const VkGroupToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const VkGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    tools: VkGroupToolPolicySchema,
  })
  .strict()
  .optional();

// Live progress streaming (`channels.vk.streaming`). The core owns the semantics
// and full validation. The core exports the real schema, so we use it: our own
// copy was `.passthrough()` and therefore accepted a typo in `progress.label`
// or `maxLines` silently, while the core schema is strict and validates exactly
// the fields the step-progress feature reads.
const VkStreamingSchema = ChannelPreviewStreamingConfigSchema.optional();

// Channel diagnostics (`channels.vk.diagnostics`). A level rather than a
// toggle: "off" is silent, "redacted" logs progress without file names or URLs,
// "full" logs everything. Details and the table live in src/diagnostics.ts.
const VkDiagnosticsSchema = z
  .object({
    // The set of levels is declared once, in diagnostics.ts, where it is parsed.
    level: z.enum(VK_DIAG_LEVELS).optional(),
  })
  .strict()
  .optional();

const VkAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), VkGroupConfigSchema).optional(),
    streaming: VkStreamingSchema,
    diagnostics: VkDiagnosticsSchema,
  })
  .strict();

export const VkAccountSchema = VkAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: OPEN_DM_POLICY_ALLOW_FROM_ERROR,
  });
});

export const VkConfigSchema = VkAccountSchemaBase.extend({
  accounts: z.record(z.string(), VkAccountSchema).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: OPEN_DM_POLICY_ALLOW_FROM_ERROR,
  });
});
