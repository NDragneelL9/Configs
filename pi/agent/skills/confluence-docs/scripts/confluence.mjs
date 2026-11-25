#!/usr/bin/env node
// v3: manual-download Confluence pipeline. SSO blocks scripted fetching, so the
// user exports pages by hand (Export to Word / Ctrl+S HTML); this tool converts
// them to markdown and gates the agent read with gitleaks + a suspects scan.
//
// Trust model: PII stripping is manual (fail-visible — the suspects list guides
// the user), secrets detection stays automatic (fail-closed).
//
// Usage:
//   confluence.mjs check                          — verify environment
//   confluence.mjs to-md <in.doc|in.docx|in.html> [--out <file.md>]
//                                                  — convert, then auto-run mdcheck
//                                                  on the output: report merged
//                                                  into the JSON, exit code =
//                                                  mdcheck's (0/1/3), so a dirty
//                                                  md is never read by a chained
//                                                  command (2 = conversion error)
//   confluence.mjs mdcheck <file.md>              — gate: exit 0 clean,
//                                                  1 secrets (hard stop),
//                                                  2 tool error, 3 suspects only
//   confluence.mjs stats <file.md>                — structure counters only
//                                                  (lines/tables/duplicates/css);
//                                                  never prints content — the one
//                                                  sanctioned look at an un-gated
//                                                  to-md output

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import domino from 'domino';
import TurndownService from 'turndown';
import * as gfmPkg from 'turndown-plugin-gfm';
import mammoth from 'mammoth';

process.noDeprecation = true;
const here = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const gfm = gfmPkg.gfm || gfmPkg.default?.gfm || gfmPkg.default;
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));

const die = (msg, code = 2) => { console.error(String(msg)); process.exit(code); };
const sh = (cmd, args, opts = {}) => {
  const quoted = args.map((a) => (/"|[\s&|<>()^%]/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a)));
  return spawnSync(cmd, quoted, { encoding: 'utf8', shell: IS_WIN, ...opts });
};

// ---------- HTML -> markdown (kept from v2: proven Confluence handling) ----------

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
  return cdata(html);
}

function mainContent(html) {
  try {
    const doc = domino.createDocument(html);
    const el = doc.getElementById('main-content');
    if (el && el.innerHTML.trim()) return el.innerHTML;
  } catch { /* fall through */ }
  return null;
}

function fixTables(html) {
  // gfm-таблицы требуют: первая строка из <th>, внутри ячеек нет блочных <p>/<div>
  // и переносов строк (иначе строка таблицы разваливается на абзацы).
  // mammoth даёт всё <td>+<p>; Confluence — вложенные <div> в ячейках (старый
  // вариант молча падал в domino на них и отдавал исходный HTML).
  try {
    const doc = domino.createDocument(`<div id="__fix">${html}</div>`);
    const root = doc.getElementById('__fix');
    const arr = (nl) => Array.prototype.slice.call(nl);
    const inNestedTable = (el, c) => {
      let n = el.parentNode;
      while (n && n !== c) { if (n.nodeName === 'TABLE') return true; n = n.parentNode; }
      return false;
    };
    const unwrapBlock = (el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    };
    for (const t of arr(root.getElementsByTagName('table'))) {
      for (const c of arr(t.getElementsByTagName('td')).concat(arr(t.getElementsByTagName('th')))) {
        if (c.getElementsByTagName('table').length) continue; // вложенные таблицы не трогаем
        let changed = true;
        while (changed) {
          changed = false;
          for (const el of arr(c.getElementsByTagName('p')).concat(arr(c.getElementsByTagName('div')))) {
            if (inNestedTable(el, c)) continue;
            unwrapBlock(el); changed = true;
          }
          for (const br of arr(c.getElementsByTagName('br'))) {
            if (inNestedTable(br, c) || !br.parentNode) continue;
            br.parentNode.insertBefore(doc.createTextNode(' '), br);
            br.parentNode.removeChild(br); changed = true;
          }
        }
        // нормализуем пробелы: строка таблицы обязана быть однострочной
        const walk = (n) => {
          for (const child of arr(n.childNodes)) {
            if (child.nodeType === 3) child.data = child.data.replace(/\s+/g, ' ');
            else if (child.nodeName !== 'TABLE') walk(child);
          }
        };
        walk(c);
        while (c.firstChild && c.firstChild.nodeType === 3 && !c.firstChild.data.trim()) c.removeChild(c.firstChild);
        while (c.lastChild && c.lastChild.nodeType === 3 && !c.lastChild.data.trim()) c.removeChild(c.lastChild);
      }
      const rows = arr(t.getElementsByTagName('tr'));
      if (!rows.length) continue;
      const kids = arr(rows[0].childNodes).filter((n) => n.nodeName === 'TD' || n.nodeName === 'TH');
      if (kids.length && kids.every((n) => n.nodeName === 'TD')) {
        for (const td of kids) {
          const th = doc.createElement('th');
          for (let i = 0; i < td.attributes.length; i++) th.setAttribute(td.attributes[i].name, td.attributes[i].value);
          while (td.firstChild) th.appendChild(td.firstChild);
          td.parentNode.replaceChild(th, td);
        }
      }
    }
    return root.innerHTML;
  } catch { /* fall through */ }
  return html;
}

function toMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  if (gfm) td.use(gfm);
  return td.turndown(fixTables(html));
}

