import { DmPolicySchema, GroupPolicySchema } from "openclaw/plugin-sdk/channel-config-schema";
import { VK_CONTEXT_VISIBILITY_MODES, VK_DIAG_LEVELS } from "./types.js";
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

// Long-poll transport (`channels.vk.transport`).
const VkTransportSchema = z
  .object({
    /**
     * Silence after which the account task ends and the gateway restarts the
     * channel. A long poll returns within ~25s, so minutes of silence is an
     * anomaly; the gateway's own threshold is half an hour.
     */
    silenceMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

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

// Channel diagnostics (`channels.vk.diagnostics`). A level rather than a
// toggle: "off" is silent, "redacted" logs progress without file names or URLs,
// "full" logs everything. Details and the table live in src/diagnostics.ts.
const VkDiagnosticsSchema = z
  .object({
    // The set of levels is declared once, in types.ts, and parsed in diagnostics.ts.
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
    transport: VkTransportSchema,
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    contextVisibility: z.enum(VK_CONTEXT_VISIBILITY_MODES).optional(),
    groups: z.record(z.string(), VkGroupConfigSchema).optional(),
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
  // Channel-wide only: every account shares one level (see resolveVkDiagLevel).
  diagnostics: VkDiagnosticsSchema,
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
