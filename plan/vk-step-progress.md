# План: VK step-progress — лента шагов в одном редактируемом сообщении

**Легенда статусов:** ⬜ TODO · 🟨 WIP · ✅ DONE · ❓ OPEN (проверить) · ⏭️ SKIP

**Цель.** В VK показывать **живые шаги выполнения** (вызовы тулзов: `🛠️ Bash`,
`🔎 Web Search`, `📄 Read`…) в **одном сообщении, которое редактируется на месте**
до финального ответа — как `streaming.mode: "progress"` в Telegram.

**Скоуп (сузили с Иваном 21.07):** только VK · только шаги действий (модель с
`thinking off`, `reasoning_content` пуст — рассуждений нет) · **opt-in** через конфиг,
дефолт не меняем (остаётся текущий режим эмодзи-реакций).

---

## Не изобретаем велосипед (итог разведки ядра 2026.7.1)

Ядро **уже владеет** сложной частью edit-in-place черновика (гейт задержки старта,
дедуп строк, усечение, парсинг, рендер, finalize) в переиспользуемом стейт-машине:

- **`createChannelProgressDraftCompositor`** — импорт из `openclaw/plugin-sdk/channel-message`
  (есть `channel-message.d.ts`; реализация `channel-outbound-*.js:575`). Владеет
  lifecycle черновика, зовёт наш `update(text)` / `deleteCurrent()`, кормится нашими
  `pushToolProgress` / `pushReasoningProgress` / `noteActivity`, финализируется
  `markFinalReplyStarted()` / `markFinalReplyDelivered()`.
- **`StreamingConfigSchema` / `StreamingProgressSchema`** — уже в SDK
  (`plugin-sdk/bundled-channel-config-schema`, символы `StreamingConfigSchema`,
  `StreamingModeSchema`, `StreamingPreviewSchema`, `StreamingProgressSchema`). Конфиг
  **не пишем руками** — переиспользуем.
- **`resolveChannelPreviewStreamMode(entry, default)`** — резолв `channels.<x>.streaming.mode`
  (`streaming-*.js`). Просто зовём.
- **Образец в нашем форке:** `src/reactions-controller.ts` — тонкий адаптер над core-SDK
  (`createStatusReactionController`). `src/progress-draft.ts` делаем **по тому же лекалу**.
- **Образец в ядре (зеркалим 1:1):** Telegram — `telegram-ingress-spool-*.js:6996`
  (создаёт компоновщик, `update → answerLane.stream.updatePreview`, финал —
  `editMessageTelegram` :7534). Discord — `message-handler.process-*.js:603/1278`.

Итог: VK даёт **только** VK-примитив `messages.edit` + проводку колбэков. Всё остальное — ядро.

---

## Шаги

### Ш0 · Разведка и предпроверки
- ✅ Найден core-компоновщик, SDK-схемы, Telegram-образец, точки проводки (рефы внизу).
- ❓ **blockStreaming vs progress.** Сейчас `capabilities.blockStreaming:true`
  (`channel.ts:191`, `channel.setup.ts:38`). В ядре `streaming.mode:"block"` + block-enabled
  **ОТКЛючает** draft (Discord: `accountBlockStreamingEnabled ⇒ draftStream=undefined`,
  `message-handler.process-*.js:575`). Проверить: при `streaming.mode:"progress"` draft
  работает несмотря на capability `blockStreaming:true`, или capability надо снять/не
  конфликтует. Определить до Ш6.
- ❓ **Точный import-путь SDK streaming-схемы** (`openclaw/plugin-sdk/channel-config-schema`
  vs `.../bundled-channel-config-schema`) и форма (`StreamingConfigSchema`).

### Ш1 · VK-примитив edit/delete в `src/send.ts` ✅ (send.test 133/133)
- Добавить `editMessageVk(peerId, conversationMessageId, text, account, opts?)` над
  `vk.api.messages.edit({ peer_id, conversation_message_id, message, keep_forward_messages:1 })`.
- Добавить `deleteMessageVk` (или reuse) для `deleteCurrent`.
- Стиль/ошибки — как `sendMessageVk` (тот же клиент из `vkInstances`, error→honest fallback).
- Учесть лимиты VK: окно редактирования (сообщение свежее), нельзя чужие, правила вложений.
- Тест в `src/send.test.ts`.

### Ш2 · `src/progress-draft.ts` — адаптер над core-компоновщиком ✅ (progress-draft.test 6/6)
- Скопировать структуру `reactions-controller.ts` (тонкая фабрика).
- `import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-message"`.
- adapter: `update(text)` → `editMessageVk` (ленивое создание черновика первым `sendMessageVk`,
  запомнить `conversation_message_id`); `deleteCurrent()` → `deleteMessageVk`.
- `formatLine: formatVkProgressLine` (маппинг имён тулзов → иконки), `reasoningLinePrefix`
  и пр. — как Telegram.
- Экспорт `createVkProgressDraftCompositor(params)`.
- Тест `src/progress-draft.test.ts` (гейт задержки, троттл/дедуп, формат, finalize replace/keep).

### Ш3 · Конфиг-схема streaming в `src/config-schema.ts` ✅ (config-schema.test 28/28)

