import { beforeEach, describe, expect, it, vi } from "vitest";

// Строителей патчей на 2026.7 в SDK нет вовсе; мок с настраиваемым набором
// экспортов позволяет проверить обе ветки словаря, а не только текущую.
const gatewayRuntimeMock = vi.hoisted(() => ({
  channelReadyPatch: undefined as unknown,
  channelStoppedPatch: undefined as unknown,
}));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => gatewayRuntimeMock);

const { channelReadyStatusPatch, channelStoppedStatusPatch } = await import("./status-patches.js");

describe("статус-патчи жизненного цикла", () => {
  beforeEach(() => {
    gatewayRuntimeMock.channelReadyPatch = undefined;
    gatewayRuntimeMock.channelStoppedPatch = undefined;
  });

  describe("на ядре 2026.8 (строители есть)", () => {
    it("зовёт строителя ядра и не собирает патч сам", () => {
      const built = { running: true, lifecycle: "ready" };
      const ready = vi.fn(() => built);
      gatewayRuntimeMock.channelReadyPatch = ready;

      expect(channelReadyStatusPatch({ mode: "longpoll" })).toBe(built);
      expect(ready).toHaveBeenCalledWith({ mode: "longpoll" });
    });
  });

  describe("на ядре 2026.7 (строителей нет)", () => {
    it("собирает эквивалент готовности без поля lifecycle", () => {
      const patch = channelReadyStatusPatch({ mode: "longpoll" });
      expect(patch).toMatchObject({ running: true, connected: true, lastError: null, mode: "longpoll" });
      // `lifecycle` снимок аккаунта 2026.7 не знает — публиковать его нельзя.
      expect(patch).not.toHaveProperty("lifecycle");
      expect(typeof patch.lastConnectedAt).toBe("number");
    });

    it("собирает эквивалент остановки и пропускает поля вызывающего", () => {
      const patch = channelStoppedStatusPatch({ lastError: "silent" });
      expect(patch).toEqual({ running: false, connected: false, lastError: "silent" });
    });

    it("даёт вызывающему перебить умолчания", () => {
      expect(channelReadyStatusPatch({ connected: false })).toMatchObject({ connected: false });
    });
  });
});
