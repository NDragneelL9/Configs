#!/usr/bin/env node
// WarcraftLogs v2 API runner for the warcraftlogs skill.
// Secrets live in <skill>/secrets.env; the token cache in <skill>/.token.json.
// Both are read here and never printed. The agent only sees this script's
// stdout/stderr and files written via --out.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS_FILE = join(SKILL_DIR, "secrets.env");
const TOKEN_FILE = join(SKILL_DIR, ".token.json");
const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const GQL_URL = "https://www.warcraftlogs.com/api/v2/client";
const UA = "pi-warcraftlogs-skill/1.0";

const USAGE = `usage:
  wcl.mjs check                 verify secrets/token, print rate limit
  wcl.mjs query <file.graphql> [--vars <vars.json>] [--out <out.json>] [--unwind]
    <file.graphql>  GraphQL query file ("-" = stdin)
    --vars <file>   JSON file with query variables
    --out <file>    also save the result JSON here
    --unwind        parse JSON-string fields (table/events "data") into objects

exit codes: 0 ok | 1 generic | 2 secrets problem | 3 oauth problem | 4 graphql problem | 64 usage`;

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadSecrets() {
  if (!existsSync(SECRETS_FILE)) {
    fail(
      `secrets.env not found: ${SECRETS_FILE}\n` +
        `Create it from secrets.example.env and fill WCL_CLIENT_ID / WCL_CLIENT_SECRET\n` +
        `(client credentials: https://www.warcraftlogs.com/api/clients/).\n` +
        `Values are read only by this script — do not paste them into the chat.`,
      2,
    );
  }
  const env = parseEnv(readFileSync(SECRETS_FILE, "utf8"));
  if (!env.WCL_CLIENT_ID || !env.WCL_CLIENT_SECRET) {
    fail(
      `secrets.env exists but WCL_CLIENT_ID / WCL_CLIENT_SECRET are empty.\n` +
        `Fill both values (this script never prints them).`,
      2,
    );
  }
  return env;
}

async function oauthToken(env, force = false) {
  if (!force) {
    try {
      const cached = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
      if (cached.access_token && Date.now() < cached.expires_at - 60_000) {
        return cached.access_token;
      }
    } catch {
      // no usable cache yet
    }
  }
  const basic = Buffer.from(`${env.WCL_CLIENT_ID}:${env.WCL_CLIENT_SECRET}`, "utf8").toString("base64");
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: "grant_type=client_credentials",
    });
  } catch (e) {
    fail(`network error reaching ${TOKEN_URL}: ${e.cause?.code ?? e.message}`, 3);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail(
      `OAuth failed: HTTP ${res.status} ${String(body).slice(0, 300).trim()}\n` +
        `Most likely the client id/secret in secrets.env is wrong or revoked — fix the file.\n` +
        `(This script never prints the secret values.)`,
      3,
    );
  }
  let j;
  try {
    j = await res.json();
  } catch {
    fail("OAuth response was not JSON.", 3);
  }
  if (!j?.access_token) fail("OAuth response contained no access_token.", 3);
  writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 }));
  return j.access_token;
}

async function postGql(token, query, variables) {
  return fetch(GQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables: variables ?? undefined }),
  });
}

async function runQuery(env, query, variables) {
  let token = await oauthToken(env);
  let res = await postGql(token, query, variables).catch((e) => {
    fail(`network error reaching ${GQL_URL}: ${e.cause?.code ?? e.message}`, 3);
  });
  if (res.status === 401) {
    // cached token expired/revoked — force a fresh one and retry once
    token = await oauthToken(env, true);
    res = await postGql(token, query, variables).catch((e) => {
      fail(`network error reaching ${GQL_URL}: ${e.cause?.code ?? e.message}`, 3);
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail(`GraphQL HTTP ${res.status}: ${String(body).slice(0, 300)}`, 4);
  }
  let j;
  try {
    j = await res.json();
  } catch {
    fail("GraphQL response was not JSON.", 4);
  }
  if (j.errors?.length) {
    console.error("GraphQL errors:\n" + JSON.stringify(j.errors, null, 2));
    if (!j.data) process.exit(4);
    console.error("(partial data follows)");
  }
  return j.data ?? {};
}

function unwindStrings(node) {
  if (typeof node === "string") {
    const s = node.trim();
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      try {
        return JSON.parse(s);
      } catch {
        return node;
      }
    }
    return node;
  }
  if (Array.isArray(node)) return node.map(unwindStrings);
  if (node !== null && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = unwindStrings(v);
    return out;
  }
  return node;
}

function readArgFile(flag, p) {
  if (!p) fail(`${flag} needs a file path\n${USAGE}`, 64);
  try {
    return readFileSync(p, "utf8");
  } catch (e) {
    fail(`cannot read ${p}: ${e.message}`, 64);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "check") {
  if (rest.length) fail(USAGE, 64);
  const env = loadSecrets();
  const data = await runQuery(env, `{ rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }`);
  const rl = data?.rateLimitData ?? {};
  console.log(`token: ok`);
  console.log(`rate limit: ${rl.pointsSpentThisHour ?? "?"} / ${rl.limitPerHour ?? "?"} points this hour (resets in ~${Math.round((rl.pointsResetIn ?? 0) / 60)} min)`);
  process.exit(0);
}

if (cmd === "query") {
  const file = rest[0];
  if (!file || file.startsWith("--")) fail(USAGE, 64);
  let variables;
  let outPath;
  let unwind = false;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--vars") {
      const text = readArgFile("--vars", rest[++i]);
      try {
        variables = JSON.parse(text);
      } catch (e) {
        fail(`--vars file is not valid JSON: ${e.message}`, 64);
      }
    } else if (a === "--out") {
      outPath = rest[++i];
      if (!outPath) fail(`--out needs a file path\n${USAGE}`, 64);
    } else if (a === "--unwind") {
      unwind = true;
    } else {
      fail(`unknown option: ${a}\n${USAGE}`, 64);
    }
  }
  const env = loadSecrets();
  const query = file === "-" ? readFileSync(0, "utf8") : readArgFile("<query-file>", file);
  let data = await runQuery(env, query, variables);
  if (unwind) data = unwindStrings(data);
  const json = JSON.stringify(data, null, 2);
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json);
  }
  console.log(json);
  process.exit(0);
}

fail(USAGE, 64);
