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
  /** Текущий получатель сигнала. Хранится на транспорте, чтобы повторная
   *  инструментовка перепривязывала колбэк, а не молча теряла новый. */
  __vkPollProbe?: () => void;
};

type UpdatesLike = {
  pollingTransport?: PollingTransportLike;
  start?: (...args: unknown[]) => Promise<unknown>;
  startPolling?: (...args: unknown[]) => Promise<unknown>;
  __vkStartInstrumented?: boolean;
  __vkLatestProbe?: () => void;
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
  const target = updates as UpdatesLike | undefined;
  if (!target) {
    return false;
  }
  // Переживаем смену транспорта. Внутренний рестарт vk-io объект не
  // пересоздаёт (`PollingTransport.stop()/start()` на том же экземпляре), но
  // `Updates.start()` — создаёт новый. Обёртка, поставленная на прежний,
  // осталась бы на выброшенном объекте, и канал молча лишился бы признака
  // живости: сторож тишины через свой порог объявил бы здоровый канал мёртвым.
  // Поэтому подшиваемся к самим методам старта и переинструментовываем после
  // каждого.
  target.__vkLatestProbe = onPollCompleted;
  if (!target.__vkStartInstrumented) {
    for (const name of ["start", "startPolling"] as const) {
      const original = target[name];
      if (typeof original !== "function") {
        continue;
      }
      target[name] = async (...args: unknown[]) => {
        const result = await original.apply(target, args);
        // Колбэк берём не захваченный, а текущий: инструментовка могла быть
        // переставлена после этой обёртки.
        attachPollProbe(target, target.__vkLatestProbe ?? onPollCompleted);
        return result;
      };
    }
    target.__vkStartInstrumented = true;
  }
  return attachPollProbe(target, onPollCompleted);
}

/** Ставит обёртку на текущий транспорт. Повторный вызов безопасен. */
function attachPollProbe(target: UpdatesLike, onPollCompleted: () => void): boolean {
  const transport = target.pollingTransport;
  if (typeof transport?.fetchUpdates !== "function") {
    return false;
  }
  // Уже обёрнут — перепривязываем получателя. Ранний `return true` без этого
  // означал бы: вызывающий видит успех, вооружает сторож тишины, а сигнал
  // уходит прежнему (мёртвому) колбэку — здоровый канал через порог тишины
  // объявляется мёртвым, и так по кругу.
  transport.__vkPollProbe = onPollCompleted;
  if (transport.__vkPollInstrumented) {
    return true;
  }
  const original = transport.fetchUpdates;
  transport.fetchUpdates = async (...args) => {
    const result = await original.apply(transport, args);
    transport.__vkPollProbe?.();
    return result;
  };
  transport.__vkPollInstrumented = true;
  return true;
}
