/**
 * Сигнал живости long-poll транспорта.
 *
 * Задача: понять, что цикл опроса действительно работает. Косвенные признаки
 * не годятся и дают ложное «здоров» на залипшем канале:
 *
 * - `updates.isStarted` остаётся `true`, пока объект не остановлен явно;
 * - курсор `ts` двигается по СОБЫТИЯМ, а не по опросам, поэтому на тихом
 *   канале стоит на месте часами;
 * - `groups.getById()` подтверждает лишь, что токен и обычный VK API живы.
 *
 * Честный признак один: HTTP-запрос за обновлениями вернулся. В vk-io это
 * `PollingTransport.fetchUpdates()`, вызываемый в цикле, — его и оборачиваем.
 * Обёртка узкая и не меняет поведения: возврат и ошибки пробрасываются как
 * есть (сам метод по контракту vk-io возвращает void), а сигнал даётся только
 * на успешное завершение запроса — в том числе когда событий не пришло.
 *
 * ⚠️ Ставить обёртку можно только ПОСЛЕ `updates.start()`: он пересоздаёт
 * транспорт, и патч, наложенный раньше, останется на выброшенном объекте.
 */

type PollingTransportLike = {
  fetchUpdates?: (...args: unknown[]) => Promise<unknown>;
  __vkPollInstrumented?: boolean;
};

/**
 * @returns `true`, если сигнал удалось снять. `false` означает, что транспорт
 * другой формы (например, vk-io сменил внутреннее устройство) — вызывающий код
 * обязан сказать об этом в лог, а не делать вид, что канал под наблюдением.
 */
export function instrumentPollingTransport(
  updates: unknown,
  onPollCompleted: () => void,
): boolean {
  const transport = (updates as { pollingTransport?: PollingTransportLike })
    ?.pollingTransport;
  if (typeof transport?.fetchUpdates !== "function") {
    return false;
  }
  if (transport.__vkPollInstrumented) {
    return true;
  }
  const original = transport.fetchUpdates;
  transport.fetchUpdates = async (...args) => {
    const result = await original.apply(transport, args);
    onPollCompleted();
    return result;
  };
  transport.__vkPollInstrumented = true;
  return true;
}
