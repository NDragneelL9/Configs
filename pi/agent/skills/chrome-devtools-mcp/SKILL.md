---
name: chrome-devtools-mcp
description: >-
  Памятка по управлению Chrome через MCP-сервер chrome-devtools из codemode:
  открыть страницу, скриншот, консоль, сетевые запросы, живая проверка вёрстки в
  браузере. Use when driving a real Chrome browser (dev server check, screenshots,
  console/network inspection) via mcp__chrome_devtools tools from codemode.
---

# chrome-devtools-mcp: контракт API

Сервер доступен **только из codemode** (namespace `mcp__chrome_devtools__*`). Цель памятки — не переоткрывать API заново каждый раз.

## Разрешение пользователя (обязательное)

Вызывай любые инструменты `mcp__chrome_devtools__*` (включая открытие страниц и веб-поиск через Chrome) только после явного запроса или прямого разрешения пользователя в текущем сеансе. Нужен поиск в интернете или проверка сайта «по своей инициативе» — сначала спроси пользователя и дождись согласия. Chrome на этой машине — личный браузер пользователя: самостоятельный запуск без разрешения запрещён.

## Ключевой контракт: `pageId` — число

`list_pages()` возвращает текстовый нумерованный список:

```
## Pages
1: about:blank [selected]
```

`pageId` = число из этого списка (`1`, `2`, …). Не строки вида `"page-1"` — валидация падает с `expected number, got string`. `pageId` **обязателен** у `navigate_page`, `take_screenshot`, `take_snapshot`, `list_network_requests`, `list_console_messages` (пропуск = `pageId: missing`).

## Типовой сценарий

```js
// 1. Страница: существующая или новая
const pages = await tools.mcp__chrome_devtools__list_pages({})
// → распарсить «N: url» или просто использовать pageId 1
// новая вкладка: await tools.mcp__chrome_devtools__new_page({ url: 'http://localhost:5173/' })

// 2. Навигация (pageId — число!)
await tools.mcp__chrome_devtools__navigate_page({ pageId: 1, url: 'http://localhost:5173/systems' })

// 3a. A11y-снимок страницы текстом (дешевле скриншота для поиска элементов)
const snap = await tools.mcp__chrome_devtools__take_snapshot({ pageId: 1 })
const text = snap.content.map(c => c.text ?? '').join('\n')

// 3b. Скриншот — показать пользователю
const shot = await tools.mcp__chrome_devtools__take_screenshot({ pageId: 1 })
image(shot.content.find(c => c.type === 'image'))
// image()-вложения (скриншоты и картинки) смотрит только glm-5.4 (AGENTS.md, «Subagents»);
// на другой модели анализ скриншота — субагенту с model: zai/glm-5.4 или ориентируйся по take_snapshot (3a)

// Таймаут `MCP request timed out after 60000ms` на take_screenshot идёт серией (23.11: 5×60 с подряд);
// `// @options: {"timeout_ms": …}` не помогает — лимит на стороне MCP. После первого таймаута не повторять:
// геометрия — evaluate_script (getBoundingClientRect), содержимое — take_snapshot.

// 4. Диагностика
const msgs = await tools.mcp__chrome_devtools__list_console_messages({ pageId: 1 })
const reqs = await tools.mcp__chrome_devtools__list_network_requests({ pageId: 1, resourceTypes: ['xhr', 'fetch'] })
```

Результаты приходят как `{ content: [{ type: 'text'|'image', text|data }] }` — текст собирай через `content.map(c => c.text ?? '').join('\n')`.

## Ограничения песочницы codemode

- Нет таймеров: `setTimeout`/`sleep` → `ReferenceError`. Ожидание — только `await` инструментов (они сами дожидаются загрузки).
- Не называйте локальные переменные именами параметров функции-обёртки (`pageId` и т.п.) — `SyntaxError: invalid redefinition of parameter name`.
- Поиск инструментов: `await searchTools('chrome', { namespace: 'mcp__chrome_devtools', limit: 30 })` — но приведённого выше набора обычно достаточно.

## Сервер не поднимается

`MCP connection closed … npm error 404` — npx тянул пакет из корпоративного Artifactory; в `~/.pi/agent/mcp.json` уже прописан override `npm_config_registry: https://registry.npmjs.org/`. Если снова 404 — проверь этот override, до Chrome дело даже не доходит.
