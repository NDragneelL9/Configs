#!/usr/bin/env bash
# Дневная заметка Obsidian: обеспечить существование и выдать данные для правок.
# Шаг 1 лестницы из SKILL.md: создать при отсутствии, дождаться рендера Templater,
# напечатать путь и точную строку заголовка для цепочки vault_patch.
#
# Использование:
#   daily.sh <YYYY-MM-DD | today | yesterday | tomorrow>
# Примеры:
#   daily.sh 2026-11-30
#   daily.sh today
#
# stdout (ключ=значение):
#   path=01-Daily/20261130.md            — путь в vault для vault_read/vault_patch
#   created=true|false                   — создана ли заметка этим вызовом
#   heading=Monday, November 30th, 2026  — текст заголовка "## <heading>" для target-цепочки
#
# Ключ и CA-сертификат подставляются автоматически (как в api.sh). HTTP-клиент — node fetch.
set -euo pipefail

ARG="${1:?usage: daily.sh <YYYY-MM-DD|today|yesterday|tomorrow>}"
FILE="$(date -d "$(echo "$ARG" | tr -d '-')" +%Y%m%d 2>/dev/null)" || {
  echo "ERR: не понял дату '$ARG' — жду YYYY-MM-DD или today|yesterday|tomorrow" >&2
  exit 1
}

export OBS_KEY="$(node -e "console.log(JSON.parse(require('fs').readFileSync('D:/Z/ObVault/.obsidian/plugins/obsidian-local-rest-api/data.json','utf8')).apiKey)")"
export NODE_EXTRA_CA_CERTS="C:/Users/JohnDoe_it/.pi/agent/obsidian-local-rest-api.crt"
# URL собираем до экспорта — Git Bash конвертирует значения-пути вроде "/vault/..." в Windows-пути
export BASE="https://127.0.0.1:27124"
export FILE
export Y="${FILE:0:4}" M="${FILE:4:2}" D="${FILE:6:2}"

exec node -e '
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hdr = { Authorization: "Bearer " + process.env.OBS_KEY };
const call = async (method, path, body) => {
  const r = await fetch(process.env.BASE + path, {
    method,
    headers: body === undefined ? hdr : { ...hdr, "Content-Type": "text/markdown" },
    body: body === undefined ? undefined : body,
  });
  return { status: r.status, text: await r.text() };
};
(async () => {
  const vp = "/vault/01-Daily/" + process.env.FILE + ".md";
  let r = await call("GET", vp);
  let created = false;
  if (r.status === 404) {
    const p = await call("POST", `/periodic/daily/${process.env.Y}/${process.env.M}/${process.env.D}/`, "");
    if (p.status !== 204) throw new Error("POST создания вернул HTTP " + p.status + ": " + p.text);
    created = true;
  } else if (r.status !== 200) {
    throw new Error("GET заметки вернул HTTP " + r.status + ": " + r.text);
  }
  // ждём появления файла и завершения асинхронного рендера Templater (исчезновение "<%")
  let text = "";
  const deadline = Date.now() + 15000;
  for (;;) {
    await sleep(200);
    r = await call("GET", vp);
    if (r.status === 200 && !r.text.includes("<%")) { text = r.text; break; }
    if (Date.now() > deadline) throw new Error("заметка не появилась или не отрендерилась за 15 c");
  }
  const m = text.match(/(?:^|\n)## (.+)/);
  if (!m) throw new Error("в заметке нет строки \"## <заголовок>\" — проверьте шаблон _Templates/Daily.md");
  console.log("path=01-Daily/" + process.env.FILE + ".md");
  console.log("created=" + created);
  console.log("heading=" + m[1].trim());
})().catch((e) => {
  const code = e.cause ? (e.cause.code || e.cause.message) : "";
  console.error("ERR: " + e.message + (code ? " (" + code + ")" : ""));
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(e.message + " " + code))
    console.error("Obsidian запущен? Плагин Local REST API не отвечает на https://127.0.0.1:27124");
  process.exit(1);
});
'
