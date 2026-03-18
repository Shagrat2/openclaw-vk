# openclaw-vk
<img width="500" src="https://github.com/user-attachments/assets/1bb97849-8aa0-46dc-b3de-90e4bcf10d38"/>

Плагин [OpenClaw](https://github.com/openclaw/openclaw) для работы с ВКонтакте. Подключает AI-агента к сообществам VK через Bots Long Poll API — бот принимает и отвечает на сообщения в личных диалогах и групповых беседах.

## Быстрый старт

### 1. Подготовка сообщества ВКонтакте

1. **Создайте сообщество** (группу или паблик), если его ещё нет.
2. Откройте **Управление → Сообщения** и включите их.
3. Откройте **Управление → Работа с API → Ключи доступа**, нажмите *Создать ключ* и выберите права:
   - **Сообщения сообщества**
   - **Управление сообществом** (необходимо для Bots Long Poll API)
4. Откройте **Управление → Работа с API → Long Poll API**:
   - Включите Long Poll API.
   - На вкладке **Типы событий** отметьте **Входящие сообщения**.
5. *(Для работы в беседах)* Откройте **Управление → Сообщения → Настройки для бота** и включите *Разрешать добавлять сообщество в чаты*.

### 2. Установка плагина

```bash
openclaw plugins install openclaw-vk
openclaw plugins enable vk
```

> Для локальной разработки: `openclaw plugins install ~/path/to/openclaw-vk`

### 3. Настройка

Добавьте канал в `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "vk": {
      "enabled": true,
      "token": "<ВАШ_ТОКЕН>",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist"
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

### Параметры

| Параметр | Описание |
| --- | --- |
| `token` / `tokenFile` | Ключ доступа сообщества или путь к файлу с токеном. Также поддерживается переменная окружения `VK_TOKEN`. |
| `dmPolicy` | Политика личных сообщений: `pairing` (авторизация по коду), `allowlist` (по списку), `open` (без ограничений), `disabled`. |
| `allowFrom` | Список ID пользователей, которым разрешён доступ при политике `allowlist`. |
| `groupPolicy` | Политика для групповых бесед: `allowlist`, `open`, `disabled`. |
| `groupAllowFrom` | Список разрешённых бесед по `peerId`. |

### Настройка отдельных бесед

Для каждой беседы можно задать индивидуальные параметры — например, требовать упоминание бота:

```json
{
  "channels": {
    "vk": {
      "groups": {
        "2000000123": {
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

**Бот не отвечает, ошибок нет** — сообщения отклоняются политиками доступа. Проверьте `dmPolicy`, `allowFrom` и `requireMention`. Логи: `~/.openclaw/logs/commands.log` (фильтруйте по `"source":"vk"`).

---

## Лицензия

Copyright 2026 Pavel Frankov

[Apache License 2.0](LICENSE).
