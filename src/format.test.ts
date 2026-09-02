import { describe, expect, it } from "vitest";
import {
  collapseBlankLinesBeforeCodeFencesTransform as collapseBlankLinesBeforeVkCodeFences,
  headingTransform as transformMarkdownHeadingBlock,
} from "markdown-to-vk";
import { renderVkMarkdownChunks, type VkPreparedFormattedMessage } from "./format.js";

function renderSingleVkMarkdownChunk(
  markdown: string,
  options?: Parameters<typeof renderVkMarkdownChunks>[1],
): VkPreparedFormattedMessage {
  const chunks = renderVkMarkdownChunks(markdown ?? "", options);
  expect(chunks).toHaveLength(1);
  return chunks[0] ?? { text: "" };
}

function splitRenderedTableRows(text: string): string[][] {
  return text.split("\n").map((line) => line.split("|").map((cell) => cell.trim()));
}

describe("renderVkMarkdownChunks", () => {
  const VK_SOLID_SEPARATOR = "─".repeat(3);

  it("keeps unsupported markdown unchanged", () => {
    const input = ["- item", "1. item", "~~strike~~"].join("\n");

    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe(input);
    expect(result.formatData).toBeUndefined();
  });

  it("renders markdown hyphen separators as a solid 3-char line", () => {
    const input = ["Before", "---", "After"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result).toEqual({
      text: ["Before", VK_SOLID_SEPARATOR, "After"].join("\n"),
    });
  });

  it("splits long formatted output into markdown-to-vk chunks without recomputing offsets", () => {
    const chunks = renderVkMarkdownChunks(`**${"a".repeat(5000)}**`);

    expect(chunks).toEqual([
      {
        text: "a".repeat(4096),
        formatData: { version: 1, items: [{ type: "bold", offset: 0, length: 4096 }] },
      },
      {
        text: "a".repeat(904),
        formatData: { version: 1, items: [{ type: "bold", offset: 0, length: 904 }] },
      },
    ]);
  });

  it("keeps complete rendered blocks together when they fit the VK chunk budget", () => {
    const markdown = "**Alpha bold**\n\nSecond paragraph stays whole.\n\nTail";
    const chunks = renderVkMarkdownChunks(markdown, { chunkSize: 32 });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Alpha bold\n\n",
      "Second paragraph stays whole.\n\n",
      "Tail",
    ]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(
      "Alpha bold\n\nSecond paragraph stays whole.\n\nTail",
    );
    expect(chunks[0]?.formatData?.items).toEqual([
      { type: "bold", offset: 0, length: "Alpha bold".length },
    ]);
    expect(chunks.slice(1).every((chunk) => chunk.formatData === undefined)).toBe(true);
  });

  it("splits an oversized formatted paragraph at word boundaries and preserves local format offsets", () => {
    const renderedText = "one two three four five six seven";
    const chunks = renderVkMarkdownChunks(`**${renderedText}**`, { chunkSize: 12 });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "one two ",
      "three four ",
      "five six ",
      "seven",
    ]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(renderedText);
    for (const chunk of chunks) {
      expect(chunk.formatData?.items).toEqual([
        { type: "bold", offset: 0, length: chunk.text.length },
      ]);
    }
  });

  it("counts @ as two VK limit units while retaining text and format ranges", () => {
    const chunks = renderVkMarkdownChunks("**aaaa@bbbb**", { chunkSize: 9 });
    const measureVkLength = (text: string): number =>
      [...text].reduce((total, character) => total + (character === "@" ? 2 : 1), 0);

    expect(chunks.map((chunk) => chunk.text)).toEqual(["aaaa@bbb", "b"]);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("aaaa@bbbb");
    expect(chunks.every((chunk) => measureVkLength(chunk.text) <= 9)).toBe(true);
    expect(chunks.map((chunk) => chunk.formatData?.items)).toEqual([
      [{ type: "bold", offset: 0, length: 8 }],
      [{ type: "bold", offset: 0, length: 1 }],
    ]);
  });

  it("never splits a surrogate pair at a VK chunk boundary", () => {
    const chunks = renderVkMarkdownChunks("**1234567😀XYZ**", { chunkSize: 8 });

    expect(chunks.map((chunk) => chunk.text).join("")).toBe("1234567😀XYZ");
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(chunk.formatData?.items).toEqual([
        { type: "bold", offset: 0, length: chunk.text.length },
      ]);
    }
  });

  it("keeps custom pipelines without injecting the default table transform", () => {
    const input = ["## Header", "---", "Body"].join("\n");
    const result = renderSingleVkMarkdownChunk(input, { pipeline: [transformMarkdownHeadingBlock] });

    expect(result.text).toBe(["Header", "---", "Body"].join("\n"));
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: "Header".length }]);
  });

  it("keeps markdown separators inside fenced code blocks untouched", () => {
    const input = ["```md", "---", "```"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result).toEqual({ text: input });
  });

  it("renders h1-h3 as bold and h4-h6 as italic without hash prefixes", () => {
    const input = ["# One", "## Two", "### Three", "#### Four", "##### Five", "###### Six", "Body"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe(["ONE", "Two", "Three", "Four", "Five", "Six", "Body"].join("\n"));
    expect(result.formatData?.items).toEqual([
      { type: "bold", offset: result.text.indexOf("ONE"), length: 3 },
      { type: "bold", offset: result.text.indexOf("Two"), length: 3 },
      { type: "bold", offset: result.text.indexOf("Three"), length: 5 },
      { type: "italic", offset: result.text.indexOf("Four"), length: 4 },
      { type: "italic", offset: result.text.indexOf("Five"), length: 4 },
      { type: "italic", offset: result.text.indexOf("Six"), length: 3 },
    ]);
  });

  it("renders h1 headings in uppercase for cyrillic content too", () => {
    const result = renderSingleVkMarkdownChunk("# Привет, мир");

    expect(result.text).toBe("ПРИВЕТ, МИР");
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: "ПРИВЕТ, МИР".length }]);
  });

  it("supports heading content with trailing marker sequence", () => {
    const result = renderSingleVkMarkdownChunk("### Основная информация ###");

    expect(result.text).toBe("Основная информация");
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: "Основная информация".length }]);
  });

  it("supports inline markdown inside headings", () => {
    const result = renderSingleVkMarkdownChunk("### [docs](https://example.com) and *note*");

    expect(result.text).toBe("docs and note");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: 0, length: "docs and note".length },
        { type: "url", offset: 0, length: "docs".length, url: "https://example.com" },
        { type: "italic", offset: "docs and ".length, length: "note".length },
      ]),
    );
  });

  it("does not treat hash-prefixed words as headings when whitespace is missing", () => {
    expect(renderSingleVkMarkdownChunk("###Заголовок")).toEqual({ text: "###Заголовок" });
  });

  it("does not treat deeply indented lines as headings", () => {
    expect(renderSingleVkMarkdownChunk("    ### not heading")).toEqual({ text: "    ### not heading" });
  });

  it("keeps headings inside fenced code blocks untouched", () => {
    const input = ["```md", "### not heading", "```", "### heading"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe(["```md", "### not heading", "```", "heading"].join("\n"));
    expect(result.formatData?.items).toEqual([
      {
        type: "bold",
        offset: result.text.lastIndexOf("heading"),
        length: "heading".length,
      },
    ]);
  });

  it("supports headings with up to three leading spaces", () => {
    const result = renderSingleVkMarkdownChunk("   ### spaced heading");

    expect(result.text).toBe("spaced heading");
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: "spaced heading".length }]);
  });

  it("renders h4 headings as italic and keeps inline markdown", () => {
    const result = renderSingleVkMarkdownChunk("#### [docs](https://example.com) and **note**");

    expect(result.text).toBe("docs and note");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "italic", offset: 0, length: "docs and note".length },
        { type: "url", offset: 0, length: "docs".length, url: "https://example.com" },
        { type: "bold", offset: "docs and ".length, length: "note".length },
      ]),
    );
  });

  it("replaces markdown checkboxes with square glyphs", () => {
    const input = ["- [ ] todo", "- [x] done", "- [X] DONE"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result).toEqual({ text: ["□ todo", "■ done", "■ DONE"].join("\n") });
  });

  it("does not replace checkbox markers inside fenced code blocks", () => {
    const input = ["```md", "- [ ] todo", "- [x] done", "```"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result).toEqual({ text: input });
  });

  it("renders markdown blockquotes as italic while preserving the quote prefix", () => {
    const input = ["> quoted text", "> [docs](https://example.com) and **note**"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe(["> quoted text", "> docs and note"].join("\n"));
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "italic", offset: 0, length: "> quoted text".length },
        { type: "italic", offset: result.text.lastIndexOf(">"), length: "> docs and note".length },
        {
          type: "url",
          offset: result.text.lastIndexOf("docs"),
          length: "docs".length,
          url: "https://example.com",
        },
        {
          type: "bold",
          offset: result.text.lastIndexOf("note"),
          length: "note".length,
        },
      ]),
    );
  });

  it("does not apply quote formatting inside fenced code blocks", () => {
    const input = ["```md", "> quoted", "```"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result).toEqual({ text: input });
  });

  it("extracts bold, italic, and bold+italic ranges", () => {
    const input = "A **bold** B *italic* C ***both*** D";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("A bold B italic C both D");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: result.text.indexOf("bold"), length: 4 },
        { type: "italic", offset: result.text.indexOf("italic"), length: 6 },
        { type: "bold", offset: result.text.indexOf("both"), length: 4 },
        { type: "italic", offset: result.text.indexOf("both"), length: 4 },
      ]),
    );
  });

  it("supports italic wrapping bold with the same asterisk marker family", () => {
    const input = "*italic **bold** text*";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("italic bold text");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "italic", offset: 0, length: result.text.length },
        { type: "bold", offset: result.text.indexOf("bold"), length: 4 },
      ]),
    );
  });

  it("supports italic wrapping bold with the same underscore marker family", () => {
    const input = "_italic __bold__ text_";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("italic bold text");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "italic", offset: 0, length: result.text.length },
        { type: "bold", offset: result.text.indexOf("bold"), length: 4 },
      ]),
    );
  });

  it("formats links without altering other markdown", () => {
    const input = "See [**bold** link](https://example.com) now";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("See bold link now");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: result.text.indexOf("bold"), length: 4 },
        {
          type: "url",
          offset: result.text.indexOf("bold link"),
          length: "bold link".length,
          url: "https://example.com",
        },
      ]),
    );
  });

  it("keeps links valid when URL contains nested parentheses", () => {
    const input = "See [docs](https://example.com/path_(v2)) now";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("See docs now");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        {
          type: "url",
          offset: result.text.indexOf("docs"),
          length: 4,
          url: "https://example.com/path_(v2)",
        },
      ]),
    );
  });

  it("does not format inside inline code", () => {
    const input = "Code `**no**` and **yes**";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("Code `**no**` and yes");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([{ type: "bold", offset: result.text.indexOf("yes"), length: 3 }]),
    );
    expect(result.formatData?.items).toHaveLength(1);
  });

  it("keeps inline code literal but applies outer bold formatting", () => {
    const input = "**`/usr` — 58 ГБ**";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("`/usr` — 58 ГБ");
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: result.text.length }]);
  });

  it("keeps inline code literal but applies outer italic formatting", () => {
    const input = "*`/var` — 41 ГБ*";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("`/var` — 41 ГБ");
    expect(result.formatData?.items).toEqual([{ type: "italic", offset: 0, length: result.text.length }]);
  });

  it("keeps inline code literal but applies outer bold+italic formatting", () => {
    const input = "***`/tmp` — 7 ГБ***";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("`/tmp` — 7 ГБ");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: 0, length: result.text.length },
        { type: "italic", offset: 0, length: result.text.length },
      ]),
    );
  });

  it("supports bold wrapper over inline-code link labels", () => {
    const input = "**[`/usr`](https://example.com/usr) — 58 ГБ**";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("`/usr` — 58 ГБ");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: 0, length: result.text.length },
        { type: "url", offset: 0, length: "`/usr`".length, url: "https://example.com/usr" },
      ]),
    );
  });

  it("does not parse emphasis markers inside inline code even under outer bold", () => {
    const input = "**`*not-italic*` and ok**";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("`*not-italic*` and ok");
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: result.text.length }]);
  });

  it("does not format inside fenced code blocks", () => {
    const input = ["```", "**no**", "```", "**yes**"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe(input.replace("**yes**", "yes"));
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([{ type: "bold", offset: result.text.lastIndexOf("yes"), length: 3 }]),
    );
    expect(result.formatData?.items).toHaveLength(1);
  });

  it("does not format inside fenced code blocks with language", () => {
    const input = ["```ts", "**no**", "```", "**yes**"].join("\n");
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe(input.replace("**yes**", "yes"));
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([{ type: "bold", offset: result.text.lastIndexOf("yes"), length: 3 }]),
    );
    expect(result.formatData?.items).toHaveLength(1);
  });

  it("keeps escaped emphasis markers inside italic content", () => {
    const input = "*a\\*b*";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("a*b");
    expect(result.formatData?.items).toEqual([{ type: "italic", offset: 0, length: 3 }]);
  });

  it("keeps escaped backticks inside inline code literal", () => {
    const input = "`a\\`b`";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result).toEqual({ text: "`a\\`b`" });
  });

  it("treats unclosed emphasis and inline code markers as plain text", () => {
    expect(renderSingleVkMarkdownChunk("*abc")).toEqual({ text: "*abc" });
    expect(renderSingleVkMarkdownChunk("`abc")).toEqual({ text: "`abc" });
  });

  it("treats malformed links and trailing escapes as plain text", () => {
    expect(renderSingleVkMarkdownChunk("[x](https://example.com")).toEqual({
      text: "[x](https://example.com",
    });
    expect(renderSingleVkMarkdownChunk("abc\\")).toEqual({ text: "abc\\" });
  });

  it("supports escaped closing parenthesis in markdown link URLs", () => {
    const input = "[x](https://example.com/a\\)b)";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("x");
    expect(result.formatData?.items).toEqual([
      { type: "url", offset: 0, length: 1, url: "https://example.com/a\\)b" },
    ]);
  });

  it("does not parse emphasis when marker is followed by whitespace", () => {
    expect(renderSingleVkMarkdownChunk("*** bold***")).toEqual({ text: "*** bold***" });
    expect(renderSingleVkMarkdownChunk("** bold**")).toEqual({ text: "** bold**" });
  });

  it("does not parse single emphasis inside alphanumeric words", () => {
    expect(renderSingleVkMarkdownChunk("a*b")).toEqual({ text: "a*b" });
  });

  it("removes empty emphasis wrappers instead of leaking marker artifacts", () => {
    expect(renderVkMarkdownChunks("****")).toEqual([]);
    expect(renderVkMarkdownChunks("____")).toEqual([]);
  });

  it("merges adjacent URL ranges when consecutive links share the same destination", () => {
    const input = "[a](https://x)[b](https://x)";
    const result = renderSingleVkMarkdownChunk(input);

    expect(result.text).toBe("ab");
    expect(result.formatData?.items).toEqual([{ type: "url", offset: 0, length: 2, url: "https://x" }]);
  });

  it("renders markdown tables as aligned text columns", () => {
    const input = [
      "| Name | Qty | Price |",
      "| --- | --- | --- |",
      "| A | 2 | 10.5 |",
      "| Long | 100 | 3 |",
    ].join("\n");

    const result = renderSingleVkMarkdownChunk(input);
    const rows = splitRenderedTableRows(result.text);

    expect(rows).toEqual([
      ["Name", "Qty", "Price"],
      ["A", "2", "10.5"],
      ["Long", "100", "3"],
    ]);
    expect(result.text).toMatch(/[\u2006\u2009]/u);
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: result.text.indexOf("Name"), length: "Name".length },
        { type: "bold", offset: result.text.indexOf("Qty"), length: "Qty".length },
        { type: "bold", offset: result.text.indexOf("Price"), length: "Price".length },
      ]),
    );
  });

  it("adds visible padding around interior table headers", () => {
    const input = [
      "| Left | Middle | Right |",
      "| --- | --- | --- |",
      "| x | 1234567890 | y |",
    ].join("\n");
    const result = renderSingleVkMarkdownChunk(input);
    const headerLine = result.text.split("\n")[0] ?? "";
    const headerCells = headerLine.split("|");

    expect(headerCells).toHaveLength(3);
    expect(headerCells[0]?.trim()).toBe("Left");
    expect(headerCells[1]?.trim()).toBe("Middle");
    expect(headerCells[2]?.trim()).toBe("Right");
    expect(headerCells[1]).toMatch(/^\s+Middle\s+$/u);
  });

  it("formats inline markdown inside table cells", () => {
    const input = [
      "| Col | Value |",
      "| --- | --- |",
      "| Link | [docs](https://example.com/docs) |",
      "| Note | *ok* |",
    ].join("\n");

    const result = renderSingleVkMarkdownChunk(input);
    const rows = splitRenderedTableRows(result.text);

    expect(rows).toEqual([
      ["Col", "Value"],
      ["Link", "docs"],
      ["Note", "ok"],
    ]);
    expect(result.text).not.toContain("https://example.com/docs");
    expect(result.text).not.toContain("*ok*");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([
        { type: "bold", offset: result.text.indexOf("Col"), length: "Col".length },
        { type: "bold", offset: result.text.indexOf("Value"), length: "Value".length },
        { type: "url", offset: result.text.indexOf("docs"), length: "docs".length, url: "https://example.com/docs" },
        { type: "italic", offset: result.text.lastIndexOf("ok"), length: "ok".length },
      ]),
    );
  });

  it("does not parse tables inside fenced code blocks", () => {
    const input = [
      "```md",
      "| Name | Qty |",
      "| --- | --- |",
      "| A | 2 |",
      "```",
    ].join("\n");

    const result = renderSingleVkMarkdownChunk(input);

    expect(result).toEqual({ text: input });
  });

  it("pads narrow glyph cells more than wide glyph cells with equal text length", () => {
    const input = [
      "| C | N |",
      "| --- | --- |",
      "| WWW | 1 |",
      "| iii | 2 |",
    ].join("\n");
    const result = renderSingleVkMarkdownChunk(input);
    const lines = result.text.split("\n");

    const trailingSpaceCountBeforeFirstSeparator = (line: string): number => {
      const separatorIndex = line.indexOf("|");
      const beforeSeparator = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      return beforeSeparator.length - beforeSeparator.replace(/\s+$/, "").length;
    };

    expect(lines[1]).toContain("WWW");
    expect(lines[2]).toContain("iii");
    expect(trailingSpaceCountBeforeFirstSeparator(lines[2])).toBeGreaterThan(
      trailingSpaceCountBeforeFirstSeparator(lines[1]),
    );
  });
});

