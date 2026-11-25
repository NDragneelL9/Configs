# GraphQL-справочник (WCL v2) — проверено на живой схеме 2026-11-24

Эндпоинт и авторизация зашиты в `scripts/wcl.mjs`. Ниже — проверенные запросы и
особенности. Схема WCL меняется: при ошибке про поле/аргумент — интроспекция
(раздел 7), не угадывай.

Переменные — отдельным JSON-файлом: `--vars v.json` → `{"code": "aB1cD2"}`.

## Важные особенности схемы (проверено)

- `report.table` и `report.rankings` — **скаляры JSON** (без подселекта!):
  `table(...)` / `rankings` возвращают большой JSON, разворачивай `--unwind`.
- `table` **требует** `fightIDs` или `startTime`+`endTime` — иначе ошибка.
- `ReportFight` использует camelCase: `startTime`/`endTime` (не `start_time`).
- Времена боёв — мс от начала репорта; `report.startTime` — epoch-мс.
- `recentReports(limit: Int, page: Int)` — только эти два аргумента; ответ:
  `{ data: [...], total, per_page, has_more_pages, last_page }`. `limit: 100`
  работает.

## 1. Бои репорта

```graphql
query Fights($code: String!) {
  reportData {
    report(code: $code) {
      code
      title
      startTime
      zone { id name }
      fights {
        id
        name
        kill
        difficulty   # рейды: 3=Normal 4=Heroic 5=Mythic; M+: 10 (не уровень ключа!)
        startTime
        endTime
      }
    }
  }
}
```

## 2. Репорты персонажа

```graphql
query List($id: Int!, $page: Int!) {
  characterData {
    character(id: $id) {
      recentReports(limit: 100, page: $page) {
        data { code startTime zone { id name } }
        total
        has_more_pages
        last_page
      }
    }
  }
}
```

M+-раны — репорты с зоной сезонной M+ зоны (например, id 55 «Mythic+ Season
2»; у старых сезонов свои id). Рейды отфильтровывай по зоне. Один лог может
содержать **несколько ключей подряд** (марафон) — ран ≠ лог.

## 3. Уровни ключей и состав: `rankings` (скаляр)

```graphql
query Run($code: String!) {
  reportData {
    report(code: $code) {
      code
      title
      startTime
      fights { id name kill }
      rankings
    }
  }
}
```

Внутри JSON `rankings` — по одному рангу на ранковый бой:
- `fightID`, `encounter`, `kill`, `duration`, `deaths` (всего за бой);
- **`bracketData` — уровень ключа** (проверь на известном ране у пользователя;
  `bracket` = bracketData−1, лидерборд-группировка);
- `team` — состав пачки: `id name class spec role`;
- `roles.characters[]` — перцентили по игрокам;
- `affixes` — id афиксов.

⚠️ **Гочи мерженных/гильдейских логов.** `rankings.data` может содержать и
РЕЙДОВЫЕ записи: `difficulty: 3/4/5`, `size: 20+`, пустой `team`, а в
`bracketData` — рейдовая метрика (~300+, дробная). M+-запись ≠ рейдовая:
**M+ ⇔ `difficulty: 10`, `size: 5`, непустой `team`, `bracketData` — целое**.
Такие логи висят в `recentReports` персонажа, даже если он был только в рейдовой
части, и содержат чужие ключи — фильтруй по `team` (в команде должен быть
игрок пачки).

⚠️ **Дубликаты.** Один ран, залитый несколькими игроками, — несколько репортов
в `recentReports` с **идентичным `computedScore`** (совпадает до мелочей).
Дедуп по `dungeon|computedScore`, из копий бери самую полную по смертям
(логгеры видят разный диапазон боя).

## 4. Смерти по игрокам: `table(Deaths)` (скаляр)

```graphql
query DeathsTable($code: String!, $fightIDs: [Int]) {
  reportData {
    report(code: $code) {
      table(dataType: Deaths, fightIDs: $fightIDs)
    }
  }
}
```

Развёрнутый `--unwind` JSON — список записей по одной на смерть:
`name` (игрок), `type` (класс), `timestamp`, `fight`, `killingBlow {name guid}`,
`events[]` (последние удары перед смертью, с amount/mitigated). Считай записи
по `name` для «кто умирал больше», по `killingBlow` для «чем умирали».

`dataType` — enum `TableDataType`: `DamageDone`, `DamageTaken`, `Healing`,
`Casts`, `Buffs`, `Debuffs`, `Deaths`, ... (полный список — интроспекция).

## 5. Персонаж по id (для ссылки /character/id/<id>)

```graphql
{ characterData { character(id: 111880854) { id name server { name slug region { slug } } } } }
```

`recentReports` показывает только **публичные** логи.

## 6. Rate limit и стоимость (замерено)

```graphql
{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }
```

Замеры: страница `recentReports(100)` ≈ 2 очка; `fights`+`rankings` на лог ≈
2–3; `table(Deaths)` на лог ≈ 2–4 (растёт с числом смертей). Суммарно разбор
~130 логов M+ ≈ 600–900 очков — укладывается в часовой лимит 3600. Включай
`rateLimitData` в тот же запрос для контроля расхода.

## 7. Интроспекция

```graphql
query ReportFields {
  __type(name: "Report") { fields { name args { name } } }
}
```

Так же: `Fight`, `TableDataType` (`__type(name: "TableDataType") { enumValues { name } }`),
`Character`, `Query`. Обычные запросы — гоняй как остальные.
