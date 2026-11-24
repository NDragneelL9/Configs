# План v2 (утверждён): чтение Confluence через OSS-санитизацию

> **Статус: реализован.** Приёмочный тест (examples/sample2.html): все 16 подсаженных значений вырезаны, псевдонимы host-N/ip-N с маппингом, кэш/TTL/lookup/open-mappings проверены.

Утверждено в grill-сессии. Все решения ниже зафиксированы пользователем.

## Стек

| Компонент | Роль | Установка |
|---|---|---|
| gitleaks | секреты: ключи, токены, пароли | scoop |
| Presidio + spaCy ru_core_news_lg + en_core_web_lg | ПДн: NER-имена (ru+en, CPU), email, телефоны, ИНН/СНИЛС/паспорт | Python + venv в `~/.pi/agent/.venvs/confluence-docs` (вне скилла — не попадает в бэкапы) |
| кастомные распознаватели Presidio | «логин:», «пароль от стенда:», «ответственный:», док-номера RU (контрольные суммы), JWT, url-creds | конфиг, штатный механизм |
| консистентная псевдонимизация (custom operator) | хостнеймы/IP/названия систем → стабильные псевдонимы + локальный mappings.json | входит в обёртку |
| Node + turndown | клей: fetch, конвертация в Markdown, кэш, оркестрация | уже стоит |

Самописный sanitize.mjs — удалён полностью (решение Q5).

## Пайплайн: `confluence-docs fetch <url>`

```
URL → кэш (meta.json: TTL 24ч, настраивается / version-check анонимным REST)
  → скачивание: curl (REST storage → отрендеренный HTML #main-content
     → при SSO агент фолбэкит на Chrome chrome-devtools MCP и передаёт
        HTML через fetch --html <file>)
  → turndown → Markdown
  → gitleaks (stdin/dir, JSON) → вырезка секретов
  → presidio_redact.py (stdin→файлы): NER ru+en (спаны мерджатся, только PERSON),
     док-номера, keyword-распознаватели, псевдонимизация техники
  → <id>-<slug>.md + .report.txt + meta.json + mappings.json
  → сырой текст не пишется на диск (stdin-пайпы, temp только как fallback)
```

## Правила (все утверждены)

- **Fail-closed**: тул не установлен/упал → стоп, raw не читается. `check` проверяет окружение.
- **Порог** (Q11): остановка и вопрос — только при >5 **уникальных кредов** (gitleaks + секрет-типы; настраивается). ФИО/контакты режутся молча.
- **Over-redact + whitelist** (Q9). Вырезаем людей/секреты/контакты (Q3), техника — в псевдонимы (Q12).
- **Маппинг** (Q12–13): `~/.cache/confluence-docs/mappings.json`, глобальный.
  Доступ: `open-mappings` (внешний просмотрщик, без попадания в контекст),
  `lookup <псевдоним>` (одно значение осознанно в контекст),
  правило «содержимое mappings.json агентом не читается» в SKILL.md и AGENTS.md.
- **Актуальность** (Q10): TTL 24ч + `--fresh` + version-check бонусом. Вложения/картинки не качаем.
- **Доступ** (Q1): curl-first (REST storage анонимно), фолбэк отрендеренный HTML, фолбэк Chrome MCP.
- NER-модели lg на CPU (Q7); GPU не привлекается (CPU-модели spaCy GPU не умеют).

## Порядок реализации

1. Установка: scoop python + gitleaks, venv, pip (presidio-analyzer, presidio-anonymizer, spacy), `spacy download` ru/en lg (~1.1ГБ).
2. `presidio_redact.py`.
3. `confluence.mjs` v2: fetch по URL, gitleaks+python, кэш+TTL+meta, `check`, `lookup`, `open-mappings`.
4. Удаление sanitize.mjs, перезапись SKILL.md, правка AGENTS.md.
5. Приёмочный тест: examples/sample2.html с подсадками → автопроверка отсутствия сырья в выходе.

## Риски (принятые)

- NER проседает в таблицах — компенсировано keyword-распознавателями и over-redact.
- +4–8 сек на fetch (загрузка lg-моделей при каждом запуске Python).
- Произвольные кодовые названия систем ловятся только списком в конфиге.
- Гарантии «не читает mappings.json / не ходит на Confluence напрямую» — правила, не технические блоки.
