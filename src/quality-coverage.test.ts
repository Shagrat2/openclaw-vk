import { describe, expect, it } from "vitest";
import {
  buildVkButtonsFromTextMenu,
  buildVkKeyboard,
  normalizeVkButtons,
} from "./keyboard.js";

describe("VK keyboard boundary contracts", () => {
  it("drops blank callback payloads instead of emitting an unusable keyboard", () => {
    const keyboard = buildVkKeyboard([
      [{ text: "Broken action", callback_data: "   ", style: "primary" }],
    ]);

    expect(keyboard).toBeUndefined();
  });

  it("discards malformed rows while preserving valid button rows", () => {
    const buttons = normalizeVkButtons([
      "not-a-row",
      [{ text: " OpenAI ", callback_data: " /models openai ", style: "PRIMARY" }],
    ]);

    expect(buttons).toEqual([
      [{ text: "OpenAI", callback_data: "/models openai", style: "primary" }],
    ]);
  });

  it("keeps whitespace, punctuation, and non-ASCII provider labels routable", () => {
    const buttons = buildVkButtonsFromTextMenu(
      ["Providers:", "- Open AI (3)", "- Яндекс/Облако (2)"].join("\n"),
    );

    expect(buttons).toEqual([
      [{ text: "Open AI", callback_data: "/models Open AI", style: "primary" }],
      [
        {
          text: "Яндекс/Облако",
          callback_data: "/models Яндекс/Облако",
          style: "primary",
        },
      ],
    ]);
  });

  it("rejects inferred buttons whose serialized command exceeds VK's payload limit", () => {
    const oversizedProvider = "я".repeat(150);

    expect(
      buildVkButtonsFromTextMenu(`Providers:\n- ${oversizedProvider} (1)`),
    ).toBeUndefined();
  });

  it("caps inferred menus at VK's ten-row limit", () => {
    const providers = Array.from(
      { length: 12 },
      (_, index) => `${"я".repeat(20)}${index}`,
    );
    const buttons = buildVkButtonsFromTextMenu(
      ["Providers:", ...providers.map((provider) => `- ${provider} (1)`)].join("\n"),
    );

    expect(buttons).toHaveLength(10);
    expect(buttons?.map((row) => row[0]?.callback_data)).toEqual(
      providers.slice(0, 10).map((provider) => `/models ${provider}`),
    );
  });

  it("does not guess a command from descriptors made only of stopwords", () => {
    expect(
      buildVkButtonsFromTextMenu("Current access status: high.\nOptions: low, high."),
    ).toBeUndefined();
  });

  it("does not create an options menu when the option list is empty", () => {
    expect(
      buildVkButtonsFromTextMenu("Current /think level: high.\nOptions: ."),
    ).toBeUndefined();
  });
});
