# openclaw-vk
<img width="500" src="https://github.com/user-attachments/assets/1bb97849-8aa0-46dc-b3de-90e4bcf10d38"/>

Плагин [OpenClaw](https://github.com/openclaw/openclaw) для работы с ВКонтакте. Подключает AI-агента к сообществам VK через Bots Long Poll API — бот принимает и отвечает на сообщения в личных диалогах и групповых беседах.  
Минимальная требуемая версия OpenClaw: **v2026.3.28**

## Быстрый старт

### 1. Подготовка сообщества ВКонтакте

1. **Создайте сообщество** (группу или паблик), если его ещё нет.
2. Откройте **Управление → Сообщения** и включите их.
3. Откройте **Управление → Работа с API → Ключи доступа**, нажмите *Создать ключ* и выберите права:
   - **Сообщения сообщества**
   - **Управление сообществом** (необходимо для Bots Long Poll API)
   - **Документы** / `docs` (обязательно для исходящих файлов, TTS audio и голосовых сообщений, потому что VK upload идёт через `docs.getMessagesUploadServer`)
4. Откройте **Управление → Работа с API → Long Poll API**:
   - Включите Long Poll API.
   - На вкладке **Типы событий** отметьте **Входящие сообщения**.
5. *(Для работы в беседах)* Откройте **Управление → Сообщения → Настройки для бота** и включите *Разрешать добавлять сообщество в чаты*.

### 2. Установка плагина
```
Установи OpenClaw-плагин для vk чётко по инструкции https://github.com/pfrankov/openclaw-vk
Вот мой токен: vk1.a...
```

```bash
openclaw plugins install @openclaw-vk/vk
openclaw plugins enable vk
```

> Только для локальной разработки: `openclaw plugins install ~/path/to/openclaw-vk`

Примечание про `plugins.allow`:
- Если `plugins.allow` отсутствует или пуст, OpenClaw обычно подхватывает внешний плагин `vk` автоматически после `openclaw plugins enable vk` и включённого `channels.vk.enabled`.
- Если у вас уже используется явный allowlist плагинов (`plugins.allow` не пуст), добавьте туда `"vk"` вручную. Команда `openclaw plugins enable vk` сейчас не дописывает `plugins.allow` автоматически.

Пример для конфигураций с явным allowlist:

```json
{
  "plugins": {
    "allow": ["vk"]
  },
  "channels": {
    "vk": {
      "enabled": true,
      "token": "<ВАШ_ТОКЕН>",
      "dmPolicy": "pairing"
    }
  }
}
```

### 3. Настройка

Добавьте канал в `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "vk": {
      "enabled": true,
      "token": "<ВАШ_ТОКЕН>",
      "dmPolicy": "pairing"
    }
  }
}
```

### 4. Запуск

1. Перезапустите шлюз:
   ```bash
   openclaw gateway restart
   ```
2. Напишите боту любое сообщение со своего аккаунта ВКонтакте.
3. Бот ответит **кодом подтверждения** — это механизм авторизации `pairing`, защищающий от нежелательных сообщений.
4. Подтвердите доступ:
   ```bash
   openclaw pairing approve vk <код>
   ```

Готово — бот отвечает на сообщения.

---

## Конфигурация

### Форматирование сообщений

Входящие ответы обрабатываются как Markdown, но для VK конвертируется только то, что поддерживается `format_data`:
- `**жирный**`, `*курсив*`, `***жирный курсив***`
- `[текст](https://example.com)` (ссылка)

Вся остальная разметка остаётся без изменений.

### Параметры

| Параметр | Описание |
| --- | --- |
| `token` / `tokenFile` | Ключ доступа сообщества или путь к файлу с токеном. Также поддерживается переменная окружения `VK_TOKEN`. |
| `dmPolicy` | Политика личных сообщений: `pairing` (авторизация по коду), `allowlist` (по списку), `open` (без ограничений), `disabled`. |
| `allowFrom` | Список ID пользователей, которым разрешён доступ при политике `allowlist`. |
| `defaultTo` | Цель по умолчанию для исходящих сообщений, если target не был указан явно. |
| `groupPolicy` | Политика для групповых бесед: `allowlist`, `open`, `disabled`. |
| `groupAllowFrom` | Список ID пользователей, которым разрешено писать боту в групповых беседах при `groupPolicy: "allowlist"`. Это не список `peerId` бесед. |

### Настройка отдельных бесед

Для каждой беседы можно задать индивидуальные параметры:
- `enabled`: полностью отключить обработку конкретной беседы
- `allowFrom`: переопределить sender allowlist только для этой беседы
- `requireMention`: требовать упоминание бота
- `systemPrompt`: отдельный системный prompt для конкретного чата

```json
{
  "channels": {
    "vk": {
      "groups": {
        "2000000123": {
          "enabled": true,
          "allowFrom": [123456789],
          "requireMention": true,
          "systemPrompt": "Ты — помощник в рабочем чате. Отвечай кратко."
        },
        "*": {
          "requireMention": false
        }
      }
    }
  }
}
```

Если в беседе нужно разрешить сообщения только нескольким участникам, используйте `groups.<peerId>.allowFrom`. Это переопределяет общий `groupAllowFrom` для конкретного чата.

### Несколько сообществ

Для подключения нескольких ботов к одному ядру используйте секцию `accounts`:

```json
{
  "channels": {
    "vk": {
      "accounts": {
        "sales": {
          "enabled": true,
          "token": "<ТОКЕН_ПРОДАЖ>",
          "dmPolicy": "allowlist",
          "allowFrom": ["*"]
        },
        "support": {
          "enabled": true,
          "tokenFile": "/etc/openclaw/vk-support.token",
          "dmPolicy": "pairing"
        }
      }
    }
  }
}
```

---

## Решение проблем

Проверьте статус подключения:

```bash
openclaw channels status --json --probe
```

**`Group authorization failed: group revoke access for this token`** — ключ доступа устарел или отозван. Перевыпустите токен в настройках сообщества, обновите конфигурацию и перезапустите шлюз.

**Статус `running: false` при `configured: true`** — неверный токен. Подробности в поле `lastError` вывода команды статуса.

**`APIError: Code №15 - Access denied: no access to call this method. It cannot be called with current scopes.` при отправке аудио/документов** — у текущего community token нет права `docs`.

Как исправить:
1. Откройте сообщество во ВКонтакте.
2. Перейдите в **Управление → Дополнительно → Работа с API → Ключи доступа**.
3. Нажмите **Создать ключ**.
4. В списке прав обязательно отметьте:
   - **Сообщения сообщества** / `messages`
   - **Управление сообществом** / `manage`
   - **Документы** / `docs`
5. Подтвердите создание ключа в мобильном приложении VK.
6. Обновите `channels.vk.token` в `~/.openclaw/openclaw.json`.
7. Перезапустите шлюз:
   ```bash
   openclaw gateway restart
   ```

Проверка:
- `docs.getMessagesUploadServer` требует право `docs` и используется для `doc` и `audio_message`, поэтому без него исходящие файлы и голосовые не отправятся.
- Исходящие `audio/*` вложения плагин отправляет как `audio_message` (голосовое). Если нужен обычный файл, используйте `forceDocument`.
- Текущие права токена можно проверить через `groups.getTokenPermissions`.
- Если после обновления токена `groups.getTokenPermissions` показывает только `messages` и `manage`, создайте новый ключ заново и убедитесь, что `docs` отмечен при создании.

Официальная документация VK:
- Настройки community token: <https://dev.vk.com/ru/api/access-token/community-token/in-community-settings>
- Проверка прав токена: <https://dev.vk.com/ru/method/groups.getTokenPermissions>
- Upload для документов и голосовых: <https://dev.vk.com/ru/method/docs.getMessagesUploadServer>

**Бот не отвечает, ошибок нет** — сообщения отклоняются политиками доступа. Проверьте `dmPolicy`, `allowFrom` и `requireMention`. Логи: `~/.openclaw/logs/commands.log` (фильтруйте по `"source":"vk"`).

---

## Лицензия

Copyright 2026 Pavel Frankov

[Apache License 2.0](LICENSE).
