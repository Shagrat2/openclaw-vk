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
  const VK_SOLID_SEPARATOR = "─".repeat(3);
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

  const parseAtxHeading = (line: string): { level: number; content: string } | null => {
    const match = line.match(/^(?: {0,3})(#{1,6})(.*)$/);
    if (!match) {
      return null;
    }
    const marker = match[1] ?? "";
    const rest = match[2] ?? "";
    if (rest.length > 0 && !/^[\t ]/.test(rest)) {
      return null;
    }
    const withoutPrefixSpace = rest.replace(/^[\t ]+/, "");
    const withoutClosingHashes = withoutPrefixSpace.replace(/[\t ]+#+[\t ]*$/, "");
    return {
      level: marker.length,
      content: withoutClosingHashes.replace(/[\t ]+$/, ""),
    };
  };

  const parseTaskCheckboxLine = (line: string): string | null => {
    const match = line.match(/^([ \t]{0,3})[-+*][ \t]+\[([ xX])\](.*)$/);
    if (!match) {
      return null;
    }
    const indent = match[1] ?? "";
    const state = match[2] ?? " ";
    const rest = match[3] ?? "";
    return `${indent}${state === " " ? "□" : "■"}${rest}`;
  };

  const parseBlockQuoteLine = (line: string): { prefix: string; content: string } | null => {
    let index = 0;
    while (index < line.length && index < 3 && line[index] === " ") {
      index += 1;
    }
    if (line[index] !== ">") {
      return null;
    }
    while (index < line.length && line[index] === ">") {
      index += 1;
      if (line[index] === " " || line[index] === "\t") {
        index += 1;
      }
    }
    return {
      prefix: line.slice(0, index),
      content: line.slice(index),
    };
  };

  const isMarkdownHyphenSeparator = (line: string): boolean => /^(?: {0,3})(?:-\s*){3,}$/.test(line);

  const toStableUpperCase = (text: string): string =>
    [...text]
      .map((char) => {
        const upper = char.toLocaleUpperCase("ru-RU");
        return [...upper].length === 1 ? upper : char;
      })
      .join("");

  type TableAlign = "left" | "right" | "center" | "auto";

  const splitTableCells = (line: string): string[] | null => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("|")) {
      return null;
    }
    let body = trimmed;
    if (body.startsWith("|")) {
      body = body.slice(1);
    }
    if (body.endsWith("|")) {
      body = body.slice(0, -1);
    }
    const cells: string[] = [];
    let current = "";
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "\\" && body[i + 1] === "|") {
        current += "\\|";
        i += 1;
        continue;
      }
      if (ch === "|") {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    cells.push(current.trim());
    return cells;
  };

  const parseTableDelimiter = (line: string, columnCount: number): TableAlign[] | null => {
    const cells = splitTableCells(line);
    if (!cells || cells.length !== columnCount) {
      return null;
    }
    const alignments: TableAlign[] = [];
    for (const cell of cells) {
      const marker = cell.replace(/\s+/g, "");
      if (!/^:?-{3,}:?$/.test(marker)) {
        return null;
      }
      if (marker.startsWith(":") && marker.endsWith(":")) {
        alignments.push("center");
      } else if (marker.endsWith(":")) {
        alignments.push("right");
      } else if (marker.startsWith(":")) {
        alignments.push("left");
      } else {
        alignments.push("auto");
      }
    }
    return alignments;
  };

  const normalizeTableCells = (cells: string[], columnCount: number): string[] => {
    if (cells.length === columnCount) {
      return cells;
    }
    if (cells.length > columnCount) {
      return [...cells.slice(0, columnCount - 1), cells.slice(columnCount - 1).join(" | ")];
    }
    return [...cells, ...Array.from({ length: columnCount - cells.length }, () => "")];
  };

  const isNumericCell = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    const compact = trimmed.replace(/\s+/g, "");
    if (!/\d/.test(compact)) {
      return false;
    }
    return /^[+-]?(?:[$€£¥₽])?(?:(?:\d{1,3}(?:[,_]\d{3})+)|\d+|\d*)(?:[.,]\d+)?(?:[%]|[$€£¥₽])?$/.test(
      compact,
    );
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

  const renderMarkdownTable = (params: {
    headerCells: string[];
    bodyRows: string[][];
    delimiterAlignments: TableAlign[];
    baseOffset: number;
  }): { text: string; items: VkFormatItem[] } => {
    const parsedHeader = params.headerCells.map((cell) => parseInline(cell, 0));
    const parsedBody = params.bodyRows.map((row) => row.map((cell) => parseInline(cell, 0)));
    const columnCount = parsedHeader.length;
    const SPACE_WIDTH_UNITS = 4;

    const estimateSansCharWidth = (char: string): number => {
      if (char === " ") {
        return SPACE_WIDTH_UNITS;
      }
      if (char === "\t") {
        return SPACE_WIDTH_UNITS * 4;
      }
      if (/[\p{Extended_Pictographic}]/u.test(char)) {
        return 12;
      }
      if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(char)) {
        return 11;
      }
      if (/[MWmw@#%&ЖШЩЮЫФЖшщюыф]/u.test(char)) {
        return 9;
      }
      if (/[ilI1\|'"`.,:;!]/.test(char)) {
        return 3;
      }
      if (/[()\[\]{}]/.test(char)) {
        return 4;
      }
      if (/[-_~]/.test(char)) {
        return 5;
      }
      if (/[0-9]/.test(char)) {
        return 7;
      }
      if (/[A-ZА-ЯЁ]/u.test(char)) {
        return 7;
      }
      if (/[a-zа-яё]/u.test(char)) {
        return 6;
      }
      return 6;
    };

    const estimateSansTextWidth = (text: string): number =>
      [...text].reduce((sum, char) => sum + estimateSansCharWidth(char), 0);

    const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
      Math.max(
        estimateSansTextWidth(parsedHeader[columnIndex]?.text ?? ""),
        ...parsedBody.map((row) => estimateSansTextWidth(row[columnIndex]?.text ?? "")),
      ),
    );

    const bodyAlignments: Exclude<TableAlign, "auto">[] = params.delimiterAlignments.map((alignment, columnIndex) => {
      if (alignment === "left" || alignment === "right" || alignment === "center") {
        return alignment;
      }
      const bodyValues = parsedBody
        .map((row) => row[columnIndex]?.text ?? "")
        .map((text) => text.trim())
        .filter(Boolean);
      const isNumericColumn = bodyValues.length > 0 && bodyValues.every((text) => isNumericCell(text));
      return isNumericColumn ? "right" : "left";
    });
    const headerAlignments: Exclude<TableAlign, "auto">[] = Array.from({ length: columnCount }, (_, columnIndex) =>
      columnIndex > 0 && columnIndex < columnCount - 1 ? "center" : "left",
    );

    const padCell = (text: string, width: number, align: Exclude<TableAlign, "auto">): { rendered: string; leftPad: number } => {
      const textWidth = estimateSansTextWidth(text);
      if (width <= textWidth) {
        return { rendered: text, leftPad: 0 };
      }
      const diff = width - textWidth;
      const spaces = Math.max(1, Math.ceil(diff / SPACE_WIDTH_UNITS));
      if (align === "right") {
        return { rendered: " ".repeat(spaces) + text, leftPad: spaces };
      }
      if (align === "center") {
        const leftPad = Math.floor(spaces / 2);
        const rightPad = spaces - leftPad;
        return { rendered: " ".repeat(leftPad) + text + " ".repeat(rightPad), leftPad };
      }
      return { rendered: text + " ".repeat(spaces), leftPad: 0 };
    };

    let tableText = "";
    const tableItems: VkFormatItem[] = [];
    const rows = [parsedHeader, ...parsedBody];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const isHeader = rowIndex === 0;
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const cell = row[columnIndex] ?? { text: "", items: [] };
        const align = isHeader ? headerAlignments[columnIndex] : bodyAlignments[columnIndex];
        const cellStart = params.baseOffset + tableText.length;
        const { rendered, leftPad } = padCell(cell.text, widths[columnIndex], align);
        tableText += rendered;

        const contentStart = cellStart + leftPad;
        const inlineItems = isHeader ? cell.items.filter((item) => item.type !== "bold") : cell.items;
        tableItems.push(
          ...inlineItems.map((item) => ({
            ...item,
            offset: contentStart + item.offset,
          })),
        );
        if (isHeader && cell.text.length > 0) {
          tableItems.push({
            type: "bold",
            offset: contentStart,
            length: cell.text.length,
          });
        }

        if (columnIndex < columnCount - 1) {
          tableText += " | ";
        }
      }
      if (rowIndex < rows.length - 1) {
        tableText += "\n";
      }
    }

    return { text: tableText, items: tableItems };
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
    let lineStart = 0;
    let plainStart = 0;
    while (lineStart <= chunk.length) {
      const lineBreak = chunk.indexOf("\n", lineStart);
      const lineEnd = lineBreak === -1 ? chunk.length : lineBreak;
      const line = chunk.slice(lineStart, lineEnd);
      const nextLineStart = lineBreak === -1 ? -1 : lineBreak + 1;
      const nextLineBreak =
        nextLineStart === -1 ? -1 : chunk.indexOf("\n", nextLineStart);
      const nextLineEnd = nextLineBreak === -1 ? chunk.length : nextLineBreak;
      const nextLine = nextLineStart === -1 ? null : chunk.slice(nextLineStart, nextLineEnd);
      const headerCells = splitTableCells(line);
      const delimiterAlignments =
        headerCells && nextLine !== null ? parseTableDelimiter(nextLine, headerCells.length) : null;

      if (headerCells && delimiterAlignments) {
        if (plainStart < lineStart) {
          const plain = parseInline(chunk.slice(plainStart, lineStart), output.length);
          append(plain.text);
          items.push(...plain.items);
        }

        const bodyRows: string[][] = [];
        let cursorStart = nextLineBreak === -1 ? chunk.length : nextLineBreak + 1;
        let lastConsumedBreak = nextLineBreak;

        while (cursorStart <= chunk.length) {
          const rowBreak = chunk.indexOf("\n", cursorStart);
          const rowEnd = rowBreak === -1 ? chunk.length : rowBreak;
          const rowLine = chunk.slice(cursorStart, rowEnd);
          const rowCells = splitTableCells(rowLine);
          if (!rowCells) {
            break;
          }
          bodyRows.push(normalizeTableCells(rowCells, headerCells.length));
          lastConsumedBreak = rowBreak;
          if (rowBreak === -1) {
            cursorStart = chunk.length;
            break;
          }
          cursorStart = rowBreak + 1;
        }

        const table = renderMarkdownTable({
          headerCells,
          bodyRows,
          delimiterAlignments,
          baseOffset: output.length,
        });
        append(table.text);
        items.push(...table.items);
        if (lastConsumedBreak !== -1) {
          append("\n");
        }

        plainStart = lastConsumedBreak === -1 ? chunk.length : lastConsumedBreak + 1;
        lineStart = plainStart;
        if (lineStart > chunk.length) {
          break;
        }
        continue;
      }

      if (isMarkdownHyphenSeparator(line)) {
        if (plainStart < lineStart) {
          const plain = parseInline(chunk.slice(plainStart, lineStart), output.length);
          append(plain.text);
          items.push(...plain.items);
        }
        append(VK_SOLID_SEPARATOR);
        if (lineBreak !== -1) {
          append("\n");
        }
        plainStart = lineBreak === -1 ? chunk.length : lineBreak + 1;
      }

      const quoteLine = parseBlockQuoteLine(line);
      if (quoteLine !== null && !isMarkdownHyphenSeparator(line)) {
        if (plainStart < lineStart) {
          const plain = parseInline(chunk.slice(plainStart, lineStart), output.length);
          append(plain.text);
          items.push(...plain.items);
        }

        const quoteOffset = output.length;
        append(quoteLine.prefix);
        const normalizedQuoteContent = parseTaskCheckboxLine(quoteLine.content) ?? quoteLine.content;
        const quoteContent = parseInline(normalizedQuoteContent, output.length);
        append(quoteContent.text);
        items.push(...quoteContent.items);
        if (output.length > quoteOffset) {
          items.push({ type: "italic", offset: quoteOffset, length: output.length - quoteOffset });
        }
        if (lineBreak !== -1) {
          append("\n");
        }

        plainStart = lineBreak === -1 ? chunk.length : lineBreak + 1;
      }

      const checkboxLine = parseTaskCheckboxLine(line);
      if (checkboxLine !== null && quoteLine === null) {
        if (plainStart < lineStart) {
          const plain = parseInline(chunk.slice(plainStart, lineStart), output.length);
          append(plain.text);
          items.push(...plain.items);
        }

        const checkbox = parseInline(checkboxLine, output.length);
        append(checkbox.text);
        items.push(...checkbox.items);
        if (lineBreak !== -1) {
          append("\n");
        }

        plainStart = lineBreak === -1 ? chunk.length : lineBreak + 1;
      }

      const heading = parseAtxHeading(line);
      if (heading !== null && quoteLine === null && checkboxLine === null) {
        if (plainStart < lineStart) {
          const plain = parseInline(chunk.slice(plainStart, lineStart), output.length);
          append(plain.text);
          items.push(...plain.items);
        }

        const headingOffset = output.length;
        const parsedHeading = parseInline(heading.content, headingOffset);
        const headingStyle: VkFormatType = heading.level >= 4 ? "italic" : "bold";
        const headingText = heading.level === 1 ? toStableUpperCase(parsedHeading.text) : parsedHeading.text;
        append(headingText);
        items.push(...parsedHeading.items.filter((item) => item.type !== headingStyle));
        if (headingText.length > 0) {
          items.push({ type: headingStyle, offset: headingOffset, length: headingText.length });
        }
        if (lineBreak !== -1) {
          append("\n");
        }

        plainStart = lineBreak === -1 ? chunk.length : lineBreak + 1;
      }

      if (lineBreak === -1) {
        break;
      }
      lineStart = lineBreak + 1;
    }

    if (plainStart < chunk.length) {
      const parsed = parseInline(chunk.slice(plainStart), output.length);
      append(parsed.text);
      items.push(...parsed.items);
    }
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
