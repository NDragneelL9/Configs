#!/usr/bin/env bash
# Развёртывание конфигурации pi из этого репозитория на текущую машину.
# Запуск: bash restore.sh   (из каталога pi/ в клоне репозитория Configs)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SRC_AGENT="$SCRIPT_DIR/agent"
SRC_AGENTS="$SCRIPT_DIR/dotagents"
AGENT_DST="$HOME/.pi/agent"
AGENTS_DST="$HOME/.agents"

if [ ! -d "$SRC_AGENT" ]; then
  echo "ERROR: $SRC_AGENT не найден — запусти из каталога pi/ в клоне Configs" >&2
  exit 1
fi

mkdir -p "$AGENT_DST" "$AGENTS_DST"

# Если машина уже была настроена — переиспользуем живой токен Obsidian,
# иначе берём из переменной окружения OBSIDIAN_TOKEN.
TOKEN=""
if [ -f "$AGENT_DST/mcp.json" ]; then
  TOKEN="$(grep -oE 'Bearer[[:space:]]+[0-9a-f]{16,}' "$AGENT_DST/mcp.json" | head -1 | awk '{print $2}' || true)"
fi
if [ -z "$TOKEN" ] && [ -n "${OBSIDIAN_TOKEN:-}" ]; then
  TOKEN="$OBSIDIAN_TOKEN"
fi

echo "==> Копируем файлы в ~/.pi/agent"
for f in AGENTS.md settings.json models.json mcp.json; do
  if [ -f "$SRC_AGENT/$f" ]; then cp "$SRC_AGENT/$f" "$AGENT_DST/$f"; fi
done
for d in extensions themes skills; do
  if [ -d "$SRC_AGENT/$d" ]; then
    rm -rf "$AGENT_DST/$d"
    cp -r "$SRC_AGENT/$d" "$AGENT_DST/$d"
  fi
done
if [ -d "$SRC_AGENT/npm" ]; then
  mkdir -p "$AGENT_DST/npm"
  for f in package.json package-lock.json; do
    if [ -f "$SRC_AGENT/npm/$f" ]; then cp "$SRC_AGENT/npm/$f" "$AGENT_DST/npm/$f"; fi
  done
fi
# npm ci здесь не нужен: peer-зависимости пакетов pi ссылаются на ядро pi,
# которое живёт в managed-установке — pi сам ставит пакеты из settings.json
# при первом запуске (с подавлением peer-установки).

echo "==> Копируем скиллы в ~/.agents"
if [ -d "$SRC_AGENTS/skills" ]; then
  mkdir -p "$AGENTS_DST/skills"
  cp -r "$SRC_AGENTS/skills/." "$AGENTS_DST/skills/"
fi
if [ -f "$SRC_AGENTS/.skill-lock.json" ]; then
  cp "$SRC_AGENTS/.skill-lock.json" "$AGENTS_DST/.skill-lock.json"
fi

echo "==> Возвращаем токен Obsidian в mcp.json"
if [ -n "$TOKEN" ]; then
  sed -i "s/<<OBSIDIAN_TOKEN>>/$TOKEN/g" "$AGENT_DST/mcp.json"
elif [ -f "$AGENT_DST/mcp.json" ] && grep -q '<<OBSIDIAN_TOKEN>>' "$AGENT_DST/mcp.json"; then
  echo "ВНИМАНИЕ: в mcp.json остался плейсхолдер <<OBSIDIAN_TOKEN>>." >&2
  echo "  Получи API-ключ из Obsidian (плагин Local REST API) и либо впиши вручную," >&2
  echo "  либо перезапусти: OBSIDIAN_TOKEN=<ключ> bash restore.sh" >&2
fi

echo "==> Ставим npm-пакеты pi (pi-subagents, context7-pi, pi-web-access)"
# — отдельного шага нет: пакеты ставит сам pi при первом запуске из settings.json

cat <<'EOF'

Готово. Осталось вручную (секреты и машинно-зависимое):

1. auth.json — ключи провайдеров (zai, opencode-go). Запусти pi и войди
   в каждый провайдер, либо скопируй ~/.pi/agent/auth.json из хранилища
   секретов. В git он сознательно не попадает.
2. Сертификат Obsidian Local REST API: в Obsidian (Настройки -> Local
   REST API) скачай сертификат и положи в
   ~/.pi/agent/obsidian-local-rest-api.crt
3. Запусти pi — темы, расширения, модели и MCP подхватятся из settings.json;
   npm-пакеты (pi-subagents, context7-pi, pi-web-access) поставятся сами
   при первом запуске.
EOF
