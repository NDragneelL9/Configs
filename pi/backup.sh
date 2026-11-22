#!/usr/bin/env bash
# Снапшот конфигурации pi с этой машины в этот репозиторий.
# Запуск: bash backup.sh  (из любого места)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGENT_SRC="$HOME/.pi/agent"
AGENTS_SRC="$HOME/.agents"
AGENT_DST="$SCRIPT_DIR/agent"
AGENTS_DST="$SCRIPT_DIR/dotagents"

if [ ! -d "$AGENT_SRC" ]; then
  echo "ERROR: $AGENT_SRC не найден — pi не установлен?" >&2
  exit 1
fi

echo "==> Чистим прежний снапшот"
rm -rf "$AGENT_DST" "$AGENTS_DST"
mkdir -p "$AGENT_DST" "$AGENTS_DST"

echo "==> Копируем файлы ~/.pi/agent"
for f in AGENTS.md settings.json models.json mcp.json; do
  if [ -f "$AGENT_SRC/$f" ]; then cp "$AGENT_SRC/$f" "$AGENT_DST/$f"; fi
done

for d in extensions themes skills; do
  if [ -d "$AGENT_SRC/$d" ]; then cp -r "$AGENT_SRC/$d" "$AGENT_DST/$d"; fi
done

# пины npm-пакетов (node_modules не переносим — ставится через npm ci)
if [ -f "$AGENT_SRC/npm/package.json" ] || [ -f "$AGENT_SRC/npm/package-lock.json" ]; then
  mkdir -p "$AGENT_DST/npm"
  for f in package.json package-lock.json; do
    if [ -f "$AGENT_SRC/npm/$f" ]; then cp "$AGENT_SRC/npm/$f" "$AGENT_DST/npm/$f"; fi
  done
fi

echo "==> Копируем ~/.agents (скиллы, поставленные через skills CLI)"
if [ -d "$AGENTS_SRC" ]; then
  cp -r "$AGENTS_SRC/skills" "$AGENTS_DST/skills"
  if [ -f "$AGENTS_SRC/.skill-lock.json" ]; then
    cp "$AGENTS_SRC/.skill-lock.json" "$AGENTS_DST/.skill-lock.json"
  fi
fi

echo "==> Вычищаем секреты из mcp.json"
if [ -f "$AGENT_DST/mcp.json" ]; then
  sed -i -E 's/(Bearer[[:space:]]+)[0-9a-f]{16,}/\1<<OBSIDIAN_TOKEN>>/g' "$AGENT_DST/mcp.json"
fi

echo "==> Страховочная проверка на секреты в снапшоте"
if grep -rInE '(sk-[A-Za-z0-9_-]{8,}|Bearer[[:space:]]+[0-9a-f]{16,})' \
     "$AGENT_DST" "$AGENTS_DST" | grep -v '<<OBSIDIAN_TOKEN>>'; then
  echo "ВНИМАНИЕ: похоже на секреты в снапшоте — проверь вручную перед коммитом!" >&2
  exit 1
else
  echo "    чисто"
fi

echo "Готово. Дальше: git add pi && git commit -m 'pi: update snapshot' && git push"
