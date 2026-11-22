#!/usr/bin/env bash
# Ждёт завершения асинхронного рендера Templater во freshly-созданной заметке.
# Поллит заметку каждые 150 мс, пока в содержимом есть сырой синтаксис "<%".
#
# Использование:
#   wait_render.sh <путь-в-vault> [таймаут-сек] [интервал-мс]
# Пример:
#   wait_render.sh 01-Daily/20261110.md
#
# Выход: 0 — отрендерено (печатае� elapsed), 1 — таймаут.
set -euo pipefail

PATH_IN_VAULT="${1:?usage: wait_render.sh <vault-path> [timeout-sec] [interval-ms]}"
TIMEOUT_S="${2:-10}"
INTERVAL_MS="${3:-150}"

export OBS_KEY="$(node -e "console.log(JSON.parse(require('fs').readFileSync('D:/Z/ObVault/.obsidian/plugins/obsidian-local-rest-api/data.json','utf8')).apiKey)")"
export NODE_EXTRA_CA_CERTS="C:/Users/JohnDoe_it/.pi/agent/obsidian-local-rest-api.crt"
# полный URL собираем до экспорта — Git Bash конвертирует значения-пути в Windows-пути
export FULLURL="https://127.0.0.1:27124/vault/${PATH_IN_VAULT}"
export TIMEOUT_S INTERVAL_MS

exec node -e '
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const deadline = Date.now() + Number(process.env.TIMEOUT_S) * 1000;
  const iv = Number(process.env.INTERVAL_MS);
  let checks = 0;
  while (Date.now() < deadline) {
    await sleep(iv);
    checks++;
    const r = await fetch(process.env.FULLURL, {
      headers: { Authorization: "Bearer " + process.env.OBS_KEY },
    });
    if (r.status === 404) {
      console.error("файл не найден (404)");
      process.exit(1);
    }
    const text = await r.text();
    if (!text.includes("<%")) {
      console.log("отрендерено за " + (Date.now() - (deadline - Number(process.env.TIMEOUT_S) * 1000)) + " мс (проверок: " + checks + ")");
      process.exit(0);
    }
  }
  console.error("ТАЙМАУТ " + process.env.TIMEOUT_S + " c — синтаксис <%-так и не исчез");
  process.exit(1);
})().catch((e) => {
  console.error("ERR: " + e.message + (e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""));
  process.exit(1);
});
'