describe("transformMarkdownHeadingBlock", () => {
  it("can be tested in isolation with an explicit context", () => {
    const result = transformMarkdownHeadingBlock({
      chunk: "# Hi\n",
      line: "# Hi",
      lineStart: 0,
      lineEnd: 4,
      lineBreak: 4,
      nextLine: null,
      parseInline: (source) => ({ text: source, items: [] }),
    });

    expect(result).toEqual({
      consumedTo: 5,
      rendered: {
        text: "HI\n",
        items: [{ type: "bold", offset: 0, length: 2 }],
      },
    });
  });

  it("returns null for non-heading lines", () => {
    const result = transformMarkdownHeadingBlock({
      chunk: "plain",
      line: "plain",
      lineStart: 0,
      lineEnd: 5,
      lineBreak: -1,
      nextLine: null,
      parseInline: (source) => ({ text: source, items: [] }),
    });

    expect(result).toBeNull();
  });
});

describe("collapseBlankLinesBeforeVkCodeFences", () => {
  it("collapses blank lines directly before fenced code blocks", () => {
    const input = [
      "Run:",
      "",
      "```txt",
      "/approve f7aee832 allow-once",
      "```",
      "",
      "Pending command:",
      "",
      "```sh",
      "du -sh /* 2>/dev/null | sort -hr | head -20",
      "```",
    ].join("\n");

    expect(collapseBlankLinesBeforeVkCodeFences(input)).toBe(
      [
        "Run:",
        "```txt",
        "/approve f7aee832 allow-once",
        "```",
        "",
        "Pending command:",
        "```sh",
        "du -sh /* 2>/dev/null | sort -hr | head -20",
        "```",
      ].join("\n"),
    );
  });

  it("collapses blank lines before every fenced block in approval-style payloads", () => {
    const input = [
      "Run:",
      "",
      "",
      "```txt",
      "/approve f7aee832 allow-once",
      "```",
      "",
      "Pending command:",
      "",
      "",
      "```sh",
      "du -sh /* 2>/dev/null | sort -hr | head -20",
      "```",
      "",
      "Other options:",
      "",
      "",
      "```txt",
      "/approve f7aee832 allow-always",
      "/approve f7aee832 deny",
      "```",
    ].join("\n");

    expect(collapseBlankLinesBeforeVkCodeFences(input)).toBe(
      [
        "Run:",
        "```txt",
        "/approve f7aee832 allow-once",
        "```",
        "",
        "Pending command:",
        "```sh",
        "du -sh /* 2>/dev/null | sort -hr | head -20",
        "```",
        "",
        "Other options:",
        "```txt",
        "/approve f7aee832 allow-always",
        "/approve f7aee832 deny",
        "```",
      ].join("\n"),
    );
  });
});