// ---------- MHT (Confluence "Export to Word" = MIME + quoted-printable HTML) ----------

function extractMht(buf) {
  const raw = buf.toString('latin1');
  const sep = raw.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const hEnd = raw.indexOf(sep);
  if (hEnd < 0) return null;
  const headers = raw.slice(0, hEnd);
  if (!/^\s*(?:HTTP\/[\d.]+|Date:|MIME-Version:|Subject:|Message-ID:)/mi.test(headers)) return null;
  const body = raw.slice(hEnd + sep.length);
  const ct = (headers.match(/content-type:\s*([^\r\n;]+)/i) || [])[1] || '';
  const b = (headers.match(/boundary="?([^"\r\n;]+)"?/i) || [])[1];
  const parts = [];
  if (/multipart/i.test(ct) && b) {
    for (const part of body.split('--' + b)) {
      const pSep = part.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
      const pEnd = part.indexOf(pSep);
      if (pEnd < 0) continue;
      parts.push({ headers: part.slice(0, pEnd), body: part.slice(pEnd + pSep.length) });
    }
  } else parts.push({ headers, body });
  for (const p of parts) {
    if (!/content-type:\s*text\/html/i.test(p.headers)) continue;
    let t = p.body.replace(/--\s*$/, '').replace(/\r?\n$/, '');
    const enc = (p.headers.match(/content-transfer-encoding:\s*(\S+)/i) || [])[1] || '';
    if (/quoted-printable/i.test(enc)) {
      t = t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(t, 'latin1').toString('utf8');
    }
    if (/base64/i.test(enc)) return Buffer.from(t.replace(/\s+/g, ''), 'base64').toString('utf8');
    return Buffer.from(t, 'latin1').toString('utf8');
  }
  return null;
}

function preprocessWordHtml(html) {
  // mso/Word-мусор: условные комментарии, xml-острова, имена-пространства o:/v:/w:, link/meta
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
  let body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
  body = body
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<xml[\s\S]*?<\/xml>/gi, '')
    .replace(/<\/?(?:o|v|w|m|st1|st2):[^>]*>/gi, '')
    .replace(/<(?:link|meta)[^>]*>/gi, '');
  return { title, body };
}

