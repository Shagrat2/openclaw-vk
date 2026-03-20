import { describe, expect, it } from "vitest";
import {
  buildVkButtonsFromTextMenu,
  buildVkKeyboard,
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

  it("normalizes button rows and reads OpenClaw command payloads", () => {
    expect(
      normalizeVkButtons([[{ text: "  Go  ", callback_data: "  /models  ", style: "primary" }]]),
    ).toEqual([[{ text: "Go", callback_data: "/models", style: "primary" }]]);
    expect(resolveVkCommandFromPayload({ oc: "/models anthropic" })).toBe("/models anthropic");
  });
});
