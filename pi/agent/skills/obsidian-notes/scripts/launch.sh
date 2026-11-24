#!/usr/bin/env bash
# Запустить Obsidian (если ещё не запущен) и дождаться готовности Local REST API.
# Шаг 0 скилла obsidian-notes: агент поднимает Obsidian сам, не спрашивая пользователя.
#
# stdout (ключ=значение):
#   up=already   — Obsidian уже был запущен, API отвечает
#   up=launched  — Obsidian запустили сейчас и дождались API
# ERR: ... (exit 1) — API не ответил за 60 с после запуска (плагин Local REST API выключен?)
set -euo pipefail

EXE="C:/Program Files/Obsidian/Obsidian.exe"
[ -f "$EXE" ] || { echo "ERR: не нашёл Obsidian.exe по пути $EXE — обнови путь в launch.sh" >&2; exit 1; }

export OBS_KEY="$(node -e "console.log(JSON.parse(require('fs').readFileSync('D:/Z/ObVault/.obsidian/plugins/obsidian-local-rest-api/data.json','utf8')).apiKey)")"
export NODE_EXTRA_CA_CERTS="C:/Users/JohnDoe_it/.pi/agent/obsidian-local-rest-api.crt"
# URL собираем до экспорта — Git Bash (MSYS) конвертирует значения-пути при передаче в node.exe
export BASE="https://127.0.0.1:27124"
export EXE

exec node -e '
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ping = async () => {
  try {
    const r = await fetch(process.env.BASE + "/", { headers: { Authorization: "Bearer " + process.env.OBS_KEY } });
    return r.status < 500; // любой ответ, включая 401 — API жив
  } catch {
    return false;
  }
};
(async () => {
  if (await ping()) { console.log("up=already"); return; }
  // detached: Obsidian переживает завершение скрипта и bash-сессии
  require("child_process").spawn(process.env.EXE, [], { detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + 60000;
  for (;;) {
    await sleep(1000);
    if (await ping()) { console.log("up=launched"); return; }
    if (Date.now() > deadline)
      throw new Error("Local REST API (https://127.0.0.1:27124) не ответил за 60 с после запуска Obsidian — проверь, включён ли плагин Local REST API");
  }
})().catch((e) => {
  const code = e.cause ? (e.cause.code || e.cause.message) : "";
  console.error("ERR: " + e.message + (code ? " (" + code + ")" : ""));
  process.exit(1);
});
'