async function toMd(input, out) {
  const abs = resolve(input);
  if (!existsSync(abs)) die(`no such file: ${abs}`);
  const buf = readFileSync(abs);
  const sniff = buf.subarray(0, 512).toString('latin1');
  let html, title = null;
  if (/^\s*(?:HTTP\/[\d.]+|Date:|MIME-Version:|Subject:|Message-ID:)/mi.test(sniff)) {
    const mht = extractMht(buf);
    if (!mht) die('MIME-saved file detected, but no text/html part found');
    ({ body: html, title } = preprocessWordHtml(mht));
  } else if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const r = await mammoth.convertToHtml({ buffer: buf });
    html = r.value.replace(/<img[^>]*>/g, '[image]');
  } else if (/^\s*</.test(sniff)) { // HTML: первый значимый символ — тег (doctype/html/head/h2/…)
    const raw = buf.toString('utf8');
    html = mainContent(raw) || raw;
    title = (raw.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
    html = preprocess(html);
  } else {
    die(`unsupported input (extension ${extname(abs)}): expected .docx, .html or a Confluence Word export (.doc = MHT)`);
  }
  let mdBody = toMarkdown(html).trim();
  mdBody = mdBody.replace(/^#+\s*$/gm, '').replace(/\n{3,}/g, '\n\n');
  const md = (title ? `# ${title}\n\n` : '') + mdBody + '\n';
  const outPath = out ? resolve(out) : join(dirname(abs), basename(abs, extname(abs)) + '.md');
  writeFileSync(outPath, md, 'utf8');
  // Gate is part of conversion: exit code = mdcheck's, so `to-md x && cat x.md`
  // can never reach a dirty output. The md itself is still written — the user
  // cleans it by hand (fail-visible).
  const gate = runMdCheck(outPath);
  console.log(JSON.stringify({ mdPath: outPath, lines: md.split('\n').length, mdcheck: gate.report }, null, 1));
  if (gate.code !== 0) {
    console.error(`⚠ to-md output is NOT clean (mdcheck exit ${gate.code}) — agent must not read it; hand the masked suspects to the user (SKILL step 3)`);
  }
  process.exit(gate.code);
}

// ---------- mdcheck: gitleaks (fail-closed) + suspects (fail-visible) ----------

const mask = (v) => {
  if (!v) return '***';
  if (v.length <= 4) return '***';
  const at = v.indexOf('@');
  if (at > 0 && v.indexOf('.', at) > at) return v.slice(0, 1) + '***@' + v.slice(at + 1);
  return v.slice(0, 2) + '***' + v.slice(-1);
};

const whitelisted = (v) => (config.whitelist || []).some((w) => new RegExp(w, 'i').test(v));

function runGitleaks(mdText) {
  const tmp = join(tmpdir(), `.gl-${Date.now()}.json`);
  try {
    const r = sh('gitleaks', ['stdin', '--report-format', 'json', '--report-path', tmp], { input: mdText });
    if (r.status !== 0 && r.status !== 1) die(`gitleaks failed (code ${r.status}): ${r.stderr}`, 2);
    if (!existsSync(tmp)) return [];
    return JSON.parse(readFileSync(tmp, 'utf8'))
      .map((f) => ({ type: `gitleaks:${f.RuleID}`, value: f.Secret || '' }))
      .filter((f) => f.value && !whitelisted(f.value));
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

const SLAV = ['ov', 'ev', 'yn', 'sky', 'ski', 'enko', 'ina', 'ova', 'eva', 'yuk', 'uk', 'ko', 'tsev', 'chev', 'vich', 'ich', 'aya', 'in'];
const STOPLIST = new Set(['login', 'admin', 'main', 'domain', 'token', 'plugin', 'margin', 'cabin', 'ukraine']);
const hasSlavSuffix = (w) => w.length >= 5 && SLAV.some((s) => w.toLowerCase().endsWith(s)) && !STOPLIST.has(w.toLowerCase());

const SECRET_PATTERNS = [
  ['JWT', /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g],
  ['URL_CREDS', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi],
  ['API_KEY', /\b(?:sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{10,})\b/g],
  ['CRED_KEYWORD', /(?<![а-яА-ЯёЁ\w])(?:парол|секрет|токен|password|passwd|pwd|secret|token|api[_-]?key)[^.\n]{0,40}?[:=]\s*[^\s"'«»]{4,}/gi],
  ['CRED_ENV', /(?<![\w])[A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY)[A-Za-z_]*\s*[:=]/g],
];

function buildSuspectPatterns() {
  const domains = (config.internal_domains || []).filter(Boolean).map((d) => d.toLowerCase());
  const pats = [
    ['EN_NAME', { re: /(?<![A-Za-z-])[A-Z][a-z]+ [A-Z][a-z]+(?![a-z])/g, strong: (m) => { const [a, b] = m.split(' '); return hasSlavSuffix(a) || hasSlavSuffix(b); } }],
    ['EN_SURNAME', { re: /(?<![A-Za-z-])[A-Z][a-z]{2,}(?:ov|ev|yn|sky|ski|enko|ina|ova|eva|yuk|tsev|chev|vich|uk|ko)\b/g, strong: () => true }],
    ['RU_FIO', { re: /(?<![А-Яа-яЁё\w])[А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+(?: [А-ЯЁ][а-яё]+)?(?![а-яё\w])/g, strong: (m) => m.trim().split(' ').length >= 3 }],
    ['EMAIL', { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, strong: () => true }],
    ['PHONE', { re: /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g, strong: () => true }],
    ['LOGIN_LINE', { re: /(?<![а-яА-ЯёЁ\w])(?:логин|login|username|user ?name)(?![а-яА-ЯёЁ\w])[^.\n]{0,40}[:=]/gi, strong: () => false }],
    ['SNILS', { re: /\b\d{3}-\d{3}-\d{3}\s?\d{2}\b/g, strong: () => true }],
    ['INN', { re: /(?<![а-яА-ЯёЁ\w])(?:ИНН|INN)\D{0,4}(\d{10}|\d{12})(?!\d)/gi, strong: () => true }],
    ['PASSPORT', { re: /(?:паспорт|серия)\D{0,8}\b(\d{4}\s?\d{6})(?!\d)/gi, strong: () => true }],
    ['PRIV_IP', { re: /\b(?:10|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, strong: () => false }],
  ];
  if (domains.length) {
    const hostRx = '\\b(?:[a-z0-9][a-z0-9-]*\\.)+(?:' + domains.map((d) => d.replace(/\./g, '\\.')).join('|') + ')\\b';
    pats.push(['HOSTNAME', { re: new RegExp(hostRx, 'gi'), strong: () => false }]);
  }
  return pats;
}

function runMdCheck(abs) {
  const md = readFileSync(abs, 'utf8');
  const lines = md.split('\n');

  const secrets = [];
  const seen = new Set();
  for (const [type, re] of SECRET_PATTERNS) {
    for (const line of lines) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === '') { re.lastIndex++; break; } // safety: zero-length match
        const v = m[0];
        if (!whitelisted(v) && !seen.has(v)) { seen.add(v); secrets.push({ type, value: v }); }
      }
    }
  }
  for (const f of runGitleaks(md)) if (!seen.has(f.value)) { seen.add(f.value); secrets.push(f); }

  const byMatch = new Map(); // key -> {type, masked, strong, firstLine, lines[]}
  for (const [type, { re, strong }] of buildSuspectPatterns()) {
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m[0] === '') { re.lastIndex++; break; } // safety: zero-length match
        const v = m[0].trim();
        const key = type + '|' + v.toLowerCase();
        if (whitelisted(v)) continue;
        let e = byMatch.get(key);
        if (!e) { e = { type, masked: mask(v), strong: !!strong(v), firstLine: i + 1, lines: [] }; byMatch.set(key, e); }
        if (e.lines.length < 5) e.lines.push(i + 1);
      }
    });
  }
  const strongS = [...byMatch.values()].filter((e) => e.strong).sort((a, b) => a.firstLine - b.firstLine);
  const weakS = [...byMatch.values()].filter((e) => !e.strong).sort((a, b) => a.firstLine - b.firstLine);

  const code = secrets.length ? 1 : (strongS.length + weakS.length ? 3 : 0);
  return {
    code,
    report: {
      file: abs,
      clean: code === 0,
      exit: code,
      secrets: secrets.map((s) => ({ type: s.type, masked: mask(s.value) })),
      suspects: {
        strong: strongS.slice(0, config.max_suspects ?? 40),
        weak: weakS.slice(0, config.max_suspects ?? 40),
        more: Math.max(0, strongS.length + weakS.length - 2 * (config.max_suspects ?? 40)),
      },
    },
  };
}

