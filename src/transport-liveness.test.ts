import { describe, expect, it, vi } from "vitest";

import { instrumentPollingTransport } from "./transport-liveness.js";

describe("instrumentPollingTransport", () => {
  it("сигналит на каждый завершённый опрос, включая пустой ответ", async () => {
    const onPoll = vi.fn();
    const fetchUpdates = vi.fn().mockResolvedValue(undefined); // пустой ответ
    const updates = { pollingTransport: { fetchUpdates } };

    expect(instrumentPollingTransport(updates, onPoll)).toBe(true);

    await (updates.pollingTransport.fetchUpdates as () => Promise<unknown>)();
    await (updates.pollingTransport.fetchUpdates as () => Promise<unknown>)();

    // Именно это отличает живой транспорт от залипшего: курсор ts на тихом
    // канале не двигается, а завершённые опросы — идут.
    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(fetchUpdates).toHaveBeenCalledTimes(2);
  });

  it("не сигналит, когда опрос упал", async () => {
    const onPoll = vi.fn();
    const fetchUpdates = vi.fn().mockRejectedValue(new Error("network down"));
    const updates = { pollingTransport: { fetchUpdates } };
    instrumentPollingTransport(updates, onPoll);

    await expect(
      (updates.pollingTransport.fetchUpdates as () => Promise<unknown>)(),
    ).rejects.toThrow("network down");
    expect(onPoll).not.toHaveBeenCalled();
  });

  it("не оборачивает дважды", () => {
    const onPoll = vi.fn();
    const original = vi.fn().mockResolvedValue(undefined);
    const updates = { pollingTransport: { fetchUpdates: original } };

    instrumentPollingTransport(updates, onPoll);
    const afterFirst = updates.pollingTransport.fetchUpdates;
    instrumentPollingTransport(updates, onPoll);

    expect(updates.pollingTransport.fetchUpdates).toBe(afterFirst);
  });

  it("честно сообщает, что снять сигнал не вышло", () => {
    // Транспорт другой формы — молча делать вид, что канал под наблюдением,
    // нельзя: вызывающий код обязан узнать об этом и сказать в лог.
    expect(instrumentPollingTransport({}, vi.fn())).toBe(false);
    expect(instrumentPollingTransport({ pollingTransport: {} }, vi.fn())).toBe(false);
  });

  it("сигналит после завершения запроса, а не до", async () => {
    // Порядок важен: пометить активность раньше, чем запрос вернулся, значит
    // считать живым транспорт, который завис на середине опроса.
    const order: string[] = [];
    const updates = {
      pollingTransport: {
        fetchUpdates: vi.fn(async () => {
          order.push("fetch");
        }),
      },
    };
    instrumentPollingTransport(updates, () => order.push("signal"));

    await (updates.pollingTransport.fetchUpdates as () => Promise<unknown>)();

    expect(order).toEqual(["fetch", "signal"]);
  });
});
