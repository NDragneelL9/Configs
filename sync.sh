#!/usr/bin/env bash
# Синк pwsh-профиля и omp-темы с этой машины в этот репозиторий.
# Пара едет вместе: профиль грузит тему из $PSScriptRoot.
# Запуск:
#   bash sync.sh          — обновить копии в репо
#   bash sync.sh --check  — проверка дрейфа: свежие копии в temp + diff с репо;
#                           репо не трогает; exit 0 = дрейфа нет, exit 1 = есть
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PS_DIR="$HOME/Documents/PowerShell"

FILES=(Microsoft.PowerShell_profile.ps1 dragneell9.omp.json)

# make_snapshot <dst_root> — свежие копии живых файлов в <dst_root>.
# Тот же путь для записи в репо и для --check.
make_snapshot() {
  local root="$1"
  mkdir -p "$root"
  for f in "${FILES[@]}"; do
    if [ ! -f "$PS_DIR/$f" ]; then
      echo "ERROR: $PS_DIR/$f не найден — а это живой рабочий файл" >&2
      exit 1
    fi
    cp "$PS_DIR/$f" "$root/$f"
  done
}

# check_drift — копии в temp, сравнение с репо.
# Вывод: M <файл> (изменился), + <файл> (вживую есть, в репо нет).
check_drift() {
  local tmp out=""
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  make_snapshot "$tmp"

  for f in "${FILES[@]}"; do
    if [ ! -f "$SCRIPT_DIR/$f" ]; then
      out+="+ $f"$'\n'
    elif ! diff -q "$tmp/$f" "$SCRIPT_DIR/$f" >/dev/null; then
      out+="M $f"$'\n'
    fi
  done
  out="${out%$'\n'}"

  if [ -z "$out" ]; then
    echo "Дрейфа нет: копии в репо соответствуют живым файлам."
    exit 0
  fi

  echo "ДРЕЙФ — живые файлы ушли от копий в репо:"
  printf '%s\n' "$out"
  echo
  echo "Если дрейф осознанный: bash sync.sh && git add -A && git commit -m 'sync: pwsh + omp' && git push"
  exit 1
}

case "${1:-}" in
  --check)
    check_drift
    ;;
  "")
    make_snapshot "$SCRIPT_DIR"
    echo "Готово. Дальше: git add -A && git commit -m 'sync: pwsh + omp' && git push"
    ;;
  *)
    echo "usage: bash sync.sh [--check]" >&2
    exit 2
    ;;
esac
