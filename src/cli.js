#!/usr/bin/env node

/**
 * eol-check — CLI for endoflife.ai
 *
 * Usage:
 *   npx eol-check                    # scan current directory
 *   npx eol-check scan [path]        # scan a directory
 *   npx eol-check check <slug> <ver> # check a specific product
 *   npx eol-check list               # list all tracked products
 *
 * Every lookup needs an API key in EOL_API_KEY (or ENDOFLIFE_API_KEY).
 * A free key works: https://endoflife.ai/api#free-key
 *
 * Exit codes:
 *   0  no end-of-life runtime found and every lookup was answered
 *   1  one or more end-of-life runtimes found
 *   2  could not check (no key, key refused, daily limit reached,
 *      network or API error, wrong usage)
 */

const https = require('https');
const fs   = require('fs');
const path = require('path');

const API = 'https://api.endoflife.ai/v1';
const VERSION = '1.0.3';

const FREE_KEY_URL = 'https://endoflife.ai/api#free-key';
const PLANS_URL    = 'https://endoflife.ai/api#get-key';
const TIMEOUT_MS   = 20000;

const EXIT_OK        = 0;
const EXIT_EOL       = 1;
const EXIT_UNCHECKED = 2;

// ─── Colours ─────────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

const isTTY = process.stdout.isTTY;
const col = (color, text) => isTTY ? `${color}${text}${c.reset}` : text;

// ─── HTTP ─────────────────────────────────────────────────────────────────────

// Every request ends in one of these, and never throws:
//   { ok: true,  data }                       the API answered 200 with JSON
//   { ok: false, kind: 'not_tracked' }        404: endoflife.ai does not track it
//   { ok: false, kind, reason, help }         the lookup did not happen
// kind is 'no_key' | 'key_refused' | 'limit' | 'error'. reason is a few words
// for the result row; help is the longer text, printed once.

function keyRequiredHelp() {
  return [
    `Get a free key at ${FREE_KEY_URL}`,
    'It is emailed at once, gives 150 requests a day and does not expire.',
    'Set it as the EOL_API_KEY environment variable and run again:',
    '  EOL_API_KEY=your_key npx @endoflife-ai/eol-check',
  ];
}

function retryAfterText(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const resetMs = /^\d+$/.test(raw) ? Date.now() + Number(raw) * 1000 : Date.parse(raw);
  if (!Number.isFinite(resetMs)) return null;
  const minutes = Math.max(1, Math.round((resetMs - Date.now()) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const wait = h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
  const at = new Date(Math.round(resetMs / 60000) * 60000).toISOString().slice(0, 16).replace('T', ' ');
  return `It resets in ${wait}, at ${at} UTC.`;
}

function readResponse(status, headers, body, keySent) {
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* not JSON */ }

  if (status === 200) {
    if (json === null || typeof json !== 'object') {
      return { ok: false, kind: 'error', reason: 'the API answer could not be read', help: [] };
    }
    return { ok: true, data: json };
  }

  if (status === 404) return { ok: false, kind: 'not_tracked' };

  if (status === 401) {
    if (!keySent) {
      return { ok: false, kind: 'no_key', reason: 'no API key', help: ['An API key is required.'].concat(keyRequiredHelp()) };
    }
    const keyStatus = String(headers['x-eol-key-status'] || (json && json.key_status) || '').toLowerCase();
    if (keyStatus === 'inactive') {
      return {
        ok: false, kind: 'key_refused', reason: 'API key inactive',
        help: [
          'The API key is inactive: its subscription was cancelled or refunded.',
          `Get a free key at ${FREE_KEY_URL} or a paid plan at ${PLANS_URL}`,
        ],
      };
    }
    if (keyStatus === 'unknown') {
      return {
        ok: false, kind: 'key_refused', reason: 'API key not recognised',
        help: [
          'The API does not recognise this key.',
          'Check the value of EOL_API_KEY (or ENDOFLIFE_API_KEY) for typos and stray spaces.',
          `Get a free key at ${FREE_KEY_URL}`,
        ],
      };
    }
    return {
      ok: false, kind: 'key_refused', reason: 'API key refused',
      help: [
        'The API refused this key.',
        `Check the value of EOL_API_KEY (or ENDOFLIFE_API_KEY), or get a free key at ${FREE_KEY_URL}`,
      ],
    };
  }

  if (status === 429) {
    const limit = /^\d+$/.test(String(headers['x-ratelimit-limit'] || ''))
      ? ` (${Number(headers['x-ratelimit-limit']).toLocaleString('en-US')} requests a day)` : '';
    const help = [`The daily limit of this key was reached${limit}.`];
    const reset = retryAfterText(headers['retry-after']);
    if (reset) help.push(reset);
    help.push('A free key gives 150 requests a day. Starter (USD 89 a month) gives 10,000 a day. Pro (USD 299 a month) gives 100,000 a day, fair use.');
    help.push(`Plans: ${PLANS_URL}`);
    return { ok: false, kind: 'limit', reason: 'daily limit of the key reached', help };
  }

  return { ok: false, kind: 'error', reason: `API error ${status}`, help: [] };
}

function networkFailure(err) {
  const what = (err && (err.code || err.message)) || 'unknown';
  return { ok: false, kind: 'error', reason: `network error: ${what}`, help: [] };
}

function apiGet(url, apiKey) {
  return new Promise(resolve => {
    let settled = false;
    const done = result => { if (!settled) { settled = true; resolve(result); } };
    const headers = { 'User-Agent': `eol-check-cli/${VERSION}`, 'Accept': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    try {
      const req = https.get(url, { headers }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => body += chunk);
        res.on('error', err => done(networkFailure(err)));
        res.on('end', () => done(readResponse(res.statusCode, res.headers || {}, body, !!apiKey)));
      });
      req.on('error', err => done(networkFailure(err)));
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`no answer after ${TIMEOUT_MS / 1000} seconds`)));
    } catch (err) {
      done(networkFailure(err));
    }
  });
}

