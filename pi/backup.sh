#!/usr/bin/env bash
# Снапшот конфигурации pi с этой машины в этот репозиторий.
# Запуск:
#   bash backup.sh          — обновить снапшот в репо
#   bash backup.sh --check  — проверка дрейфа: свежий снапшот в temp + diff с репо;
#                             репо не трогает; exit 0 = дрейфа нет, exit 1 = есть
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGENT_SRC="$HOME/.pi/agent"
AGENTS_SRC="$HOME/.agents"

if [ ! -d "$AGENT_SRC" ]; then
  echo "ERROR: $AGENT_SRC не найден — pi не установлен?" >&2
  exit 1
fi

# make_snapshot <dst_root> — собирает свежий снапшот в <dst_root>/agent и <dst_root>/dotagents.
# Тот же пайплайн для записи в репо и для --check (скраб секретов и excludes идентичны).
make_snapshot() {
  local root="$1"
  local agent_dst="$root/agent" agents_dst="$root/dotagents"

  echo "==> Собираю снапшот в $root"
  rm -rf "$agent_dst" "$agents_dst"
  mkdir -p "$agent_dst" "$agents_dst"

  for f in AGENTS.md settings.json models.json mcp.json; do
    if [ -f "$AGENT_SRC/$f" ]; then cp "$AGENT_SRC/$f" "$agent_dst/$f"; fi
  done

  # excludes: окружения/кэши, живые креды скиллов (secrets.env, .env,
  # token-файлы, *.pem/*.key — напр. warcraftlogs) и рабочий скрап (work/);
  # шаблоны *.example.env остаются
  local excludes=(--exclude='.venv' --exclude='node_modules' --exclude='__pycache__' \
                  --exclude='.pytest_cache' --exclude='secrets.env' --exclude='.env' \
                  --exclude='secrets*.json' --exclude='.token.json' --exclude='token.json' \
                  --exclude='.token' --exclude='*.pem' --exclude='*.key' \
                  --exclude='*.p12' --exclude='*.pfx' --exclude='work')
  for d in extensions themes skills; do
    if [ -d "$AGENT_SRC/$d" ]; then
      mkdir -p "$agent_dst/$d"
      tar -C "$AGENT_SRC/$d" "${excludes[@]}" -cf - . | tar -C "$agent_dst/$d" -xf -
    fi
  done

  # пины npm-пакетов (node_modules не переносим — ставится через npm ci)
  if [ -f "$AGENT_SRC/npm/package.json" ] || [ -f "$AGENT_SRC/npm/package-lock.json" ]; then
    mkdir -p "$agent_dst/npm"
    for f in package.json package-lock.json; do
      if [ -f "$AGENT_SRC/npm/$f" ]; then cp "$AGENT_SRC/npm/$f" "$agent_dst/npm/$f"; fi
    done
  fi

  if [ -d "$AGENTS_SRC" ]; then
    # те же excludes, что для agent: dotagents-скиллы тоже без живых кредов и скрапа
    if [ -d "$AGENTS_SRC/skills" ]; then
      mkdir -p "$agents_dst/skills"
      tar -C "$AGENTS_SRC/skills" "${excludes[@]}" -cf - . | tar -C "$agents_dst/skills" -xf -
    fi
    if [ -f "$AGENTS_SRC/.skill-lock.json" ]; then
      cp "$AGENTS_SRC/.skill-lock.json" "$agents_dst/.skill-lock.json"
    fi
  fi

  echo "==> Вычищаем секреты из mcp.json"
  if [ -f "$agent_dst/mcp.json" ]; then
    sed -i -E 's/(Bearer[[:space:]]+)[0-9a-f]{16,}/\1<<OBSIDIAN_TOKEN>>/g' "$agent_dst/mcp.json"
  fi
}

# check_drift — снапшот во временную папку, diff с текущим репо.
# Вывод: M <путь> (изменился), + <путь> (есть вживую, нет в репо), - <путь> (есть в репо, нет вживую).
check_drift() {
  local tmp out=""
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  make_snapshot "$tmp"

  if [ -d "$SCRIPT_DIR/agent" ]; then
    out+="$(diff -r "$tmp/agent" "$SCRIPT_DIR/agent" || true)"
    out+=$'\n'
  fi
  if [ -d "$SCRIPT_DIR/dotagents" ]; then
    out+="$(diff -r "$tmp/dotagents" "$SCRIPT_DIR/dotagents" || true)"
  fi

  out="$(printf '%s' "$out" | sed -e "s|$tmp/|LIVE/|g" -e "s|$SCRIPT_DIR/|SNAP/|g" \
    -e 's|^Files LIVE/\(.*\) and SNAP/.* differ$|M \1|' \
    -e 's|^Binary files LIVE/\(.*\) and SNAP/.* differ$|M \1 (binary)|' \
    -e 's|^Only in LIVE/\(.*\): \(.*\)$|+ \1/\2|' \
    -e 's|^Only in SNAP/\(.*\): \(.*\)$|- \1/\2|' | grep -v '^[[:space:]]*$' || true)"

  if [ -z "$out" ]; then
    echo "Дрейфа нет: снапшот в репо соответствует живой конфигурации."
    exit 0
  fi

  echo "ДРЕЙФ — живая конфигурация ушла от снапшота в репо:"
  printf '%s\n' "$out"
  echo
  echo "Если дрейф осознанный: bash backup.sh && git add pi && git commit -m 'pi: update snapshot' && git push"
  exit 1
}

case "${1:-}" in
  --check)
    check_drift
    ;;
  "")
    make_snapshot "$SCRIPT_DIR"

    echo "==> Страховочная проверка на секреты в снапшоте"
    leaked="$(find "$SCRIPT_DIR/agent" "$SCRIPT_DIR/dotagents" \
              \( -type f \( -name 'secrets.env' -o -name 'secrets*.json' -o -name '.env' \
                            -o -name '.token.json' -o -name 'token.json' -o -name '.token' \
                            -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \) \
                 -o -type d -name 'work' \) -print 2>/dev/null)"
    if [ -n "$leaked" ]; then
      echo "ВНИМАНИЕ: в снапшоте файлы с живыми кредами — исключи их из tar: $leaked" >&2
      exit 1
    fi
    if grep -rInE '(sk-[A-Za-z0-9_-]{8,}|Bearer[[:space:]]+[0-9a-f]{16,})' \
         "$SCRIPT_DIR/agent" "$SCRIPT_DIR/dotagents" | grep -v '<<OBSIDIAN_TOKEN>>'; then
      echo "ВНИМАНИЕ: похоже на секреты в снапшоте — проверь вручную перед коммитом!" >&2
      exit 1
    else
      echo "    чисто"
    fi

    echo "Готово. Дальше: git add pi && git commit -m 'pi: update snapshot' && git push"
    ;;
  *)
    echo "usage: bash backup.sh [--check]" >&2
    exit 2
    ;;
esac
