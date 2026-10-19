#!/usr/bin/env node

/**
 * eol-check — CLI for endoflife.ai
 *
 * Usage:
 *   npx eol-check                    # scan current directory
 *   npx eol-check scan [path]        # scan a directory
 *   npx eol-check check <slug> <ver> # check a specific product
 *   npx eol-check list               # list all tracked products
 */

const https = require('https');
const fs   = require('fs');
const path = require('path');

const API = 'https://api.endoflife.ai/v1';
const VERSION = '1.0.2';

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

function fetchJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': `eol-check-cli/${VERSION}` };
    if (apiKey) headers['X-API-Key'] = apiKey;
    https.get(url, { headers }, res => {
      if (res.statusCode === 404) { resolve(null); return; }
      // From 2026-11-16 the API refuses requests without a key (HTTP 401).
      if (res.statusCode === 401) {
        reject(new Error('The endoflife.ai API needs a key from November 16, 2026. Get a free key (150 requests a day, no expiry) at https://endoflife.ai/api#free-key and set it as the EOL_API_KEY environment variable.'));
        return;
      }
      if (res.statusCode === 429) {
        reject(new Error('Rate limit exceeded. Set the EOL_API_KEY environment variable to a free key (150 requests a day) from https://endoflife.ai/api#free-key, or a paid key for more.'));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`API error ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
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
  return col(c.dim, '? Unknown');
}

function printResult(r) {
  const name = col(c.bold, `${r.slug} ${r.version}`);
  const status = statusIcon(r.status);
  const eolDate = r.eol_date ? col(c.dim, `· EOL ${r.eol_date}`) : '';
  const days = r.days_past_eol
    ? col(c.red, `· ${r.days_past_eol} days past EOL`)
    : r.days_until_eol
    ? col(r.days_until_eol < 90 ? c.yellow : c.dim, `· ${r.days_until_eol} days remaining`)
    : '';
  const source = col(c.dim, `[${r.source}]`);
  const scoreUrl = r.status !== 'unknown' ? col(c.cyan, `\n    → ${r.score_url}`) : '';

  console.log(`  ${status}  ${name}  ${eolDate} ${days} ${source}${scoreUrl}`);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdCheck(slug, version, apiKey) {
  console.log(`\n${col(c.bold, 'endoflife.ai')} — checking ${col(c.cyan, `${slug} ${version}`)}\n`);
  try {
    const data = await fetchJson(`${API}/status/${slug}/${version}`, apiKey);
    if (!data) {
      console.log(`  ${col(c.dim, '?')}  ${col(c.bold, `${slug} ${version}`)}  ${col(c.dim, '— not found in endoflife.ai database')}`);
      console.log(`\n  ${col(c.dim, `Browse all products: https://endoflife.ai/products`)}\n`);
      process.exit(0);
    }

    const days = data.days_until_eol ?? (data.days_past_eol ? -data.days_past_eol : null);
    const status = data.is_eol ? 'eol' : (days !== null && days <= 90) ? 'warn' : 'active';

    printResult({
      slug, version, status,
      eol_date: data.eol_date,
      days_until_eol: data.days_until_eol,
      days_past_eol: data.days_past_eol,
      source: 'cli',
      score_url: `https://endoflife.ai/score/${slug}/${version}`,
    });

    console.log('');
    if (status === 'eol') process.exit(1);
  } catch(err) {
    console.error(`\n  ${col(c.red, 'Error:')} ${err.message}\n`);
    process.exit(1);
  }
}