function statusUrl(slug, version) {
  return `${API}/status/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`;
}

// Turn a 200 answer into a row status. Returns null when the answer does not
// say whether the version is supported; the caller reports that as not checked.
// "Supported" is printed only when the API says so.
function classify(data) {
  if (data.is_eol === true) return 'eol';
  if (data.is_eol !== false || data.is_supported === false) return null;
  const days = typeof data.days_until_eol === 'number' ? data.days_until_eol : null;
  return days !== null && days <= 90 ? 'warn' : 'active';
}

// One lookup, as a result row: status is eol | warn | active | not_tracked |
// not_checked. A not_checked row carries the failure so the caller can stop early.
async function lookup(item, apiKey) {
  const res = await apiGet(statusUrl(item.slug, item.version), apiKey);
  if (!res.ok) {
    if (res.kind === 'not_tracked') return { ...item, status: 'not_tracked' };
    return { ...item, status: 'not_checked', reason: res.reason, failure: res };
  }
  const status = classify(res.data);
  if (!status) {
    const failure = {
      ok: false, kind: 'error', reason: 'the API gave no usable status',
      help: ['The API answered but did not say whether the version is supported, so it is not called supported.'],
    };
    return { ...item, status: 'not_checked', reason: failure.reason, failure };
  }
  return {
    ...item, status,
    eol_date: res.data.eol_date,
    days_until_eol: res.data.days_until_eol,
    days_past_eol: res.data.days_past_eol,
    score_url: `https://endoflife.ai/score/${item.slug}/${item.version}`,
  };
}

// ─── Version file detection (shared with GitHub Action) ──────────────────────

