import { describe, expect, it } from "vitest";

import { compareCoreVersions } from "./sdk-compat.js";

describe("compareCoreVersions", () => {
  it("сравнивает по компонентам, а не лексикографически", () => {
    expect(compareCoreVersions("2026.8.1", "2026.7.1")).toBe(1);
    expect(compareCoreVersions("2026.7.1", "2026.8.1")).toBe(-1);
    expect(compareCoreVersions("2026.10.0", "2026.9.9")).toBe(1);
  });

  it("считает равными одинаковые версии и терпит суффикс сборки", () => {
    expect(compareCoreVersions("2026.8.1", "2026.8.1")).toBe(0);
    expect(compareCoreVersions("2026.7.1-2", "2026.7.1")).toBe(1);
  });

  it("не падает на мусорных компонентах", () => {
    expect(compareCoreVersions("2026.x.1", "2026.0.1")).toBe(0);
  });
});
