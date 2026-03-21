import { describe, expect, it } from "vitest";
import {
  buildVkButtonsFromTextMenu,
  buildVkKeyboard,
  buildVkKeyboardRemoval,
  normalizeVkButtons,
  resolveVkButtonsFromPayload,
  resolveVkCommandFromPayload,
} from "./keyboard.js";

describe("buildVkButtonsFromTextMenu", () => {
  it("builds provider buttons from /models provider list text", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Providers:",
        "- anthropic (2)",
        "- openai (3)",
        "",
        "Use: /models <provider>",
        "Switch: /model <provider/model>",
      ].join("\n"),
    );

    expect(buttons).toEqual([
      [
        { text: "anthropic", callback_data: "/models anthropic", style: "primary" },
        { text: "openai", callback_data: "/models openai", style: "primary" },
      ],
    ]);
  });

  it("builds model, pagination, and back buttons from model list text", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Models (anthropic · 🔑 env) — showing 21-24 of 48 (page 2/3)",
        "- anthropic/claude-opus-4-5",
        "- anthropic/claude-sonnet-4-5",
        "",
        "Switch: /model <provider/model>",
        "More: /models anthropic 3",
      ].join("\n"),
    );

    expect(buttons).toEqual([
      [
        {
          text: "claude-opus-4-5",
          callback_data: "/model anthropic/claude-opus-4-5",
          style: "primary",
        },
        {
          text: "claude-sonnet-4-5",
          callback_data: "/model anthropic/claude-sonnet-4-5",
          style: "primary",
        },
      ],
      [
        { text: "Prev", callback_data: "/models anthropic 1", style: "secondary" },
        { text: "Next", callback_data: "/models anthropic 3", style: "secondary" },
      ],
      [{ text: "Providers", callback_data: "/models", style: "secondary" }],
    ]);
  });

  it("builds browse button from /model summary text", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Current: anthropic/claude-opus-4-5",
        "",
        "Switch: /model <provider/model>",
        "Browse: /models (providers) or /models <provider> (models)",
        "More: /model status",
      ].join("\n"),
    );

    expect(buttons).toEqual([
      [{ text: "Browse providers", callback_data: "/models", style: "primary" }],
    ]);
  });

  it("builds /think buttons from current thinking level status text", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Current thinking level: high.",
        "Options: off, minimal, low, medium, high, adaptive.",
      ].join("\n"),
    );

    expect(buttons).toEqual([
      [
        { text: "off", callback_data: "/think off", style: "secondary" },
        { text: "minimal", callback_data: "/think minimal", style: "secondary" },
        { text: "low", callback_data: "/think low", style: "secondary" },
        { text: "medium", callback_data: "/think medium", style: "secondary" },
      ],
      [
        { text: "high", callback_data: "/think high", style: "success" },
        { text: "adaptive", callback_data: "/think adaptive", style: "secondary" },
      ],
    ]);
  });

  it("resolves 'thinking' alias to /think command", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Current thinking level: medium.",
        "Options: off, low, medium, high.",
      ].join("\n"),
    );

    expect(buttons).toBeDefined();
    const callbacks = buttons!.flat().map((b) => b.callback_data);
    expect(callbacks).toContain("/think off");
    expect(callbacks).toContain("/think medium");
    // Ensure it's /think, not /thinking
    expect(callbacks.every((cb) => !cb.startsWith("/thinking"))).toBe(true);
  });

  it("builds /fast buttons from status text with config suffix", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "⚙️ Current fast mode: on (config).",
        "Options: on, off.",
      ].join("\n"),
    );

    expect(buttons).toEqual([
      [
        { text: "on", callback_data: "/fast on", style: "success" },
        { text: "off", callback_data: "/fast off", style: "secondary" },
      ],
    ]);
  });

  it("packs provider buttons by label width instead of a fixed four-per-row layout", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Providers:",
        "- bailian (1)",
        "- github-copilot (1)",
        "- kilocode (1)",
        "- openai-codex (1)",
        "- openrouter (1)",
      ].join("\n"),
    );

    expect(buttons).toEqual([
      [
        { text: "bailian", callback_data: "/models bailian", style: "primary" },
        { text: "github-copilot", callback_data: "/models github-copilot", style: "primary" },
        { text: "kilocode", callback_data: "/models kilocode", style: "primary" },
      ],
      [
        { text: "openai-codex", callback_data: "/models openai-codex", style: "primary" },
        { text: "openrouter", callback_data: "/models openrouter", style: "primary" },
      ],
    ]);
  });

  it("packs long status options into narrower rows when four buttons would be too wide", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Current elevated permission: ask.",
        "Options: off, ask, auto, on-failure, always.",
      ].join("\n"),
    );

    expect(buttons).toEqual([
      [
        { text: "off", callback_data: "/elevated off", style: "secondary" },
        { text: "ask", callback_data: "/elevated ask", style: "success" },
        { text: "auto", callback_data: "/elevated auto", style: "secondary" },
      ],
      [
        { text: "on-failure", callback_data: "/elevated on-failure", style: "secondary" },
        { text: "always", callback_data: "/elevated always", style: "secondary" },
      ],
    ]);
  });
});

