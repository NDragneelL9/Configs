---
name: warcraftlogs
description: >-
  Анализ боевых логов WarcraftLogs через официальный GraphQL API v2 (бои,
  урон/хил, касты, смерти, перцентили). Use whenever the user gives a link to
  warcraftlogs.com or asks to разобрать/проанализировать лог, парс, WCL.
  Сайт блокирует ботов (403) — данные только через скрипт скилла; ключи из
  secrets.env читает скрипт, в чат их не брать.
---

# WarcraftLogs (API v2)

warcraftlogs.com отдаёт ботам 403, и весь UI — SPA: все данные идут через
официальный GraphQL API v2 (OAuth client-credentials). Запросы гоняет
`scripts/wcl.mjs`; ключи лежат в `secrets.env` рядом с этим файлом, и их
читает только скрипт.

## Железные правила

1. **Ключи и токены читает только скрипт.** Работай исключительно с выводом
   `scripts/wcl.mjs` и файлами из `--out`. `secrets.env` и `.token.json` не
   открывай и не цитируй; в команды bash ключи не подставляй — скрипт берёт
   их из файла сам.
2. `OAuth failed` (exit 3) → попроси пользователя проверить/обновить ключи в
   `secrets.env` самостоятельно и повтори. Ключи создаются и отзываются на
   https://www.warcraftlogs.com/api/clients/.
3. Прямые запросы к warcraftlogs.com (curl, fetch_content, браузер) не нужны:
   сайт отвечает 403, а данные всё равно скрыты за API.

## Шаги

### Шаг 0. Node и пути

`eval "$(fnm env)"`. `SKILL=C:/Users/JohnDoe_it/.pi/agent/skills/warcraftlogs`.
Временные файлы (запросы, `--out`) клади в `$SKILL/work/` — каталог
создаётся автоматически.

### Шаг 1. Проверка ключей

```bash
node "$SKILL/scripts/wcl.mjs" check
```

Печатает rate limit (`points/hour`). Exit 2 (`secrets.env not found`) →
попроси пользователя скопировать `secrets.example.env` в `secrets.env` и
заполнить ключами со страницы Create Client, затем повтори. На этом
остановись — сам ключи не заполняй.

### Шаг 2. Запросы

GraphQL пиши в файл (кавычки и `$` ломаются в argv) и запускай:

```bash
node "$SKILL/scripts/wcl.mjs" query "$SKILL/work/q.graphql" --vars "$SKILL/work/v.json" --out "$SKILL/work/out.json" --unwind
```

`--vars`/`--out`/`--unwind` опциональны; результат печатается в stdout.
Большие `events`/`table` — пиши в `--out` и читай кусками. Шаблоны запросов и
особенности схемы (JSON-строки в `table`/`events`, пагинация, интроспекция) —
`references/queries.md`.

### Шаг 3. Анализ

Код репорта — последний сегмент `warcraftlogs.com/reports/<код>`; номер боя —
`?fight=N`. Строй запросы под вопрос пользователя (итоги по бою, кто умер и
чем, аптайм кулдаунов, сравнение с топами) и итерируй, пока ответ не полон.
В ответе указывай код репорта и номера боёв.

## Ограничения

- Rate limit ≈3600 очков/час на ключ: списки дёшевы, `events`/`table` дороже.
- Client-credentials видят только публичные репорты: приватный/гильдейский
  вернёт «not found» — скажи пользователю сделать лог публичным.
- Retail only: classic.warcraftlogs.com и archon.gg используют другие
  эндпоинты — это отдельная доработка, предупреди пользователя.
- Схема WCL меняется: при ошибке про поле/аргумент проверь интроспекцией
  (`references/queries.md`, раздел 6).
