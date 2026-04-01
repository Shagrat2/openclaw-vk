import { describe, expect, it } from "vitest";
import {
  collapseBlankLinesBeforeVkCodeFences,
  renderVkMarkdown,
  trimVkFormattedMessage,
} from "./format.js";

describe("renderVkMarkdown", () => {
  it("keeps text unchanged except bold/italic/link formatting", () => {
    const input = ["# Title", "- item", "1. item", "~~strike~~"].join("\n");

    const result = renderVkMarkdown(input);

    expect(result.text).toBe(input);
    expect(result.formatData).toBeUndefined();
  });

  it("extracts bold, italic, and bold+italic ranges", () => {
    const input = "A **bold** B *italic* C ***both*** D";
    const result = renderVkMarkdown(input);

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
    const result = renderVkMarkdown(input);

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
    const result = renderVkMarkdown(input);

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
    const result = renderVkMarkdown(input);

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
    const result = renderVkMarkdown(input);

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
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("Code `**no**` and yes");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([{ type: "bold", offset: result.text.indexOf("yes"), length: 3 }]),
    );
    expect(result.formatData?.items).toHaveLength(1);
  });

  it("keeps inline code literal but applies outer bold formatting", () => {
    const input = "**`/usr` — 58 ГБ**";
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("`/usr` — 58 ГБ");
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: result.text.length }]);
  });

  it("keeps inline code literal but applies outer italic formatting", () => {
    const input = "*`/var` — 41 ГБ*";
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("`/var` — 41 ГБ");
    expect(result.formatData?.items).toEqual([{ type: "italic", offset: 0, length: result.text.length }]);
  });

  it("keeps inline code literal but applies outer bold+italic formatting", () => {
    const input = "***`/tmp` — 7 ГБ***";
    const result = renderVkMarkdown(input);

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
    const result = renderVkMarkdown(input);

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
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("`*not-italic*` and ok");
    expect(result.formatData?.items).toEqual([{ type: "bold", offset: 0, length: result.text.length }]);
  });

  it("does not format inside fenced code blocks", () => {
    const input = ["```", "**no**", "```", "**yes**"].join("\n");
    const result = renderVkMarkdown(input);

    expect(result.text).toBe(input.replace("**yes**", "yes"));
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([{ type: "bold", offset: result.text.lastIndexOf("yes"), length: 3 }]),
    );
    expect(result.formatData?.items).toHaveLength(1);
  });

  it("does not format inside fenced code blocks with language", () => {
    const input = ["```ts", "**no**", "```", "**yes**"].join("\n");
    const result = renderVkMarkdown(input);

    expect(result.text).toBe(input.replace("**yes**", "yes"));
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([{ type: "bold", offset: result.text.lastIndexOf("yes"), length: 3 }]),
    );
    expect(result.formatData?.items).toHaveLength(1);
  });

  it("keeps escaped emphasis markers inside italic content", () => {
    const input = "*a\\*b*";
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("a*b");
    expect(result.formatData?.items).toEqual([{ type: "italic", offset: 0, length: 3 }]);
  });

  it("keeps escaped backticks inside inline code literal", () => {
    const input = "`a\\`b`";
    const result = renderVkMarkdown(input);

    expect(result).toEqual({ text: "`a\\`b`" });
  });

  it("treats unclosed emphasis and inline code markers as plain text", () => {
    expect(renderVkMarkdown("*abc")).toEqual({ text: "*abc" });
    expect(renderVkMarkdown("`abc")).toEqual({ text: "`abc" });
  });

  it("treats malformed links and trailing escapes as plain text", () => {
    expect(renderVkMarkdown("[x](https://example.com")).toEqual({
      text: "[x](https://example.com",
    });
    expect(renderVkMarkdown("abc\\")).toEqual({ text: "abc\\" });
  });

  it("supports escaped closing parenthesis in markdown link URLs", () => {
    const input = "[x](https://example.com/a\\)b)";
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("x");
    expect(result.formatData?.items).toEqual([
      { type: "url", offset: 0, length: 1, url: "https://example.com/a\\)b" },
    ]);
  });

  it("does not parse emphasis when marker is followed by whitespace", () => {
    expect(renderVkMarkdown("*** bold***")).toEqual({ text: "*** bold***" });
    expect(renderVkMarkdown("** bold**")).toEqual({ text: "** bold**" });
  });

  it("does not parse single emphasis inside alphanumeric words", () => {
    expect(renderVkMarkdown("a*b")).toEqual({ text: "a*b" });
  });

  it("removes empty emphasis wrappers instead of leaking marker artifacts", () => {
    expect(renderVkMarkdown("****")).toEqual({ text: "" });
    expect(renderVkMarkdown("____")).toEqual({ text: "" });
  });

  it("merges adjacent URL ranges when consecutive links share the same destination", () => {
    const input = "[a](https://x)[b](https://x)";
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("ab");
    expect(result.formatData?.items).toEqual([{ type: "url", offset: 0, length: 2, url: "https://x" }]);
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

describe("trimVkFormattedMessage", () => {
  it("returns empty text when limit is zero or negative", () => {
    expect(trimVkFormattedMessage({ text: "hello" }, 0)).toEqual({ text: "" });
    expect(trimVkFormattedMessage({ text: "hello" }, -5)).toEqual({ text: "" });
  });

  it("returns the same object when message already fits within limit", () => {
    const message = {
      text: "hello",
      formatData: { version: 1 as const, items: [{ type: "bold" as const, offset: 0, length: 5 }] },
    };

    const trimmed = trimVkFormattedMessage(message, 5);
    expect(trimmed).toBe(message);
  });

  it("trims plain text when no format data exists", () => {
    expect(trimVkFormattedMessage({ text: "hello world" }, 5)).toEqual({ text: "hello" });
  });

  it("trims and clamps format ranges to the new text limit", () => {
    const message = {
      text: "hello world",
      formatData: {
        version: 1 as const,
        items: [
          { type: "bold" as const, offset: 0, length: 5 },
          { type: "italic" as const, offset: 6, length: 5 },
          { type: "url" as const, offset: 6, length: 5, url: "https://example.com" },
        ],
      },
    };

    expect(trimVkFormattedMessage(message, 8)).toEqual({
      text: "hello wo",
      formatData: {
        version: 1,
        items: [
          { type: "bold", offset: 0, length: 5 },
          { type: "italic", offset: 6, length: 2 },
          { type: "url", offset: 6, length: 2, url: "https://example.com" },
        ],
      },
    });
  });

  it("removes format data when all items fall outside the trimmed text", () => {
    const message = {
      text: "hello world",
      formatData: {
        version: 1 as const,
        items: [{ type: "bold" as const, offset: 8, length: 3 }],
      },
    };

    expect(trimVkFormattedMessage(message, 5)).toEqual({ text: "hello" });
  });

  it("drops zero-length formatting items produced after trimming", () => {
    const message = {
      text: "abcd",
      formatData: {
        version: 1 as const,
        items: [{ type: "bold" as const, offset: 1, length: 0 }],
      },
    };

    expect(trimVkFormattedMessage(message, 2)).toEqual({ text: "ab" });
  });
});