describe("buildVkKeyboard", () => {
  it("serializes buttons into a one-time VK keyboard", () => {
    const keyboard = buildVkKeyboard([
      [{ text: "Browse providers", callback_data: "/models", style: "primary" }],
    ]);
    expect(keyboard).toBeDefined();

    const parsed = JSON.parse(keyboard ?? "{}") as {
      one_time: boolean;
      buttons: Array<Array<{ action: { label: string; payload: string }; color: string }>>;
    };
    expect(parsed.one_time).toBe(true);
    expect(parsed.buttons[0]?.[0]?.action.label).toBe("Browse providers");
    expect(parsed.buttons[0]?.[0]?.color).toBe("primary");
    expect(parsed.buttons[0]?.[0]?.action.payload).toBe(JSON.stringify({ oc: "/models" }));
  });

  it("truncates long labels and drops oversize payloads", () => {
    const keyboard = buildVkKeyboard([
      [
        {
          text: "this-model-name-is-definitely-long-enough-to-be-truncated-at-forty-characters",
          callback_data: "/models openai",
          style: "primary",
        },
        {
          text: "Too long payload",
          callback_data: `/model openai/${"x".repeat(300)}`,
          style: "primary",
        },
      ],
    ]);

    const parsed = JSON.parse(keyboard ?? "{}") as {
      buttons: Array<Array<{ action: { label: string } }>>;
    };
    expect(parsed.buttons).toHaveLength(1);
    expect(parsed.buttons[0]).toHaveLength(1);
    expect(parsed.buttons[0]?.[0]?.action.label.length).toBeLessThanOrEqual(40);
  });

  it("serializes an empty keyboard when the menu should be cleared", () => {
    expect(buildVkKeyboardRemoval()).toBe(
      JSON.stringify({
        one_time: false,
        buttons: [],
      }),
    );
  });
});

describe("payload helpers", () => {
  it("reads explicit vk buttons from payload", () => {
    const buttons = resolveVkButtonsFromPayload({
      text: "ignored",
      channelData: {
        vk: {
          buttons: [[{ text: "Go", callback_data: "/models", style: "success" }]],
        },
      },
    });

    expect(buttons).toEqual([
      [{ text: "Go", callback_data: "/models", style: "success" }],
    ]);
  });

  it("falls back to text menu parsing when no explicit buttons", () => {
    const buttons = resolveVkButtonsFromPayload({
      text: [
        "Providers:",
        "- openai (3)",
      ].join("\n"),
    });

    expect(buttons).toEqual([
      [{ text: "openai", callback_data: "/models openai", style: "primary" }],
    ]);
  });

  it("returns undefined for null/non-object payload", () => {
    expect(resolveVkButtonsFromPayload(null)).toBeUndefined();
    expect(resolveVkButtonsFromPayload(undefined)).toBeUndefined();
    expect(resolveVkButtonsFromPayload("string")).toBeUndefined();
    expect(resolveVkButtonsFromPayload([])).toBeUndefined();
  });

  it("normalizes button rows and reads OpenClaw command payloads", () => {
    expect(
      normalizeVkButtons([[{ text: "  Go  ", callback_data: "  /models  ", style: "primary" }]]),
    ).toEqual([[{ text: "Go", callback_data: "/models", style: "primary" }]]);
    expect(resolveVkCommandFromPayload({ oc: "/models anthropic" })).toBe("/models anthropic");
  });

  it("normalizeVkButtons returns undefined for non-array input", () => {
    expect(normalizeVkButtons("string")).toBeUndefined();
    expect(normalizeVkButtons(null)).toBeUndefined();
    expect(normalizeVkButtons({})).toBeUndefined();
  });

  it("normalizeVkButtons filters out invalid buttons", () => {
    expect(normalizeVkButtons([[{ text: "", callback_data: "/cmd" }]])).toBeUndefined();
    expect(normalizeVkButtons([[{ text: "label" }]])).toBeUndefined();
    expect(normalizeVkButtons([[null, undefined, 42]])).toBeUndefined();
  });

  it("normalizeVkButtons limits rows and buttons per row", () => {
    const manyRows = Array.from({ length: 15 }, (_, i) => [
      { text: `btn${i}`, callback_data: `/cmd${i}` },
    ]);
    const result = normalizeVkButtons(manyRows);
    expect(result!.length).toBeLessThanOrEqual(10);

    const manyButtons = [
      Array.from({ length: 8 }, (_, i) => ({
        text: `b${i}`,
        callback_data: `/c${i}`,
      })),
    ];
    const result2 = normalizeVkButtons(manyButtons);
    expect(result2![0].length).toBeLessThanOrEqual(4);
  });

  it("normalizeVkButtons normalizes unknown style to undefined", () => {
    const result = normalizeVkButtons([
      [{ text: "Go", callback_data: "/cmd", style: "fancy" }],
    ]);
    expect(result![0][0].style).toBeUndefined();
  });

  it("resolveVkCommandFromPayload returns undefined for non-object/null/array", () => {
    expect(resolveVkCommandFromPayload(null)).toBeUndefined();
    expect(resolveVkCommandFromPayload(undefined)).toBeUndefined();
    expect(resolveVkCommandFromPayload([])).toBeUndefined();
  });

  it("resolveVkCommandFromPayload returns undefined for empty/whitespace command", () => {
    expect(resolveVkCommandFromPayload({ oc: "" })).toBeUndefined();
    expect(resolveVkCommandFromPayload({ oc: "   " })).toBeUndefined();
    expect(resolveVkCommandFromPayload({ oc: 42 })).toBeUndefined();
  });
});