> SDK не экспортит полную `StreamingConfigSchema` (только `StreamingCoalesceSchema`),
> `buildChannelConfigSchema` streaming не инжектит → добавлена локальная минимальная
> `VkStreamingSchema` (`mode` + `preview.toolProgress`, `.passthrough()` для forward-compat).
- Импортировать готовую `StreamingConfigSchema` из SDK (см. Ш0 ❓), добавить
  `streaming: StreamingConfigSchema.optional()` в `VkAccountSchemaBase` (стр.43-56).
- Дефолт — текущее поведение (нет `streaming` ⇒ реакции/off). Ничего не ломается.
- Тест `src/config-schema.test.ts`.

### Ш4 · Развилка в `src/inbound.ts` (replyOptions) ⬜
- Резолв режима: `resolveChannelPreviewStreamMode(vkCfg)`.
- `"progress"` → создать компоновщик (Ш2), завести колбэки на него вместо реакций:
  `onReplyStart → noteActivity`, `onToolStart → pushToolProgress`,
  `onReasoningStream → pushReasoningProgress`, `onItemEvent`/`onCommandOutput → pushToolProgress`.
  Сохранить `suppressDefaultToolProgressMessages:true` +
  `allowProgressCallbacksWhenSourceDeliverySuppressed:true` (уже стоят, `inbound.ts:507-508`).
- `"reactions"`/дефолт → как сейчас (`statusReactions`, `createVkStatusReactionController`).
- Взаимоисключающе: либо реакции, либо draft (один прогресс-канал за раз).

### Ш5 · Finalize в deliver-пути ⬜
- В `deliverVkReply` / `onDispatch` (`inbound.ts:469-529`): на финальном payload вызвать
  `markFinalReplyStarted()` / `markFinalReplyDelivered()` и по `streaming.finalize`:
  `"replace"` → `editMessageVk` черновика в финальный текст; `"keep"` → оставить ленту
  (edit в progress-summary), финал — новым `sendMessageVk`.

### Ш6 · Capabilities в `src/channel.ts` + `src/channel.setup.ts` ❓ ОТЛОЖЕНО
- Разведка показала: `capabilities.edit` **используется в ядре ~23 раза** (влияет на
  роутинг доставки, не только статус). А наш progress-draft **драйвится вручную**
  (прямые `messages.edit`), capability-флаг в нашем пути НЕ участвует — ядро само draft
  для legacy-dispatch не создаёт. Значит `edit:true` **для фичи не требуется**, а объявить
  вслепую = риск переключить обычную доставку на edit-путь (VK-send его не поддерживает).
- **Решение:** не объявлять сейчас. Если позже захотим точного advertising — сперва
  проследить все 23 usage и убедиться в безопасности (или мигрировать на message-adapter).
- `blockStreaming:true` оставлен — мы задаём `mode:"progress"` вручную, он не форсит block.

### Ш7 · Сборка и манифест (грабли — было 2 раза) ✅
- `package.json` → `files[]`: добавлен `"src/progress-draft.ts"`.
- `scripts/build.mjs` → `entryPoints[]`: добавлен `"src/progress-draft.ts"`.
- `npm run build` → `dist/src/progress-draft.js` собран (SDK externalized). ✓

### Ш8 · Тесты ⬜
- `npm test` (vitest) зелёный; покрыть бизнес-правила новых модулей.

### Ш9 · Живой прогон ⬜
- Собрать, поставить (`plugins install … --force --pin` или симлинк dist), рестарт gateway.
- Включить `channels.vk.streaming.mode:"progress"`, написать боту в VK → увидеть ленту
  шагов в одном сообщении, финал заменяет/остаётся по `finalize`.

### Ш10 · CHANGELOG + версия ⬜
- `CHANGELOG.md`: новый `## vX`, `### Добавлено`, блоки «Кому важно» и «Что проверить
  после обновления» — стиль как в записи v2026.6.19.

---

## Гигиена (отдельными ветками, НЕ в этой)
- ⬜ Выпилить воркэраунд `VK_SERIALIZE_INBOUND` (`51bfd66`, `6ba8c06`) — ядро 2026.7.1 чинит
  mirror-transcript дедлок нативно (`b381559`), сериализация больше не нужна.
- ⬜ Причесать `main` форка (устарел на v2026.5.11, не догонял upstream 6.19).

---

## Рефы ядра (jump-to, dist 2026.7.1)
- `createChannelProgressDraftCompositor` — `channel-outbound-*.js:575`, экспорт
  `plugin-sdk/channel-message` (+ `.d.ts`).
- Гейт/режим — `streaming-*.js:372/488` (`resolveChannelPreviewStreamMode`,
  `DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS=5000`).
- Гейтинг колбэков — `dispatch-*.js:1942/2004-2041`.
- Telegram-образец — `telegram-ingress-spool-*.js:6996/7534`.
- Discord-образец — `message-handler.process-*.js:603/1278`.
- SDK streaming-схемы — `bundled-channel-config-schema-*.js`.
- live-capabilities (если позже мигрировать на adapter-путь) — `types-*.js:27-41`.

## База ветки
`feature/vk-step-progress` от `feature/status-reactions` (v2026.6.19, HEAD `93c6588` — текущее полное состояние форка).