async function cmdScan(scanPath, apiKey) {
  const resolved = path.resolve(scanPath || '.');
  console.log(`\n${col(c.bold, 'endoflife.ai')} — scanning ${col(c.cyan, resolved)}\n`);

  const detected = detectFromPath(resolved);

  if (detected.length === 0) {
    console.log(`  ${col(c.dim, 'No version files detected.')}`);
    console.log(`  ${col(c.dim, 'Add .nvmrc, .python-version, go.mod, Dockerfile, or other version pins.')}\n`);
    process.exit(0);
  }

  console.log(`  ${col(c.dim, `Found ${detected.length} runtime(s) — checking against endoflife.ai...\n`)}`);

  let eolCount = 0;
  let warnCount = 0;
  const results = [];

  for (const item of detected) {
    try {
      const data = await fetchJson(`${API}/status/${item.slug}/${item.version}`, apiKey);
      if (!data) {
        results.push({ ...item, status: 'unknown' });
        continue;
      }
      const days = data.days_until_eol ?? (data.days_past_eol ? -data.days_past_eol : null);
      const status = data.is_eol ? 'eol' : (days !== null && days <= 90) ? 'warn' : 'active';
      if (status === 'eol') eolCount++;
      if (status === 'warn') warnCount++;
      results.push({
        ...item, status,
        eol_date: data.eol_date,
        days_until_eol: data.days_until_eol,
        days_past_eol: data.days_past_eol,
        score_url: `https://endoflife.ai/score/${item.slug}/${item.version}`,
      });
    } catch(err) {
      results.push({ ...item, status: 'unknown', error: err.message });
    }
  }

  for (const r of results) printResult(r);

  console.log('');

  if (eolCount > 0) {
    console.log(col(c.red, `  ✗ ${eolCount} EOL runtime(s) detected. Upgrade or add extended support.`));
    console.log(col(c.dim, `    Learn more: https://endoflife.ai`));
    console.log('');
    process.exit(1);
  } else if (warnCount > 0) {
    console.log(col(c.yellow, `  ⚠ ${warnCount} runtime(s) approaching EOL within 90 days.`));
    console.log(col(c.dim, `    Plan your upgrade: https://endoflife.ai`));
    console.log('');
  } else {
    console.log(col(c.green, `  ✓ All runtimes are currently supported.`));
    console.log('');
  }
}

async function cmdList(apiKey) {
  console.log(`\n${col(c.bold, 'endoflife.ai')} — fetching product list...\n`);
  try {
    const data = await fetchJson(`${API}/products`, apiKey);
    if (!data) { console.log('  Failed to fetch product list.'); process.exit(1); }
    const products = data.products || data;
    console.log(`  ${col(c.dim, `${products.length} products tracked:\n`)}`);
    for (const p of products) {
      console.log(`  ${col(c.cyan, p)} — https://endoflife.ai/${p}`);
    }
    console.log('');
  } catch(err) {
    console.error(`\n  ${col(c.red, 'Error:')} ${err.message}\n`);
    process.exit(1);
  }
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

${col(c.bold, 'OPTIONS')}

  EOL_API_KEY=<key>   Set a Pro API key for higher rate limits

${col(c.bold, 'DETECTS VERSIONS FROM')}

  .nvmrc · .node-version · .python-version · .ruby-version
  .tool-versions · package.json · go.mod · composer.json
  Gemfile · Dockerfile · .terraform-version

${col(c.bold, 'DATA')}

  https://endoflife.ai · https://api.endoflife.ai

${col(c.dim, '  Exit code 0 = all supported · Exit code 1 = EOL detected')}
`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const cmd    = args[0];
const apiKey = process.env.EOL_API_KEY || '';

(async () => {
  if (!cmd || cmd === 'scan') {
    await cmdScan(args[1], apiKey);
  } else if (cmd === 'check') {
    if (!args[1] || !args[2]) {
      console.error(`\n  Usage: eol-check check <slug> <version>\n  Example: eol-check check nodejs 18\n`);
      process.exit(1);
    }
    await cmdCheck(args[1], args[2], apiKey);
  } else if (cmd === 'list') {
    await cmdList(apiKey);
  } else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
  } else if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
  } else {
    // Treat unknown arg as a path to scan
    await cmdScan(cmd, apiKey);
  }
})();
