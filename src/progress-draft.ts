import type { ChannelProgressDraftMode, StreamingCompatEntry } from "./sdk-compat.js";
import {
  createChannelProgressDraftCompositor,
  type ChannelProgressDraftCompositor,
} from "openclaw/plugin-sdk/channel-message";
import { deleteMessageVk, editMessageVk, sendMessageVk } from "./send.js";
import type { CoreConfig, ResolvedVkAccount } from "./types.js";

/**
 * VK step-progress draft: keeps a SINGLE bot message and rewrites it in place
 * with the running list of execution steps (🛠️ tool calls, 🔎 web search …),
 * mirroring Telegram's `streaming.mode: "progress"`.
 *
 * The hard part — the delayed-start gate, dedup, truncation and multi-line
 * rendering — lives in the core `createChannelProgressDraftCompositor`
 * (openclaw/plugin-sdk/channel-message). This module only supplies the two
 * VK-specific primitives the compositor drives:
 *   - `update(text)`      → lazily create the draft (messages.send) then edit it
 *                           in place (messages.edit) on every subsequent render;
 *   - `deleteCurrent()`   → drop the draft (messages.delete).
 * It is the exact analogue of reactions-controller.ts, which adapts VK reactions
 * onto the core status-reaction controller.
 */
export type VkProgressDraftParams = {
  /** Normalized VK peer id the draft is sent to. */
  to: string;
  /** Resolved account (used for in-place edit/delete of our own message). */
  account: ResolvedVkAccount;
  /** Account id + config threaded to the first `sendMessageVk` call. */
  accountId?: string;
  cfg?: CoreConfig;
  /** Channel config entry — the compositor reads streaming.preview/labels from it. */
  entry: StreamingCompatEntry | null | undefined;
  /** Resolved streaming mode (progress|block|partial|off); pass "progress". */
  mode: ChannelProgressDraftMode;
  /** Stable per-turn seed so the compositor can distinguish turns. */
  seed: string;
  onError?: (err: unknown) => void;
  /** Optional diagnostic logger — traces draft send/edit/remove to gateway.log. */
  log?: (msg: string) => void;
};

/**
 * Live draft label from `channels.vk.streaming.progress.label`. It marks both
 * the draft and intermediate messages carrying media — its absence is what tells
 * the reader the final answer has arrived.
 */
export function resolveVkProgressLabel(cfg: unknown): string | undefined {
  const label = (
    cfg as
      | { channels?: { vk?: { streaming?: { progress?: { label?: unknown } } } } }
      | undefined
  )?.channels?.vk?.streaming?.progress?.label;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

/**
 * Handle to the single live draft message. Exposed so the deliver/finalize path
 * can rewrite it into the final answer (or delete it) without re-sending.
 */
export type VkProgressDraftHandle = {
  compositor: ChannelProgressDraftCompositor;
  /** message_id of the live draft, or undefined before the first render / after delete. */
  currentMessageId(): number | undefined;
  /** Replace the draft's text in place; falls back to a fresh send if the edit fails. */
  overwrite(text: string): Promise<void>;
  /** Remove the draft message entirely (best-effort). */
  remove(): Promise<void>;
  /**
   * Seal the draft: after this, `overwrite` is a no-op so a late compositor
   * render can never spawn a fresh message once the turn has finalized.
   */
  close(): void;
};

export function createVkProgressDraftCompositor(
  params: VkProgressDraftParams,
): VkProgressDraftHandle {
  // The single "live" message we keep editing. Lazily created on first update.
  let messageId: number | undefined;
  // Once the turn has finalized we stop touching VK, so a straggler compositor
  // render can't create a brand-new message after the answer is delivered.
  let closed = false;

  // The live draft label (`streaming.progress.label`). The core does not add it
  // on any path — verified from a trace: the draft length on tool steps did not
  // change with a label configured. So we add it here, at the single write
  // point, to cover both steps and text chunks. The startsWith check guards
  // against a duplicate when the label was already added above.
  const resolveProgressLabel = (): string | undefined => resolveVkProgressLabel(params.cfg);

  const overwrite = async (rawText: string): Promise<void> => {
    if (closed) {
      return;
    }
    const label = resolveProgressLabel();
    const text =
      label && !rawText.startsWith(label) ? `${label}\n\n${rawText}` : rawText;
    try {
      if (messageId === undefined) {
        const result = await sendMessageVk(params.to, text, {
          cfg: params.cfg,
          accountId: params.accountId,
        });
        const id = Number(result.messageId);
        messageId = Number.isFinite(id) && id > 0 ? id : undefined;
        params.log?.(`vk: step-progress draft sent msgId=${messageId ?? "?"} len=${text.length}`);
        return;
      }
      const ok = await editMessageVk(params.to, messageId, text, params.account);
      params.log?.(`vk: step-progress draft edited msgId=${messageId} ok=${ok} len=${text.length}`);
      if (!ok) {
        // Edit window elapsed or message gone — forget it so the next render
        // starts a fresh draft instead of silently dropping progress.
        messageId = undefined;
      }
    } catch (err) {
      params.onError?.(err);
    }
  };

  const remove = async (): Promise<void> => {
    if (messageId === undefined) {
      return;
    }
    const id = messageId;
    messageId = undefined;
    try {
      await deleteMessageVk(params.to, id, params.account);
      params.log?.(`vk: step-progress draft removed msgId=${id}`);
    } catch (err) {
      params.onError?.(err);
    }
  };

  const compositor = createChannelProgressDraftCompositor({
    entry: params.entry,
    mode: params.mode,
    active: true,
    seed: params.seed,
    update: overwrite,
    deleteCurrent: remove,
  });

  return {
    compositor,
    currentMessageId: () => messageId,
    overwrite,
    remove,
    close: () => {
      closed = true;
    },
  };
}
