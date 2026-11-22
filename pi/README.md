# pi coding agent — конфигурация

Полный снапшот конфигурации [pi](https://pi.dev) для быстрого восстановления
на новой машине.

## Что входит

| В репо (`agent/`, `dotagents/`) | Что это |
|---|---|
| `agent/AGENTS.md` | глобальные инструкции агенту |
| `agent/settings.json` | тема, дефолтная модель, список пакетов, включённые модели |
| `agent/models.json` | кастомные провайдеры (LM Studio) |
| `agent/mcp.json` | MCP-серверы (obsidian, chrome-devtools) — **токен вычищен** |
| `agent/extensions/` | TS-расширения (clean-header, status-line, tab-title, zai-usage) |
| `agent/themes/` | тема ayu-dark |
| `agent/skills/` | личные скиллы (obsidian-notes, keepass-update, chrome-devtools-mcp) |
| `agent/npm/package*.json` | пины npm-пакетов (pi-subagents, context7-pi, pi-web-access) |
| `dotagents/skills/` + `.skill-lock.json` | скиллы skills CLI (mattpocock/skills и др.) с пинами версий |

## Что сознательно НЕ входит

- `~/.pi/agent/auth.json` — **API-ключи провайдеров** (zai, opencode-go)
- токен Obsidian в `mcp.json` — заменяется на `<<OBSIDIAN_TOKEN>>`
- `obsidian-local-rest-api.crt` — сертификат генерится плагином на каждой машине
- `sessions/`, `crashes.json`, `models-store.json`, `install/`, `bin/`, `trust.json`,
  состояние расширений — кэши/логи, восстанавливаются сами

## Бэкап (машина → репо)

```bash
cd /d/GitHub/Configs/pi
bash backup.sh          # снапшот + санитизация секретов
git add pi && git commit -m "pi: update snapshot" && git push
```

Скрипт сам вырезает Bearer-токены из `mcp.json` и падает с ошибкой, если
заметит в снапшоте что-то похожее на секрет.

## Восстановение на новом PC

```bash
# предусловия: Node (fnm), Git, Git Bash; сам pi:
npm install -g @earendil-works/pi-coding-agent

git clone git@github.com:NDragneelL9/Configs.git /d/GitHub/Configs
cd /d/GitHub/Configs/pi
bash restore.sh         # файлы + скиллы + npm ci
```

`restore.sh` переиспользует живой токен Obsidian из существующего
`mcp.json`, а на чистой машине возьмёт его из `OBSIDIAN_TOKEN`:

```bash
OBSIDIAN_TOKEN=<ключ из плагина Local REST API> bash restore.sh
```

После скрипта вручную: ключи провайдеров (`pi` → вход для zai и opencode-go
или скопировать `auth.json` из менеджера паролей) и сертификат Obsidian
(см. подсказку в конце вывода скрипта).
