export type VkFormatType = "bold" | "italic" | "underline" | "url";

export type VkFormatItem = {
  type: VkFormatType;
  offset: number;
  length: number;
  url?: string;
};

export type VkFormatData = {
  version: 1;
  items: VkFormatItem[];
};

export type VkFormattedMessage = {
  text: string;
  formatData?: VkFormatData;
};

export function collapseBlankLinesBeforeVkCodeFences(text: string): string {
  if (!text) {
    return "";
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const normalized: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const isFence = trimmed.startsWith("```");

    if (isFence && !inFence) {
      while (normalized.length > 0 && normalized[normalized.length - 1].trim() === "") {
        normalized.pop();
      }
      normalized.push(line);
      inFence = true;
      continue;
    }

    normalized.push(line);

    if (isFence && inFence) {
      inFence = false;
    }
  }

  return normalized.join("\n");
}

function mergeFormatItems(items: VkFormatItem[]): VkFormatItem[] {
  if (items.length === 0) {
    return items;
  }
  const sorted = items
    .filter((item) => item.length > 0)
    .slice()
    .sort((a, b) => (a.offset === b.offset ? a.type.localeCompare(b.type) : a.offset - b.offset));
  const merged: VkFormatItem[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.type === item.type &&
      (last.url ?? "") === (item.url ?? "") &&
      last.offset + last.length === item.offset
    ) {
      last.length += item.length;
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

export function renderVkMarkdown(markdown: string): VkFormattedMessage {
  const source = markdown ?? "";
  let output = "";
  const items: VkFormatItem[] = [];

  const append = (value: string) => {
    if (!value) {
      return;
    }
    output += value;
  };

  const isWhitespace = (value: string) => /\s/.test(value);
  const isAlphaNum = (value: string) => /[\p{L}\p{N}]/u.test(value);

  const findClosing = (text: string, marker: string, start: number) => {
    let index = start;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text.startsWith(marker, index)) {
        return index;
      }
      index += 1;
    }
    return -1;
  };

  const findClosingSingleEmphasis = (
    text: string,
    marker: "*" | "_",
    start: number,
  ) => {
    let index = start;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] !== marker) {
        index += 1;
        continue;
      }

      const prevSame = text[index - 1] === marker;
      const nextSame = text[index + 1] === marker;
      const secondInPair = prevSame && text[index - 2] !== marker;
      if (nextSame || secondInPair) {
        index += 1;
        continue;
      }

      return index;
    }
    return -1;
  };

  const findClosingLinkDestination = (text: string, start: number) => {
    let index = start;
    let nestedParens = 0;
    while (index < text.length) {
      const ch = text[index];
      if (ch === "\\") {
        index += 2;
        continue;
      }
      if (ch === "(") {
        nestedParens += 1;
        index += 1;
        continue;
      }
      if (ch === ")") {
        if (nestedParens === 0) {
          return index;
        }
        nestedParens -= 1;
        index += 1;
        continue;
      }
      index += 1;
    }
    return -1;
  };

  const parseInline = (text: string, baseOffset: number) => {
    let local = "";
    const localItems: VkFormatItem[] = [];
    let index = 0;

    const appendLocal = (value: string) => {
      if (!value) {
        return;
      }
      local += value;
    };

    while (index < text.length) {
      const ch = text[index];

      if (ch === "\\") {
        if (index + 1 < text.length) {
          appendLocal(text[index + 1]);
          index += 2;
          continue;
        }
      }

      if (ch === "`") {
        const close = findClosing(text, "`", index + 1);
        if (close > index) {
          appendLocal(text.slice(index, close + 1));
          index = close + 1;
          continue;
        }
        appendLocal(ch);
        index += 1;
        continue;
      }

      if (ch === "[") {
        const closeBracket = findClosing(text, "]", index + 1);
        if (closeBracket > index && text[closeBracket + 1] === "(") {
          const closeParen = findClosingLinkDestination(text, closeBracket + 2);
          if (closeParen > closeBracket + 1) {
            const label = text.slice(index + 1, closeBracket);
            const url = text.slice(closeBracket + 2, closeParen);
            const startOffset = baseOffset + local.length;
            const parsed = parseInline(label, startOffset);
            appendLocal(parsed.text);
            localItems.push(...parsed.items);
            if (parsed.text.length > 0) {
              localItems.push({
                type: "url",
                offset: startOffset,
                length: parsed.text.length,
                url,
              });
            }
            index = closeParen + 1;
            continue;
          }
        }
      }

      if (text.startsWith("***", index) || text.startsWith("___", index)) {
        const marker = text.startsWith("***", index) ? "***" : "___";
        const nextChar = text[index + marker.length] ?? "";
        if (!nextChar || isWhitespace(nextChar)) {
          appendLocal(marker);
          index += marker.length;
          continue;
        }
        const close = findClosing(text, marker, index + marker.length);
        if (close > index) {
          const beforeClose = text[close - 1] ?? "";
          if (beforeClose && !isWhitespace(beforeClose)) {
            const inner = text.slice(index + marker.length, close);
            const startOffset = baseOffset + local.length;
            const parsed = parseInline(inner, startOffset);
            appendLocal(parsed.text);
            localItems.push(...parsed.items);
            if (parsed.text.length > 0) {
              localItems.push(
                { type: "bold", offset: startOffset, length: parsed.text.length },
                { type: "italic", offset: startOffset, length: parsed.text.length },
              );
            }
            index = close + marker.length;
            continue;
          }
        }
      }

      if ((ch === "*" || ch === "_") && !text.startsWith(ch + ch, index)) {
        const nextChar = text[index + 1] ?? "";
        const prevChar = text[index - 1] ?? "";
        if (!nextChar || isWhitespace(nextChar) || (isAlphaNum(prevChar) && isAlphaNum(nextChar))) {
          appendLocal(ch);
          index += 1;
          continue;
        }
        const close = findClosingSingleEmphasis(text, ch, index + 1);
        if (close > index) {
          const beforeClose = text[close - 1] ?? "";
          if (beforeClose && !isWhitespace(beforeClose)) {
            const inner = text.slice(index + 1, close);
            const startOffset = baseOffset + local.length;
            const parsed = parseInline(inner, startOffset);
            appendLocal(parsed.text);
            localItems.push(...parsed.items);
            if (parsed.text.length > 0) {
              localItems.push({
                type: "italic",
                offset: startOffset,
                length: parsed.text.length,
              });
            }
            index = close + 1;
            continue;
          }
        }
      }

      if (text.startsWith("**", index) || text.startsWith("__", index)) {
        const marker = text.startsWith("**", index) ? "**" : "__";
        const nextChar = text[index + marker.length] ?? "";
        if (!nextChar || isWhitespace(nextChar)) {
          appendLocal(marker);
          index += marker.length;
          continue;
        }
        const close = findClosing(text, marker, index + marker.length);
        if (close > index) {
          const beforeClose = text[close - 1] ?? "";
          if (beforeClose && !isWhitespace(beforeClose)) {
            const inner = text.slice(index + marker.length, close);
            const startOffset = baseOffset + local.length;
            const parsed = parseInline(inner, startOffset);
            appendLocal(parsed.text);
            localItems.push(...parsed.items);
            if (parsed.text.length > 0) {
              localItems.push({
                type: "bold",
                offset: startOffset,
                length: parsed.text.length,
              });
            }
            index = close + marker.length;
            continue;
          }
        }
      }

      appendLocal(ch);
      index += 1;
    }

    return { text: local, items: localItems };
  };

  let index = 0;
  let inCodeBlock = false;

  while (index < source.length) {
    if (source.startsWith("```", index)) {
      inCodeBlock = !inCodeBlock;
      append("```");
      index += 3;
      continue;
    }

    if (inCodeBlock) {
      append(source[index]);
      index += 1;
      continue;
    }

    let nextFence = source.indexOf("```", index);
    if (nextFence === -1) {
      nextFence = source.length;
    }
    const chunk = source.slice(index, nextFence);
    const parsed = parseInline(chunk, output.length);
    append(parsed.text);
    items.push(...parsed.items);
    index = nextFence;
  }

  const mergedItems = mergeFormatItems(items);
  return mergedItems.length === 0
    ? { text: output }
    : {
        text: output,
        formatData: {
          version: 1,
          items: mergedItems,
        },
      };
}

export function trimVkFormattedMessage(
  message: VkFormattedMessage,
  limit: number,
): VkFormattedMessage {
  if (limit <= 0) {
    return { text: "" };
  }
  if (message.text.length <= limit) {
    return message;
  }
  const trimmedText = message.text.slice(0, limit);
  if (!message.formatData) {
    return { text: trimmedText };
  }
  const items = message.formatData.items
    .map((item) => {
      const start = item.offset;
      const end = item.offset + item.length;
      if (start >= limit) {
        return null;
      }
      const nextLength = Math.min(end, limit) - start;
      if (nextLength <= 0) {
        return null;
      }
      return { ...item, length: nextLength };
    })
    .filter((item): item is VkFormatItem => Boolean(item));
  return items.length
    ? { text: trimmedText, formatData: { version: 1, items } }
    : { text: trimmedText };
}
