// Пространством имён, а не поимённо: `channelReadyPatch`/`channelStoppedPatch`
// появились только в 2026.8, а именованный импорт отсутствующего символа роняет
// загрузку модуля целиком — канал при этом молча исчезает, без внятной ошибки.
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";

/**
 * Статус-патчи жизненного цикла аккаунта.
 *
 * Кто перезапускает канал, от версии НЕ зависит: политика ядра (5с → 5мин,
 * фактор 2, десять попыток, сброс счётчика после стабильного прогона) одна и та
 * же в 2026.7 и 2026.8 — проверено по сборкам обеих. Отличается только словарь
 * статуса: поле `lifecycle` и два строителя патчей завезли в 8.x.
 *
 * Поэтому здесь не развилка алгоритма, а развилка словаря: на новом ядре зовём
 * строителей ядра, на старом собираем тот же патч без `lifecycle`, которого
 * снимок аккаунта 7.x не знает.
 *
 * core-compat: 2026.7 · ветки-запасные варианты · снять, когда
 * `openclaw.compat.minGatewayVersion` станет >= 2026.8.1 — тогда модуль исчезает
 * целиком, а `monitor.ts` снова импортирует `channelReadyPatch`/
 * `channelStoppedPatch` из `openclaw/plugin-sdk/gateway-runtime` поимённо.
 */
type StatusPatch = Record<string, unknown>;

export function channelReadyStatusPatch(extras: StatusPatch = {}): StatusPatch {
  return gatewayRuntime.channelReadyPatch
    ? gatewayRuntime.channelReadyPatch(extras)
    : {
        running: true,
        connected: true,
        lastConnectedAt: Date.now(),
        lastError: null,
        ...extras,
      };
}

export function channelStoppedStatusPatch(extras: StatusPatch = {}): StatusPatch {
  return gatewayRuntime.channelStoppedPatch
    ? gatewayRuntime.channelStoppedPatch(extras)
    : { running: false, connected: false, ...extras };
}
