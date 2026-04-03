import {
  collapseBlankLinesBeforeVkCodeFences,
  createVkMarkdownPipeline,
  markdownToVk,
  trimVkFormattedMessage,
} from "markdown-to-vk";
import type { VkFormattedMessage } from "markdown-to-vk";

export type {
  VkFormatData,
  VkFormattedMessage,
  VkFormatItem,
  VkFormatType,
} from "markdown-to-vk";

export {
  collapseBlankLinesBeforeVkCodeFences,
  createVkMarkdownPipeline,
  markdownToVk,
  trimVkFormattedMessage,
};

export function renderVkMarkdown(markdown: string): VkFormattedMessage {
  const rendered = markdownToVk(markdown ?? "");
  return rendered.items.length === 0
    ? { text: rendered.text }
    : {
        text: rendered.text,
        formatData: {
          version: 1,
          items: rendered.items,
        },
      };
}
