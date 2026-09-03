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
 * `PollingTransport.fetchUpdates()` — метод публичный, приватен только путь к
 * нему через `Updates.pollingTransport`. Его и оборачиваем: возврат и ошибки
 * пробрасываются как есть, сигнал даётся на успешное завершение запроса — в
 * том числе когда событий не пришло.
 *
 * ⚠️ Ставить обёртку можно только ПОСЛЕ `updates.start()`: он создаёт новый
 * транспорт, и патч, наложенный раньше, остался бы на выброшенном объекте.
 * Повторного `start()` в жизни монитора не бывает — при застое задача аккаунта
 * завершается, и ядро поднимает канал заново с новым `VK`. Внутренний рестарт
 * vk-io (`PollingTransport.stop()/start()`) работает на том же экземпляре, так
 * что обёртка его переживает.
 *
 * Состояние держим в модульных `WeakMap`/`WeakSet`, а не полями на чужом
 * объекте: так vk-io остаётся неразмеченным, а запись исчезает вместе с
 * транспортом.
 */
type PollingTransportLike = {
  fetchUpdates?: (...args: unknown[]) => Promise<unknown>;
};

type Probe = () => void;

const instrumented = new WeakSet<object>();
const probes = new WeakMap<object, Probe>();

/**
 * @returns `true`, если сигнал удалось снять. `false` означает, что транспорт
 * другой формы (например, vk-io сменил внутреннее устройство) — вызывающий код
 * обязан сказать об этом в лог, а не делать вид, что канал под наблюдением.
 */
export function instrumentPollingTransport(
  updates: unknown,
  onPollCompleted: Probe,
): boolean {
  const transport = (updates as { pollingTransport?: PollingTransportLike })
    ?.pollingTransport;
  if (typeof transport?.fetchUpdates !== "function") {
    return false;
  }
  // Перепривязываем получателя и при повторном вызове: ранний выход по флагу
  // означал бы, что вызывающий видит успех, вооружает сторож тишины, а сигнал
  // уходит прежнему колбэку.
  probes.set(transport, onPollCompleted);
  if (instrumented.has(transport)) {
    return true;
  }
  const original = transport.fetchUpdates;
  transport.fetchUpdates = async (...args) => {
    const result = await original.apply(transport, args);
    probes.get(transport)?.();
    return result;
  };
  instrumented.add(transport);
  return true;
}
