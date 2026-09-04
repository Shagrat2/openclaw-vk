import { describe, expect, it, vi } from "vitest";

import { compareCoreVersions, readCoreConfig } from "./sdk-compat.js";

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

describe("readCoreConfig — метод группы config зависит от версии ядра", () => {
  it("на 2026.8 берёт конфиг через current()", () => {
    const cfg = { channels: { vk: {} } };
    const loadConfig = vi.fn();
    expect(readCoreConfig({ config: { current: () => cfg, loadConfig } })).toBe(cfg);
    // На новом ядре к устаревшему методу обращаться нельзя: в 8.x его нет
    // вовсе, и обращение к нему означало бы, что порядок проверок перевёрнут.
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("на 2026.7 откатывается на loadConfig()", () => {
    const cfg = { channels: { vk: {} } };
    expect(readCoreConfig({ config: { loadConfig: () => cfg } })).toBe(cfg);
  });

  it("возвращает undefined, а не падает, если группы нет вовсе", () => {
    // Падение здесь стоило бы дорого: вызов сидит на пути входящего сообщения.
    expect(readCoreConfig(undefined)).toBeUndefined();
    expect(readCoreConfig(null)).toBeUndefined();
    expect(readCoreConfig({})).toBeUndefined();
    expect(readCoreConfig({ config: {} })).toBeUndefined();
  });
});
