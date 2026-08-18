# 🦞 WebClaw by ProTalk 6.0 — Vision-First AI Browser Agent

> **Разработано в [ProTalk Codex](https://codex.lubanyacloud.ru)** — ИИ-инженер для вашего сервера. SSH · AI · автономный агент.

**WebClaw by ProTalk** — Chrome-расширение для автономного управления веб-сайтами через AI Vision. Агент видит страницу как скриншот, рассуждает в едином ReAct-цикле и выполняет доверенные действия в браузере через Chrome DevTools Protocol.

[![Смотреть демо](https://file.pro-talk.ru/ptrn/aHR0cHM6Ly9wYXRyaW5zLmNvbS9hcGkvd2ViZGF2LXVwbG9hZC85MjU5YTQ5YTUyYzcvNDA4ZmYwMTUtZDZjNC00MjE0LTljZDMtZTlhMWFiOTRmZjlkLmpwZ3x8cGF0cmluc19iOWIxYWU4M2ZlNmQ4MmNmMzAxZWUzM2I1NGJmYjAyY2FiNjJlZDgyYjlmOWExNDU1Mzk1YmYwMTY1NWRhZDk0.jpg)](https://www.youtube.com/watch?v=D6kIEC4QcX0)

[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest_V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Vision First](https://img.shields.io/badge/Architecture-Vision--First-6366f1.svg)]()
[![CDP](https://img.shields.io/badge/Control-Chrome_DevTools_Protocol-0f766e.svg)]()
[![Zero RAM](https://img.shields.io/badge/Hibernation-0_RAM-16a34a.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 1. Что это такое

**WebClaw by ProTalk 6.0** превращает AI-модель, доступную через ProTalk Async Router / OpenRouter-совместимый API, в автономного браузерного ассистента.

Главная идея проекта — **Vision-First Computer Use**:

- агент получает **только скриншот**, краткую историю действий, задачу, локальное время и свою навигационную память;
- не полагается на DOM-снимки, CSS-селекторы и хрупкие XPath;
- возвращает JSON-команду с инструментом и координатами в нормализованной сетке `0–1000`;
- расширение масштабирует координаты под реальный viewport и выполняет действия через CDP как доверенные mouse/keyboard events.

Это позволяет работать с сайтами, где классическая автоматизация ломается: сложные SPA, маркетплейсы, CRM, чаты, кабинеты, страницы с CSP/X-Frame-Options и кастомными компонентами.

---

## 2. Ключевые возможности

### 👁️ Vision-First Engine

Модель управляет страницей по скриншоту и координатам:

- `(0, 0)` — левый верхний угол viewport;
- `(1000, 1000)` — правый нижний угол;
- `(500, 500)` — центр экрана.

Координаты автоматически переводятся в реальные пиксели с учетом размеров окна, DPR и масштаба.

### 🖥️ Direct Tab Mode

Агент управляет активной вкладкой пользователя напрямую через **Chrome DevTools Protocol**:

- без iframe и отдельной `agent.html`-страницы;
- без проблем с `X-Frame-Options` и CSP;
- клики, ввод текста, прокрутка, hover и свайпы отправляются как trusted browser events.

### 🌙 Smart Sleep: сторожевой сон и гибернация

Агент умеет ждать без лишних AI-запросов и расхода токенов.

1. **Watchful Sleep (`wake_on_change: true`)**  
   Для ожидания динамических событий: ответ в чате, появление модального окна, завершение прогресса. Расширение локально делает скрытые скриншоты, сжимает их до 16×16 grayscale-матрицы и сравнивает perceptual hash. AI не вызывается, пока картинка заметно не изменится.

2. **Deep Sleep / Hibernation (`wake_on_change: false`)**  
   Для долгих пауз: расписание, ночной режим, rate limit, ожидание следующего дня. Расширение отсоединяет CDP, сохраняет состояние в `chrome.storage.session`, ставит `chrome.alarms` и позволяет MV3 Service Worker выгрузиться. Потребление RAM/CPU стремится к нулю.

### ⏱️ Осознание времени и автономное расписание

В каждый prompt добавляется локальное время пользователя и день недели. Поэтому можно ставить задачи вроде:

- «Проверяй заказы каждый день в 09:00»;
- «Не работай ночью и по выходным»;
- «Если сайт выдал rate limit — отдохни 2 часа и попробуй снова».

Модель сама принимает решение вызвать `sleep` на нужное количество секунд.

### 🧠 Навигационная память и Scratchpad

Во время задачи агент строит **Navigation Tree** — карту посещенных страниц с краткими пометками:

```text
КАРТА НАВИГАЦИИ (Текущая точка: [nav_3]):
📍 🌐 [nav_1] Google: "купить ноутбук"
├── ✅ 📄 [nav_2] dns-shop.ru/product/123: Цена 120k
└── 📍 📄 [nav_3] market.yandex.ru/product/456 ◀ ТЕКУЩАЯ СТРАНИЦА
```

Он может быстро вернуться к нужной точке через `jump_to_node(node_id)` без цепочки кликов «Назад».

### 💾 Persistent Memory через Events API

Долгосрочная память хранится во внешнем Events API `https://events.atiks.org`:

- записи сохраняются как `type=memory` с произвольным `kind` и полями;
- инструменты `recall` и `remember` помогают избегать дублей и сохранять важные факты;
- в настройках задается пользовательская SRC-база, к которой добавляется сгенерированный 6-символьный суффикс;
- доступен CSV-экспорт последних записей памяти.

### ⚡ Anti-Blink для кастомных dropdown/menu

Современные dropdown-компоненты часто закрываются до следующего скриншота. WebClaw использует две техники:

- **Mouse Parking** — после клика курсор «паркуется» на координатах клика, чтобы не вызвать `mouseleave`;
- **Fast-Track Screenshot** — после UI-действий следующий скриншот снимается быстро, без ожидания network idle и полной DOM-стабильности.

Это повышает надежность работы с кастомными меню, селектами, всплывающими списками и hover-зависимыми интерфейсами.

### 🫳 Human-Like Swipe

Инструмент `swipe` имитирует естественный человеческий жест:

- отправляет touch- и mouse-события;
- использует фазовый профиль скорости: ускорение → постоянное движение → замедление → release;
- добавляет Bezier-кривизну, микродрожание и случайные микропаузы;
- подходит для каруселей, слайдеров, swipe-to-action и mobile/PWA-интерфейсов.

---

## 3. Инструменты AI-агента

| Инструмент | Назначение |
| :--- | :--- |
| `click_at(x, y)` | Доверенный CDP-клик по нормализованным координатам. |
| `type_at(x, y, text)` | Клик в поле, очистка `Ctrl+A/Delete`, ввод текста. |
| `press_key(key)` | Нажатие клавиш: `Enter`, `Tab`, `Escape`, `PageDown` и др. |
| `scroll(direction, amount)` | Прокрутка страницы колесом мыши. |
| `hover_at(x, y)` | Наведение курсора для hover-меню и подсказок. |
| `swipe(x, y, direction, distance, duration, humanize)` | Человекообразный свайп/drag для каруселей, слайдеров и мобильных UI. |
| `select_at(x, y, value)` | Выбор значения в нативном `<select>`. |
| `checkbox_at(x, y)` | Переключение чекбокса/тумблера кликом. |
| `navigate(url)` | Прямой переход по URL. |
| `jump_to_node(node_id)` | Быстрый переход к ранее посещенной странице из Navigation Tree. |
| `mark_node(node_id, status, summary)` | Пометка узла навигации: explored/promising/dead_end и краткое резюме. |
| `sleep(sec, wake_on_change, reason)` | Watchful Sleep или Deep Sleep в зависимости от `wake_on_change`. |
| `recall(kind, filters, limit)` | Поиск записей в Persistent Memory. |
| `remember(kind, fields)` | Сохранение важных фактов в Persistent Memory. |
| `done(answer)` | Успешное завершение задачи. |
| `fail(reason)` | Завершение с ошибкой: Captcha, 2FA, блокировка, недоступность сайта. |

---

## 4. Интерфейс

WebClaw показывает состояние агента в нескольких местах:

- **Popup** — ввод задачи, быстрые пресеты, старт/стоп, текущий статус;
- **Overlay Widget** — компактный виджет поверх страницы с фазой работы, мыслями модели, токенами и режимом сна;
- **Sidepanel / Monitor** — подробный мониторинг с логами, ходом выполнения и экспортом сессии;
- **Options** — настройки модели, токенов, remote config, Persistent Memory и технических параметров.

Во время работы видно, почему агент сделал действие: в UI отображаются AI thoughts и наблюдения после шагов.

---

## 5. Быстрый старт

### 1. Установка

1. Клонируйте репозиторий или скачайте ZIP.
2. Откройте Chrome: `chrome://extensions/`.
3. Включите **Developer mode / Режим разработчика**.
4. Нажмите **Load unpacked / Загрузить распакованное расширение**.
5. Выберите папку `extension`.

### 2. Настройка

1. Откройте расширение и перейдите в **⚙ Настройки**.
2. Укажите `Auth Token` ProTalk или совместимые параметры API.
3. Выберите модель. По умолчанию архитектура ориентирована на vision-модели через OpenRouter-совместимый endpoint.
4. При необходимости включите Persistent Memory и настройте SRC для Events API.

### 3. Запуск задачи

1. Откройте сайт, с которым должен работать агент.
2. Нажмите на иконку WebClaw.
3. Введите задачу, например:
   - «Найди самый дешевый ноутбук с 32 ГБ RAM и сохрани три лучших варианта»;
   - «Жди ответа в чате поддержки и сообщи, когда он появится»;
   - «Каждое утро проверяй новые заявки в кабинете».
4. Нажмите **▶ Старт**.
5. Откройте **📊 Монитор**, чтобы следить за действиями агента.

---

## 6. Архитектура для разработчиков

```text
User Input → Popup → Background Service Worker
                         ↓
                    AI Model API
              (Vision Prompt + Time + Memory)
                         ↓
                    Screenshot via CDP
                         ↓
                    JSON Decision
                         ↓
          CDP Trusted Events / Sleep Engine / Memory Tools
                         ↓
          Observation + History + State Persistence
                         ↓
                    Next Iteration or Sleep
```

### Основные компоненты

- `extension/src/background.js` — state machine агента, API-вызовы, sleep/hibernation, логирование;
- `extension/src/cdp.js` — CDP-снимки и доверенные browser events;
- `extension/src/vision_loop.js` — ReAct-цикл и исполнение vision tools;
- `extension/src/vision_prompt.js` — системный prompt, time awareness, формат JSON-действий;
- `extension/src/task_memory.js` — Navigation Tree и Scratchpad;
- `extension/src/persistent_memory.js` — долгосрочная память через Events API;
- `extension/src/overlay_widget.js` — виджет статуса на странице;
- `extension/src/sidepanel.js` — монитор выполнения;
- `extension/src/settings.js` / `options.js` — настройки и безопасное хранение секретов;
- `extension/src/session_logger.js` — сбор отчётов и API-логов.

### Экономия токенов

В prompt отправляется только компактный контекст:

1. текущий скриншот;
2. задача пользователя и локальное время;
3. последние действия в коротком action log;
4. Navigation Tree и Scratchpad;
5. wake-up context, если агент вернулся из сна.

---

## 7. API-интеграция

WebClaw использует ProTalk Async Router:

```http
POST https://ai.pro-talk.ru/api/async/router
```

Пример тела запроса:

```json
{
  "base_url": "https://openrouter.ai/api/v1/chat/completions",
  "model": "xiaomi/mimo-v2.5",
  "messages": [],
  "stream": false
}
```

Далее результат опрашивается по `taskId`:

```http
GET https://ai.pro-talk.ru/api/async/router/{taskId}
```

Встроена retry-логика с exponential backoff для `429` и `5xx`.

---

## 8. Безопасность и разрешения

### Разрешения Chrome

Расширение использует:

- `activeTab`, `tabs` — работа с текущей вкладкой;
- `debugger` — CDP: скриншоты и доверенные события;
- `storage` — настройки, состояние задачи и гибернация;
- `alarms` — пробуждение из Deep Sleep;
- `scripting` — инъекция overlay UI;
- `sidePanel` — монитор агента;
- `downloads` — экспорт отчётов;
- `webNavigation` — отслеживание навигации.

### Хранение секретов

- `auth_token` и `api_key` хранятся только в `chrome.storage.local`;
- секреты не синхронизируются через Google Account;
- remote config не имеет права импортировать секретные значения.

---

## 9. Отчёты и экспорт

WebClaw ведет подробный лог сессии:

- **HTML-отчёт** — визуальный timeline шагов, screenshots, мысли AI, действия, наблюдения и ошибки;
- **API-log / CURL** — сырой журнал запросов и ответов для воспроизведения и отладки;
- **Memory CSV** — экспорт последних записей Persistent Memory из настроек.

Скриншоты отчётов могут автоматически загружаться на `file.pro-talk.ru`, чтобы HTML-отчёт оставался самодостаточным и удобным для передачи.

---

## 10. Структура проекта

```text
webclaw/
├── docs/
│   └── architecture.md
├── extension/
│   ├── manifest.json
│   ├── icons/
│   └── src/
│       ├── background.js
│       ├── cdp.js
│       ├── vision_loop.js
│       ├── vision_prompt.js
│       ├── task_memory.js
│       ├── persistent_memory.js
│       ├── overlay_widget.js
│       ├── popup.js / popup.html
│       ├── sidepanel.js / sidepanel.html
│       └── options.js / options.html
├── README.md
└── LICENSE
```

---

## 🛠 Разработано в ProTalk Codex

Проект создан и развивается с использованием [**ProTalk Codex**](https://codex.lubanyacloud.ru) — автономного ИИ-инженера для работы с кодом на сервере.

**ProTalk Codex умеет:**

- 🔍 исследовать файловую структуру проекта;
- 📋 составлять план перед изменениями;
- 🛡️ вносить правки в черновиках с возможностью отката;
- ✨ выполнять самопроверку перед завершением;
- 🧠 держать в контексте только релевантные файлы;
- 📝 показывать историю изменений и diff.

[⚡ Попробовать ProTalk Codex](https://codex.lubanyacloud.ru) · [📖 Документация](https://pro-talk.ru) · [💬 Telegram](https://t.me/protalk)

---

## 📄 Лицензия

Проект распространяется под лицензией [MIT](LICENSE).