function mdCheck(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) die(`no such file: ${abs}`, 2);
  const { report, code } = runMdCheck(abs);
  console.log(JSON.stringify(report, null, 1));
  process.exit(code);
}

// ---------- stats: structure counters only, never content ----------
// The one sanctioned way to inspect a to-md output that has not passed the
// mdcheck gate (converter debugging): prints counters, never text.

function stats(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) die(`no such file: ${abs}`, 2);
  const md = readFileSync(abs, 'utf8');
  const lines = md.split('\n');
  const blocks = md.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 80);
  const seen = new Map();
  for (const b of blocks) seen.set(b, (seen.get(b) || 0) + 1);
  let duplicateBlocks = 0, duplicateChars = 0;
  for (const [b, n] of seen) if (n > 1) { duplicateBlocks += n - 1; duplicateChars += (n - 1) * b.length; }
  console.log(JSON.stringify({
    file: abs,
    lines: lines.length,
    headings: lines.filter((l) => /^#{1,6}\s+\S/.test(l)).length,
    tables: lines.filter((l) => /^\|[-: |]+$/.test(l.trim())).length,
    tableRows: lines.filter((l) => l.trim().startsWith('|')).length,
    codeBlocks: Math.floor((md.match(/^```/gm) || []).length / 2),
    images: (md.match(/\[image/g) || []).length,
    cssLines: lines.filter((l) => /^(?!\{)[.#@\w-][\w\s.,#>-]*\{[^}]*[:;]/.test(l.trim())).length,
    duplicateBlocks,
    duplicateChars,
  }, null, 1));
}

// ---------- commands ----------

function check() {
  const comp = {};
  const gl = sh('gitleaks', ['version']);
  comp.gitleaks = gl.status === 0 ? gl.stdout.trim() : 'MISSING';
  comp.mammoth = true; comp.turndown = true; comp.config = !!config;
  console.log(JSON.stringify({ ok: comp.gitleaks !== 'MISSING', components: comp }));
  process.exit(comp.gitleaks !== 'MISSING' ? 0 : 1);
}

const [, , cmd, ...rest] = process.argv;
const flags = rest.filter((a) => a.startsWith('--'));
const args = rest.filter((a) => !a.startsWith('--'));
const outIdx = rest.indexOf('--out');
const outFile = outIdx >= 0 ? rest[outIdx + 1] : null;

if (cmd === 'check') check();
else if (cmd === 'to-md' && args[0]) toMd(args[0], outFile).catch((e) => die(e.message));
else if (cmd === 'mdcheck' && args[0]) mdCheck(args[0]);
else if (cmd === 'stats' && args[0]) stats(args[0]);
else die('usage: confluence.mjs <check | to-md <in.doc|in.docx|in.html> [--out file.md] | mdcheck <file.md> | stats <file.md>>');
