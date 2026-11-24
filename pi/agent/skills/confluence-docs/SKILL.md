---
name: confluence-docs
description: >-
  Чтение внутренней документации Confluence по ссылке через санитизацию
  OSS-тулами (gitleaks + Presidio): скачать страницу по сетевому доступу
  пользователя (VPN), вырезать креды и ПДн, псевдонимизировать хостнеймы,
  работать только с очищенным файлом. Use whenever the user gives a
  Confluence link or asks to read Confluence docs/requirements (дока,
  документация, требования, «посмотри доку»). Никогда не обращаться к
  Confluence напрямую.
---

# Confluence docs (sanitized)

Всё, что агент читает, уходит на серверы LLM-провайдера. Единственный путь
работы с Confluence — пайплайн: URL → скачивание → Markdown → gitleaks +
Presidio → кэш. Утверждённый план: `../PLAN.md`.

## Железные правила

1. **Никогда не запрашивай Confluence напрямую** (curl, fetch_content, browser) —
   только скрипт ниже. Единственное исключение — сохранение HTML через
   chrome-devtools MCP для фолбэка `--html` (шаг 3).
2. Читай **только** очищенные файлы из `~/.cache/confluence-docs/*.md`
   (и `*.report.txt` — безопасны, содержат маскированные образцы).
3. **Никогда не читай mappings.json** — только `open-mappings` (открывает
   просмотрщик у пользователя) или `lookup <термин>` по явной просьбе.
4. Вложения и картинки не скачивай.
5. `halted: true` в выводе fetch → **остановись и спроси** пользователя,
   работать ли с докой (в ней больше порога уникальных кредов).
6. Fetch завершился с кодом 2 (SSO) → фолбэк через Chrome (шаг 3).

## Шаги

### Шаг 0. Node

`eval "$(fnm env)"`. SKILL=`C:/Users/JohnDoe_it/.pi/agent/skills/confluence-docs`.

### Шаг 1. Проверить окружение

```bash
node "$SKILL/scripts/confluence.mjs" check
```

`ok: false` → покажи пользователю сломанный компонент и остановись. `venv_python`/`presidio`/`spacy_*` = false (свежий ПК после restore из Configs) → пересобери окружение по плану установки в `../PLAN.md`; venv живёт в `~/.pi/agent/.venvs/confluence-docs` (не в папке скилла).

### Шаг 2. Скачать и санировать

```bash
node "$SKILL/scripts/confluence.mjs" fetch "<url>"            # обычный запуск
node "$SKILL/scripts/confluence.mjs" fetch "<url>" --fresh    # перекачать принудительно
```

Вывод — одна строка JSON: `mdPath`, `reportPath`, `fetchedAt`, `cached`,
`unique_secrets`, `counts`, `halted`. Кэш живёт по TTL (24ч) и сверяет версию
страницы через REST, когда доступен. `cached: true` → файл может быть старым:
упомяни `fetchedAt` в ответе; если контент выглядит устаревшим или пользователь
просит свежее — перезапусти с `--fresh`.

### Шаг 3. SSO-фолбэк (exit code 2)

Если fetch напечатал подсказку про SSO/login: открой URL в Chrome через скилл
`chrome-devtools-mcp`, сохрани полный HTML страницы
(`document.documentElement.outerHTML`) во временный файл и повтори:

```bash
node "$SKILL/scripts/confluence.mjs" fetch "<url>" --html <файл>
```

### Шаг 4. Работать с очищенным файлом

Прочитай `mdPath`. В ответе укажи: «Confluence: `<title>`, скачано `<дата>`,
вырезано: `<счётчики>`». Плейсхолдеры `[REDACTED:тип:N]` — вырезанные
секреты/ПДн, не «восстанавливай» их. Псевдонимы `host-N`, `sys-N`, `ip-N` —
псевдонимизированная техника; реальные значения не угадывай и не подставляй.

### Шаг 5. Обратный поиск (только по явной просьбе)

```bash
node "$SKILL/scripts/confluence.mjs" lookup host-1        # одно значение, попадает в контекст
node "$SKILL/scripts/confluence.mjs" open-mappings        # весь маппинг у пользователя в просмотрщике
```

## Конфиг `scripts/config.json`

`ttl_hours`, `secrets_halt_threshold`, `anonymize_technical`,
`internal_domains` (домены для псевдонимизации), `system_names` (названия
систем), `ner_models`, `whitelist` (regex — не вырезать). Менять только по
явной просьбе пользователя; после правки — `--fresh`.

## Ограничения

- Санитизация — regex+NER: кодовые названия систем в прозе ловятся только
  списком `system_names`; пропуски ФИО возможны в таблицах — следи по отчётам.
- +5–10 сек на каждый fetch (холодная загрузка lg-моделей) — это норма.
- Node fetch не ходит через HTTP-прокси: если корпоративная сеть требует
  прокси для Confluence (симптом: network error при включённом VPN) — скажи
  пользователю.
- gitleaks временно пишет отчёт-фрагменты на диск и сразу удаляет (полная
  страница на диск не пишется).