function detectFromPath(scanPath) {
  const detected = [];

  const tryFile = (file, fn) => {
    const fp = path.join(scanPath, file);
    if (fs.existsSync(fp)) fn(fs.readFileSync(fp, 'utf8').trim(), fp);
  };

  tryFile('.nvmrc', (raw) => {
    const major = raw.replace(/^v/, '').split('.')[0];
    if (major && !isNaN(major)) detected.push({ slug: 'nodejs', version: major, source: '.nvmrc' });
  });

  tryFile('.node-version', (raw) => {
    const major = raw.replace(/^v/, '').split('.')[0];
    if (major && !isNaN(major)) detected.push({ slug: 'nodejs', version: major, source: '.node-version' });
  });

  tryFile('.python-version', (raw) => {
    const parts = raw.split('.');
    if (parts.length >= 2) detected.push({ slug: 'python', version: `${parts[0]}.${parts[1]}`, source: '.python-version' });
  });

  tryFile('.ruby-version', (raw) => {
    const ver = raw.replace(/^ruby-/, '');
    const parts = ver.split('.');
    if (parts.length >= 2) detected.push({ slug: 'ruby', version: `${parts[0]}.${parts[1]}`, source: '.ruby-version' });
  });

  tryFile('.tool-versions', (raw) => {
    const slugMap = { nodejs: 'nodejs', node: 'nodejs', python: 'python', ruby: 'ruby', golang: 'go', go: 'go' };
    for (const line of raw.split('\n')) {
      const [tool, ver] = line.trim().split(/\s+/);
      if (!tool || !ver) continue;
      const slug = slugMap[tool.toLowerCase()];
      if (slug) {
        const parts = ver.split('.');
        const version = slug === 'nodejs' ? parts[0] : `${parts[0]}.${parts[1]}`;
        detected.push({ slug, version, source: '.tool-versions' });
      }
    }
  });

  tryFile('package.json', (raw) => {
    try {
      const pkg = JSON.parse(raw);
      if (pkg.engines?.node) {
        const match = pkg.engines.node.match(/(\d+)/);
        if (match) detected.push({ slug: 'nodejs', version: match[1], source: 'package.json' });
      }
    } catch(e) {}
  });

  tryFile('go.mod', (raw) => {
    const match = raw.match(/^go\s+(\d+\.\d+)/m);
    if (match) detected.push({ slug: 'go', version: match[1], source: 'go.mod' });
  });

  tryFile('composer.json', (raw) => {
    try {
      const composer = JSON.parse(raw);
      const phpVer = composer?.require?.php;
      if (phpVer) {
        const match = phpVer.match(/(\d+\.\d+)/);
        if (match) detected.push({ slug: 'php', version: match[1], source: 'composer.json' });
      }
    } catch(e) {}
  });

  tryFile('Gemfile', (raw) => {
    const match = raw.match(/^ruby\s+['"](\d+\.\d+)/m);
    if (match) detected.push({ slug: 'ruby', version: match[1], source: 'Gemfile' });
  });

  tryFile('.terraform-version', (raw) => {
    const match = raw.match(/(\d+\.\d+)/);
    if (match) detected.push({ slug: 'terraform', version: match[1], source: '.terraform-version' });
  });

  // Dockerfile
  for (const f of ['Dockerfile', 'Dockerfile.prod', 'Dockerfile.dev']) {
    tryFile(f, (raw) => {
      for (const line of raw.split('\n')) {
        const from = line.match(/^FROM\s+(\S+)/i);
        if (!from) continue;
        const img = from[1].toLowerCase();
        const nodeMatch  = img.match(/^node:(\d+)/);
        const pythonMatch = img.match(/^python:(\d+\.\d+)/);
        const phpMatch   = img.match(/^php:(\d+\.\d+)/);
        const rubyMatch  = img.match(/^ruby:(\d+\.\d+)/);
        if (nodeMatch)   detected.push({ slug: 'nodejs',  version: nodeMatch[1],   source: f });
        if (pythonMatch) detected.push({ slug: 'python',  version: pythonMatch[1], source: f });
        if (phpMatch)    detected.push({ slug: 'php',     version: phpMatch[1],    source: f });
        if (rubyMatch)   detected.push({ slug: 'ruby',    version: rubyMatch[1],   source: f });
      }
    });
  }

  // Deduplicate
  const seen = new Set();
  return detected.filter(d => {
    const key = `${d.slug}:${d.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function statusIcon(status) {
  if (status === 'eol')     return col(c.red,    '✗ EOL');
  if (status === 'warn')    return col(c.yellow, '⚠ Warning');
  if (status === 'active')  return col(c.green,  '✓ Supported');
  if (status === 'not_tracked') return col(c.dim, '– Not tracked');
  return col(c.yellow, '? Not checked');
}

function printResult(r) {
  const name = col(c.bold, `${r.slug} ${r.version}`);
  const status = statusIcon(r.status);
  const source = col(c.dim, `[${r.source}]`);

  if (r.status === 'not_tracked') {
    console.log(`  ${status}  ${name}  ${col(c.dim, '· not tracked by endoflife.ai')} ${source}`);
    return;
  }
  if (r.status === 'not_checked') {
    console.log(`  ${status}  ${name}  ${col(c.yellow, `· ${r.reason}`)} ${source}`);
    return;
  }

  const eolDate = r.eol_date ? col(c.dim, `· EOL ${r.eol_date}`) : '';
  const days = r.days_past_eol
    ? col(c.red, `· ${r.days_past_eol} days past EOL`)
    : r.days_until_eol
    ? col(r.days_until_eol < 90 ? c.yellow : c.dim, `· ${r.days_until_eol} days remaining`)
    : '';
  const scoreUrl = col(c.cyan, `\n    → ${r.score_url}`);

  console.log(`  ${status}  ${name}  ${eolDate} ${days} ${source}${scoreUrl}`);
}

// A headline plus the longer text for each cause of a lookup that did not happen.
function printFailure(headline, failures, log) {
  log(`  ${col(c.red, headline)}`);
  for (const f of failures) {
    const lines = f.help && f.help.length ? f.help : [`Reason: ${f.reason}. Try again in a few minutes.`];
    for (const line of lines) log(`  ${line}`);
  }
  log('');
}

function printKeyRequired() {
  console.error('');
  console.error(`  ${col(c.red, 'An API key is required. Nothing was checked.')}`);
  for (const line of keyRequiredHelp()) console.error(`  ${line}`);
  console.error('');
}

// ─── Commands ─────────────────────────────────────────────────────────────────
// Each command returns its exit code.

async function cmdCheck(slug, version, apiKey) {
  console.log(`\n${col(c.bold, 'endoflife.ai')} — checking ${col(c.cyan, `${slug} ${version}`)}\n`);

  const r = await lookup({ slug, version, source: 'cli' }, apiKey);
  printResult(r);
  console.log('');

  if (r.status === 'not_checked') {
    printFailure(`${slug} ${version} could not be checked.`, [r.failure], console.error);
    return EXIT_UNCHECKED;
  }
  if (r.status === 'not_tracked') {
    console.log(`  ${col(c.dim, 'Browse all products: https://endoflife.ai/products')}\n`);
    return EXIT_OK;
  }
  return r.status === 'eol' ? EXIT_EOL : EXIT_OK;
}

async function cmdScan(scanPath, apiKey) {
  const resolved = path.resolve(scanPath || '.');
  console.log(`\n${col(c.bold, 'endoflife.ai')} — scanning ${col(c.cyan, resolved)}\n`);

  const detected = detectFromPath(resolved);

  if (detected.length === 0) {
    console.log(`  ${col(c.dim, 'No version files detected.')}`);
    console.log(`  ${col(c.dim, 'Add .nvmrc, .python-version, go.mod, Dockerfile, or other version pins.')}\n`);
    return EXIT_OK;
  }

  console.log(`  ${col(c.dim, `Found ${detected.length} runtime(s) — checking against endoflife.ai...\n`)}`);

  const results = [];
  // A refused key or a reached limit fails every later lookup the same way,
  // so stop asking and mark the rest as not checked for that reason.
  let stop = null;

  for (const item of detected) {
    if (stop) {
      results.push({ ...item, status: 'not_checked', reason: stop.reason, failure: stop });
      continue;
    }
    const r = await lookup(item, apiKey);
    results.push(r);
    if (r.status === 'not_checked' && r.failure.kind !== 'error') stop = r.failure;
  }

  for (const r of results) printResult(r);

  console.log('');

  const count = status => results.filter(r => r.status === status).length;
  const eolCount        = count('eol');
  const warnCount       = count('warn');
  const notTrackedCount = count('not_tracked');
  const notChecked      = results.filter(r => r.status === 'not_checked');
  const checkedCount    = results.length - notTrackedCount - notChecked.length;

  if (eolCount > 0) {
    console.log(col(c.red, `  ✗ ${eolCount} EOL runtime(s) detected. Upgrade or add extended support.`));
    console.log(col(c.dim, `    Learn more: https://endoflife.ai`));
    console.log('');
  } else if (warnCount > 0) {
    console.log(col(c.yellow, `  ⚠ ${warnCount} runtime(s) approaching EOL within 90 days.`));
    console.log(col(c.dim, `    Plan your upgrade: https://endoflife.ai`));
    console.log('');
  }

  if (notChecked.length > 0) {
    // The help text once per distinct cause.
    const causes = [];
    for (const r of notChecked) {
      if (!causes.some(f => f.kind === r.failure.kind && f.reason === r.failure.reason)) causes.push(r.failure);
    }
    printFailure(`! ${notChecked.length} runtime(s) could not be checked.`, causes, console.log);
  }

  // The all-clear line is printed only when every detected runtime was looked
  // up, at least one is tracked, and every tracked one is supported with more
  // than 90 days left. Runtimes that are not tracked are counted beside it.
  const allClear = notChecked.length === 0 && eolCount === 0 && warnCount === 0 && checkedCount > 0;
  if (allClear && notTrackedCount === 0) {
    console.log(col(c.green, `  ✓ All runtimes are currently supported.`));
    console.log('');
  } else if (allClear) {
    console.log(col(c.green, `  ✓ All checked runtimes are supported; ${notTrackedCount} not tracked by endoflife.ai.`));
    console.log('');
  } else if (notTrackedCount > 0) {
    const nothing = checkedCount === 0 && notChecked.length === 0 ? 'Nothing was checked: ' : '';
    console.log(col(c.yellow, `  ${nothing}${notTrackedCount} runtime(s) not tracked by endoflife.ai.`));
    console.log('');
  }

  if (eolCount > 0) return EXIT_EOL;
  if (notChecked.length > 0) return EXIT_UNCHECKED;
  return EXIT_OK;
}

async function cmdList(apiKey) {
  console.log(`\n${col(c.bold, 'endoflife.ai')} — fetching product list...\n`);

  const res = await apiGet(`${API}/products`, apiKey);
  const products = res.ok ? (Array.isArray(res.data) ? res.data : res.data.products) : null;
  if (!Array.isArray(products)) {
    const failure = res.ok || res.kind === 'not_tracked'
      ? { reason: 'the API sent no product list', help: [] }
      : res;
    printFailure('The product list could not be fetched.', [failure], console.error);
    return EXIT_UNCHECKED;
  }

  console.log(`  ${col(c.dim, `${products.length} products tracked:\n`)}`);
  for (const p of products) {
    console.log(`  ${col(c.cyan, p)} — https://endoflife.ai/${p}`);
  }
  console.log('');
  return EXIT_OK;
}

function printHelp() {
  console.log(`
${col(c.bold, 'eol-check')} v${VERSION} — powered by endoflife.ai

${col(c.bold, 'USAGE')}

  ${col(c.cyan, 'npx eol-check')}                     Scan current directory
  ${col(c.cyan, 'npx eol-check scan [path]')}         Scan a directory
  ${col(c.cyan, 'npx eol-check check <slug> <ver>')}  Check a specific product version
  ${col(c.cyan, 'npx eol-check list')}                List all tracked products

${col(c.bold, 'EXAMPLES')}

  npx eol-check
  npx eol-check scan ./my-project
  npx eol-check check nodejs 18
  npx eol-check check python 3.11
  npx eol-check check php 8.1

${col(c.bold, 'API KEY (required)')}

  EOL_API_KEY=<key>   Every lookup needs an API key. A free key works:
                      150 requests a day, no expiry, emailed at once.
                      Get one at ${FREE_KEY_URL}
                      ENDOFLIFE_API_KEY is read as well.

${col(c.bold, 'EXIT CODES')}

  0   No end-of-life runtime found and every lookup was answered
      (a runtime endoflife.ai does not track is named, not called supported)
  1   One or more end-of-life runtimes found
  2   Could not check: no API key, key refused, daily limit reached,
      network or API error, or wrong usage

${col(c.bold, 'DETECTS VERSIONS FROM')}

  .nvmrc · .node-version · .python-version · .ruby-version
  .tool-versions · package.json · go.mod · composer.json
  Gemfile · Dockerfile · .terraform-version

${col(c.bold, 'DATA')}

  https://endoflife.ai · https://api.endoflife.ai
`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const cmd    = args[0];
const apiKey = (process.env.EOL_API_KEY || process.env.ENDOFLIFE_API_KEY || '').trim();

async function main() {
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return EXIT_OK;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return EXIT_OK;
  }
  if (cmd === 'check' && (!args[1] || !args[2])) {
    console.error(`\n  Usage: eol-check check <slug> <version>\n  Example: eol-check check nodejs 18\n`);
    return EXIT_UNCHECKED;
  }

  // Everything below calls the API, and the API answers no data request
  // without a key. Say so before doing anything that looks like a check.
  if (!apiKey) {
    printKeyRequired();
    return EXIT_UNCHECKED;
  }

  if (!cmd || cmd === 'scan') return cmdScan(args[1], apiKey);
  if (cmd === 'check') return cmdCheck(args[1], args[2], apiKey);
  if (cmd === 'list') return cmdList(apiKey);
  // Treat unknown arg as a path to scan
  return cmdScan(cmd, apiKey);
}

main().then(
  code => { process.exitCode = code; },
  err => {
    console.error(`\n  ${col(c.red, 'Error:')} ${err && err.message ? err.message : err}\n  Nothing more was checked.\n`);
    process.exitCode = EXIT_UNCHECKED;
  }
);
