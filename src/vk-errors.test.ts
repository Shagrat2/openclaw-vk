import { describe, expect, it } from "vitest";

import { readVkErrorCode, readVkErrorMessage } from "./vk-errors.js";

describe("readVkErrorCode", () => {
  it("reads the code vk-io puts in `code`", () => {
    expect(readVkErrorCode({ code: 15 })).toBe(15);
  });

  it("reads the code vk-io puts in `error_code` instead", () => {
    // Different vk-io layers use different field names for the same thing;
    // reading only one of them is how a retryable failure looks permanent.
    expect(readVkErrorCode({ error_code: 100 })).toBe(100);
  });

  it("prefers `code` when both are present", () => {
    expect(readVkErrorCode({ code: 15, error_code: 100 })).toBe(15);
  });

  it("returns undefined for anything that is not an error object", () => {
    // The send path calls this on whatever was thrown, which can be a string,
    // null, or nothing at all — it must never throw here.
    expect(readVkErrorCode(null)).toBeUndefined();
    expect(readVkErrorCode(undefined)).toBeUndefined();
    expect(readVkErrorCode("boom")).toBeUndefined();
    expect(readVkErrorCode(42)).toBeUndefined();
    expect(readVkErrorCode({})).toBeUndefined();
    expect(readVkErrorCode({ code: "15" })).toBeUndefined();
  });
});

describe("readVkErrorMessage", () => {
  it("joins every field the failure text can hide in", () => {
    // `description` is where vk-io keeps permission failures; reading only
    // `message` lost exactly the text that explains the refusal.
    expect(
      readVkErrorMessage({
        message: "Access denied",
        name: "APIError",
        description: "no access to call this method",
      }),
    ).toBe("Access denied APIError no access to call this method");
  });

  it("skips absent and non-string fields", () => {
    expect(readVkErrorMessage({ message: "only this", name: 7 })).toBe("only this");
  });

  it("returns an empty string for anything that is not an error object", () => {
    expect(readVkErrorMessage(null)).toBe("");
    expect(readVkErrorMessage("boom")).toBe("");
    expect(readVkErrorMessage({})).toBe("");
  });
});
