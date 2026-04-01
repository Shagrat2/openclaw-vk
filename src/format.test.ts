import { describe, expect, it } from "vitest";
import { renderVkMarkdown } from "./format.js";

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

  it("does not format inside inline code", () => {
    const input = "Code `**no**` and **yes**";
    const result = renderVkMarkdown(input);

    expect(result.text).toBe("Code `**no**` and yes");
    expect(result.formatData?.items).toEqual(
      expect.arrayContaining([{ type: "bold", offset: result.text.indexOf("yes"), length: 3 }]),
    );
    expect(result.formatData?.items).toHaveLength(1);
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
});
