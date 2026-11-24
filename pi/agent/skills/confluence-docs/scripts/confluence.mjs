#!/usr/bin/env node
// v2: URL-based Confluence pipeline with OSS sanitization (gitleaks + Presidio).
// The agent works ONLY with sanitized cache files produced here — never with raw pages.
//
// Usage:
//   confluence.mjs check                          — verify environment (fail-closed gate)
//   confluence.mjs fetch <url> [--fresh]          — download + convert + sanitize + cache
//   confluence.mjs fetch <url> --html <file>      — sanitize agent-saved HTML (Chrome MCP fallback)
//   confluence.mjs lookup <term>                  — reverse search in pseudonym mappings
//   confluence.mjs open-mappings                  — open mappings.json in an external viewer
//
// Download strategy: anonymous REST (storage format) -> rendered HTML (#main-content).
// On SSO both fail with exit code 2 and a hint: agent must save the page HTML via
// Chrome (chrome-devtools MCP) and re-run with --html <file>.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import domino from 'domino';
import TurndownService from 'turndown';
import * as gfmPkg from 'turndown-plugin-gfm';

process.noDeprecation = true;
const here = dirname(fileURLToPath(import.meta.url));
const VENV_DIR = join(homedir(), '.pi', 'agent', '.venvs', 'confluence-docs');
const VENV_PY = join(VENV_DIR, 'Scripts', 'python.exe');
const CACHE = join(homedir(), '.cache', 'confluence-docs');
mkdirSync(CACHE, { recursive: true });
const gfm = gfmPkg.gfm || gfmPkg.default?.gfm || gfmPkg.default;
const IS_WIN = process.platform === 'win32';

const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const TTL_MS = (config.ttl_hours ?? 24) * 3600 * 1000;
const HALT_THRESHOLD = config.secrets_halt_threshold ?? 5;

const die = (msg, code = 1) => { console.error(String(msg)); process.exit(code); };
const sh = (cmd, args, opts = {}) => {
  const quoted = args.map((a) => (/"|[\s&|<>()^%]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a)));
  return spawnSync(cmd, quoted, { encoding: 'utf8', shell: IS_WIN, ...opts });
};

// ---------- URL helpers ----------

function urlInfo(rawUrl) {
  const u = new URL(rawUrl);
  let origin = u.origin;
  if (/atlassian\.net/.test(origin)) origin += '/wiki';
  const m = u.href.match(/\/pages\/(\d+)/) || u.search.match(/pageId=(\d+)/);
  const pageId = m ? m[1] : null;
  const key = pageId || createHash('sha1').update(rawUrl).digest('hex').slice(0, 10);
  return { origin, pageId, key, rest: origin };
}

async function restGet(origin, path, timeoutMs = 8000) {
  const res = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- storage-format preprocessing -> plain HTML (kept from v1) ----------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const textOf = (s) => cdata(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function preprocess(html) {
  html = html.replace(/<ri:user[^>]*\/?>/g, '[USER]');
  html = html.replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (m, inner) => {
    const lang = (inner.match(/<ac:parameter ac:name="language">([^<]*)</) || [])[1] || '';
    const body = (inner.match(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/)
      || inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/) || [, inner])[1];
    const code = esc(cdata(body).replace(/<[^>]+>/g, ''));
    const l = lang.replace(/[^a-z0-9+#.-]/gi, '').toLowerCase();
    return `\n<pre><code class="language-${l}">${code}</code></pre>\n`;
  });
  html = html.replace(/<ac:structured-macro[^>]*ac:name="(info|note|tip|warning)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (m, kind, inner) => {
    const body = (inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/) || [, inner])[1];
    const label = { info: 'Info', note: 'Note', tip: 'Tip', warning: '⚠️ Warning' }[kind];
    return `<blockquote><p><strong>${label}:</strong> ${textOf(body)}</p></blockquote>`;
  });
  html = html.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/g, (m, inner) => {
    const title = (inner.match(/ri:content-title="([^"]*)"/) || [])[1] || 'page';
    const label = textOf(inner) || title;
    return `<a href="${esc(title)}">${esc(label)}</a>`;
  });
  html = html.replace(/<ac:image[\s\S]*?(?:\/>|<\/ac:image>)/g, (m) => {
    const alt = (m.match(/alt="([^"]*)"/) || [])[1];
    return `<p>[image${alt ? `: ${alt}` : ''}]</p>`;
  });
  html = html.replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/g, (m) => ` ${textOf(m)} `);
  html = html.replace(/<\/?a[cr]:[^>]*>/g, '');
  html = cdata(html);
  return html;
}

function mainContent(html) {
  try {
    const doc = new domino.DOMParser().parseFromString(html, 'text/html');
    const el = doc.getElementById('main-content');
    if (el && el.innerHTML.trim()) return el.innerHTML;
  } catch { /* fall through */ }
  return null;
}

function toMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  if (gfm) td.use(gfm);
  return td.turndown(html);
}

const slug = (s) => s.toLowerCase().replace(/[^\wа-яё.-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'untitled';

// ---------- download ----------

async function download(url, u) {
  // 1) anonymous REST, storage format (cleanest)
  if (u.pageId) {
    try {
      const j = await restGet(u.origin, `/rest/api/content/${u.pageId}?expand=body.storage,title,version`);
      return { html: j.body.storage.value, title: j.title || u.pageId, version: j.version?.number ?? null };
    } catch { /* fall through */ }
    try { // cheap version probe is done by caller only when cached
      void 0;
    } catch { /* noop */ }
  }
  // 2) rendered page
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
    const html = await res.text();
    if (/id="login"|loginsitemap|ssologin/i.test(html.slice(0, 5000))) {
      return { sso: true };
    }
    const mc = mainContent(html);
    if (mc) {
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1]?.trim() || u.pageId || 'page';
      return { html: mc, title, version: null };
    }
  } catch { /* fall through */ }
  return { sso: true };
}

// ---------- sanitizers ----------

function runGitleaks(mdText) {
  const tmp = join(CACHE, `.tmp-gl-${Date.now()}.json`);
  try {
    const r = sh('gitleaks', ['stdin', '--report-format', 'json', '--report-path', tmp], { input: mdText });
    // exit codes: 0 = clean, 1 = findings, others = tool error
    if (r.status !== 0 && r.status !== 1) die(`gitleaks failed (code ${r.status}): ${r.stderr}`);
    if (!existsSync(tmp)) return [];
    const findings = JSON.parse(readFileSync(tmp, 'utf8'));
    const wl = (config.whitelist || []).map((w) => new RegExp(w, 'i'));
    const kept = findings.filter((f) => !wl.some((re) => re.test(f.Secret || '')));
    return kept.map((f) => ({ rule: f.RuleID, secret: f.Secret || '' }));
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function runPresidio(mdText, outPath, reportPath) {
  const r = sh(VENV_PY, [join(here, 'presidio_redact.py'), '--out', outPath, '--report', reportPath],
    { input: mdText, timeout: 180000 });
  if (r.status !== 0) die(`presidio_redact failed (code ${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

// ---------- commands ----------

function check() {
  const comp = {};
  const gl = sh('gitleaks', ['version']);
  comp.gitleaks = gl.status === 0 ? gl.stdout.trim() : 'MISSING';
  comp.venv_python = existsSync(VENV_PY);
  if (comp.venv_python) {
    const imp = sh(VENV_PY, ['-c', 'import presidio_analyzer, presidio_anonymizer']);
    comp.presidio = imp.status === 0;
    const sp = join(VENV_DIR, 'Lib', 'site-packages');
    comp.spacy_ru = readdirSync(sp).some((d) => d.startsWith('ru_core_news_lg'));
    comp.spacy_en = readdirSync(sp).some((d) => d.startsWith('en_core_web_lg'));
  } else {
    comp.presidio = false; comp.spacy_ru = false; comp.spacy_en = false;
  }
  comp.config = !!config;
  const ok = comp.gitleaks !== 'MISSING' && comp.venv_python && comp.presidio && comp.spacy_ru && comp.spacy_en;
  console.log(JSON.stringify({
    ok, components: comp, cacheDir: CACHE,
    cachedPages: readdirSync(CACHE).filter((f) => f.endsWith('.md')).length,
    ttl_hours: config.ttl_hours ?? 24, secrets_halt_threshold: HALT_THRESHOLD,
  }));
  if (!ok) process.exit(1);
}

async function versionProbe(u) {
  if (!u.pageId) return null;
  try {
    const j = await restGet(u.origin, `/rest/api/content/${u.pageId}?expand=version`, 4000);
    return j.version?.number ?? null;
  } catch { return undefined; } // undefined = probe unavailable
}

async function fetchPage(rawUrl, { fresh, htmlFile }) {
  const u = urlInfo(rawUrl);
  const metaPath = join(CACHE, `${u.key}.meta.json`);
  const serve = (meta, cached = true) => console.log(JSON.stringify({
    key: u.key, title: meta.title, cached, mdPath: meta.mdPath,
    reportPath: meta.reportPath, fetchedAt: meta.fetchedAt,
    unique_secrets: meta.unique_secrets, counts: meta.counts, halted: meta.halted === true,
  }));

  if (existsSync(metaPath) && !fresh && !htmlFile) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const ver = await versionProbe(u);
    const age = Date.now() - new Date(meta.fetchedAt).getTime();
    if (ver === meta.version || (ver !== undefined && age < TTL_MS) || (ver === undefined && age < TTL_MS)) {
      return serve(meta);
    }
  }

  let html, title, version = null;
  if (htmlFile) {
    html = readFileSync(htmlFile, 'utf8');
    const mc = mainContent(html);
    html = mc || html;
    title = (html.match(/<title>([^<]*)<\/title>/) || [])[1]?.trim() || `saved:${u.pageId || 'page'}`;
  } else {
    const d = await download(rawUrl, u);
    if (d.sso) {
      die('SSO/login page detected or page unreachable. Fallback: open the URL in Chrome via the '
        + 'chrome-devtools MCP skill, save the rendered HTML (document.documentElement.outerHTML) '
        + 'to a file, then re-run: confluence.mjs fetch <url> --html <file>', 2);
    }
    ({ html, title, version } = d);
  }

  const mdBody = toMarkdown(preprocess(html));
  const md = `# ${title}\n\n${mdBody}\n`;

  const glFindings = runGitleaks(md);
  const uniqSecrets = new Set(glFindings.map((f) => f.secret));

  const base = join(CACHE, `${u.key}-${slug(title)}`);
  const presReportTmp = join(CACHE, `.tmp-pres-${Date.now()}.json`);
  let pres;
  try {
    pres = runPresidio(md, `${base}.md`, presReportTmp);
    const presReport = JSON.parse(readFileSync(presReportTmp, 'utf8'));
    var presFindings = presReport.findings || [];
    var pseudonymsAdded = presReport.pseudonyms_added || [];
  } finally {
    if (existsSync(presReportTmp)) rmSync(presReportTmp, { force: true });
  }

  const counts = { ...pres.counts };
  for (const f of glFindings) counts[`gitleaks:${f.rule}`] = (counts[`gitleaks:${f.rule}`] || 0) + 1;
  const total = pres.total + glFindings.length;
  const uniqueSecrets = uniqSecrets.size + (pres.unique_secret_count || 0);
  const halted = uniqueSecrets > HALT_THRESHOLD;

  const report = [
    `# Sanitizer report — ${title} (key ${u.key})`,
    `source: ${rawUrl}`,
    `fetched: ${new Date().toISOString()}${version !== null ? `, page version ${version}` : ''}`,
    `total redactions: ${total} (unique secrets: ${uniqueSecrets}${halted ? ' — ABOVE THRESHOLD, halted' : ''})`,
    ...Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`),
    '',
    '## presidio findings (masked samples only)',
    ...presFindings.map((f) => `- [${f.type}] ${f.masked}`),
    '',
    '## gitleaks findings (rule + masked secret)',
    ...glFindings.map((f) => `- [${f.rule}] ${f.secret.length > 6 ? f.secret.slice(0, 2) + '***' + f.secret.slice(-1) : '***'}`),
    '',
    '## pseudonyms added',
    ...pseudonymsAdded.map((p) => `- ${p.pseudo} (${p.type})`),
    '',
    'Raw values are not stored anywhere except the local pseudonym mappings file.',
  ].join('\n');
  writeFileSync(`${base}.report.txt`, report, 'utf8');

  const meta = {
    key: u.key, url: rawUrl, title, fetchedAt: new Date().toISOString(), version,
    mdPath: `${base}.md`, reportPath: `${base}.report.txt`,
    counts, total, unique_secrets: uniqueSecrets, halted,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 1), 'utf8');

  console.log(JSON.stringify({
    key: u.key, title, cached: false, mdPath: meta.mdPath, reportPath: meta.reportPath,
    fetchedAt: meta.fetchedAt, unique_secrets: uniqueSecrets, counts, halted,
  }));
}

function lookup(term) {
  const p = join(CACHE, 'mappings.json');
  if (!existsSync(p)) return console.log(JSON.stringify({ matches: [] }));
  const mapping = JSON.parse(readFileSync(p, 'utf8'));
  const t = term.toLowerCase();
  const matches = mapping.filter((e) => e.real.toLowerCase() === t || e.pseudo.toLowerCase() === t)
    .map((e) => ({ real: e.real, pseudo: e.pseudo, type: e.type }));
  console.log(JSON.stringify({ matches, note: 'value has entered the agent context on explicit request' }));
}

function openMappings() {
  const p = join(CACHE, 'mappings.json');
  if (!existsSync(p)) return console.log(JSON.stringify({ opened: false, reason: 'no mappings yet' }));
  sh('cmd', ['/c', 'start', '', p]);
  console.log(JSON.stringify({ opened: true, path: p, note: 'opened in external viewer; contents never entered agent context' }));
}

const [, , cmd, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const htmlIdx = rest.indexOf('--html');
const htmlFile = htmlIdx >= 0 ? rest[htmlIdx + 1] : null;

if (cmd === 'check') check();
else if (cmd === 'fetch' && args[0]) fetchPage(args[0], { fresh: flags.has('--fresh'), htmlFile }).catch((e) => die(e.message));
else if (cmd === 'lookup' && args[0]) lookup(args[0]);
else if (cmd === 'open-mappings') openMappings();
else die('usage: confluence.mjs <check | fetch <url> [--fresh] [--html file] | lookup <term> | open-mappings>');
