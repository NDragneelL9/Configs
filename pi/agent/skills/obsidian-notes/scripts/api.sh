#!/usr/bin/env bash
# Обёртка над Obsidian Local REST API (https://127.0.0.1:27124).
# Ключ и CA-сертификат подставляются автоматически; HTTP-клиент — node fetch
# (curl на Channel в Windows плохо работает с локальным CA плагина).
#
# Использование:
#   api.sh METHOD PATH                # без тела
#   api.sh METHOD PATH BODY [CT]      # с телом (CT по умолчанию text/markdown)
#
# Примеры:
#   api.sh GET  /vault/01-Daily/
#   api.sh POST /periodic/daily/2026/11/10/ ""                      # создать дневную из шаблона
#   api.sh PATCH /vault/01-Daily/20261110.md '{"targetType":"heading","target":["DAILY NOTE","Tasks"],"operation":"append","content":"- [ ] пункт"}' application/json
set -euo pipefail

METHOD="${1:?usage: api.sh METHOD PATH [BODY] [CONTENT-TYPE]}"
APIPATH="${2:?usage: api.sh METHOD PATH [BODY] [CONTENT-TYPE]}"
# Пустое тело ("") — это «тело предоставлено, оно пустое» (нужно для POST-создания);
# отсутствие аргумента — тела нет вообще
BODY_SET=0
if [ $# -ge 3 ]; then BODY="$3"; BODY_SET=1; else BODY=""; fi
CT="${4:-text/markdown}"

export OBS_KEY="$(node -e "console.log(JSON.parse(require('fs').readFileSync('D:/Z/ObVault/.obsidian/plugins/obsidian-local-rest-api/data.json','utf8')).apiKey)")"
export NODE_EXTRA_CA_CERTS="C:/Users/JohnDoe_it/.pi/agent/obsidian-local-rest-api.crt"
# Важно: собираем полный URL до экспорта — Git Bash (MSYS) конвертирует
# значения-пути вроде "/vault/..." в Windows-пути при передаче в node.exe
export FULLURL="https://127.0.0.1:27124${APIPATH}"
export METHOD BODY CT BODY_SET

exec node -e '
(async () => {
  const r = await fetch(process.env.FULLURL, {
    method: process.env.METHOD,
    headers: {
      Authorization: "Bearer " + process.env.OBS_KEY,
      ...(process.env.BODY_SET === "1" ? { "Content-Type": process.env.CT } : {}),
    },
    body: process.env.BODY_SET === "1" ? (process.env.BODY || "") : undefined,
  });
  const loc = r.headers.get("content-location");
  if (loc) console.error("Content-Location: " + loc);
  const text = await r.text();
  if (text) console.log(text);
  console.error("[HTTP " + r.status + "]");
})().catch((e) => {
  console.error("ERR: " + e.message + (e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""));
  process.exit(1);
});
'