describe("buildVkKeyboard edge cases", () => {
  it("returns undefined for empty or no buttons", () => {
    expect(buildVkKeyboard(undefined)).toBeUndefined();
    expect(buildVkKeyboard([])).toBeUndefined();
  });

  it("maps success style to positive color", () => {
    const keyboard = buildVkKeyboard([
      [{ text: "OK", callback_data: "/ok", style: "success" }],
    ]);
    const parsed = JSON.parse(keyboard!);
    expect(parsed.buttons[0][0].color).toBe("positive");
  });

  it("maps danger style to negative color", () => {
    const keyboard = buildVkKeyboard([
      [{ text: "Cancel", callback_data: "/cancel", style: "danger" }],
    ]);
    const parsed = JSON.parse(keyboard!);
    expect(parsed.buttons[0][0].color).toBe("negative");
  });

  it("defaults to secondary color for unknown/missing style", () => {
    const keyboard = buildVkKeyboard([
      [{ text: "Test", callback_data: "/test" }],
    ]);
    const parsed = JSON.parse(keyboard!);
    expect(parsed.buttons[0][0].color).toBe("secondary");
  });
});

describe("buildVkButtonsFromTextMenu edge cases", () => {
  it("returns undefined for empty string", () => {
    expect(buildVkButtonsFromTextMenu("")).toBeUndefined();
    expect(buildVkButtonsFromTextMenu("   ")).toBeUndefined();
  });

  it("returns undefined for non-matching text", () => {
    expect(buildVkButtonsFromTextMenu("Just a normal message.")).toBeUndefined();
  });

  it("parses 'Available providers:' header format", () => {
    const buttons = buildVkButtonsFromTextMenu(
      ["Available providers:", "- openai (2)"].join("\n"),
    );
    expect(buttons).toEqual([
      [{ text: "openai", callback_data: "/models openai", style: "primary" }],
    ]);
  });

  it("builds first-page model buttons (no Prev, has Next)", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Models (openai · 🔑 env) — showing 1-4 of 8 (page 1/2)",
        "- openai/gpt-4o",
        "",
        "Switch: /model <provider/model>",
      ].join("\n"),
    );
    expect(buttons).toBeDefined();
    const navRow = buttons!.find((row) =>
      row.some((btn) => btn.text === "Next" || btn.text === "Prev"),
    );
    expect(navRow).toBeDefined();
    expect(navRow!.some((btn) => btn.text === "Prev")).toBe(false);
    expect(navRow!.some((btn) => btn.text === "Next")).toBe(true);
  });

  it("builds last-page model buttons (has Prev, no Next)", () => {
    const buttons = buildVkButtonsFromTextMenu(
      [
        "Models (openai · 🔑 env) — showing 5-8 of 8 (page 2/2)",
        "- openai/gpt-4o-mini",
        "",
        "Switch: /model <provider/model>",
      ].join("\n"),
    );
    expect(buttons).toBeDefined();
    const navRow = buttons!.find((row) =>
      row.some((btn) => btn.text === "Next" || btn.text === "Prev"),
    );
    expect(navRow).toBeDefined();
    expect(navRow!.some((btn) => btn.text === "Prev")).toBe(true);
    expect(navRow!.some((btn) => btn.text === "Next")).toBe(false);
  });
});
