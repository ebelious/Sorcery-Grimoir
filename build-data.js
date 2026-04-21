#!/usr/bin/env node
/**
 * build-data.js
 * 
 * Updates FAQ_DATA and CODEX_DATA in index.html from CSV source files.
 * Run this whenever faq*.csv or codex*.csv are updated.
 *
 * Usage:
 *   node build-data.js
 *   node build-data.js --faq path/to/faq.csv
 *   node build-data.js --codex path/to/codex.csv
 *   node build-data.js --faq new_faq.csv --codex new_codex.csv
 *
 * Drop the new CSV in the same folder as index.html and run with no args —
 * it auto-detects the most recently modified faq*.csv and codex*.csv.
 */

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const HTML_FILE  = path.join(__dirname, 'index.html');
const FAQ_GLOB   = /^faq.*\.csv$/i;
const CODEX_GLOB = /^codex.*\.csv$/i;

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--faq'   && args[i+1]) result.faq   = args[++i];
    if (args[i] === '--codex' && args[i+1]) result.codex = args[++i];
  }
  return result;
}

function findLatestCSV(pattern) {
  const matches = fs.readdirSync(__dirname)
    .filter(f => pattern.test(f))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches.length ? path.join(__dirname, matches[0].name) : null;
}

// ── CSV parser — handles quoted multi-line fields ─────────────────────────────

function parseCSV(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Tokenise character-by-character so embedded newlines in quoted fields work
  const records = [];
  let fields = [];
  let cur = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i+1] === '"') { cur += '"'; i++; }  // escaped quote
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        fields.push(cur.trim()); cur = '';
      } else if (ch === '\n') {
        fields.push(cur.trim()); cur = '';
        if (fields.some(f => f !== '')) records.push(fields);
        fields = [];
      } else {
        cur += ch;
      }
    }
  }
  if (cur.trim() || fields.length) { fields.push(cur.trim()); if (fields.some(f => f !== '')) records.push(fields); }

  if (!records.length) return [];
  const headers = records[0];
  return records.slice(1).map(vals => {
    const row = {};
    headers.forEach((h, j) => row[h] = vals[j] || '');
    return row;
  });
}

// ── Data builders ─────────────────────────────────────────────────────────────

function buildFAQ(csvPath) {
  const rows = parseCSV(csvPath);
  const data = [];
  let lastCard = '';
  for (const row of rows) {
    const card = (row['card name'] || '').trim();
    if (card) lastCard = card;
    const q = (row['question'] || '').trim();
    const a = (row['answer']   || '').trim();
    if (q || a) data.push({ card: card || lastCard, q, a });
  }
  return data;
}

function buildCodex(csvPath) {
  const rows = parseCSV(csvPath);
  const data = [];
  for (const row of rows) {
    const title   = (row['title']      || '').trim();
    const content = (row['content']    || '').trim();
    const sub     = (row['subcodexes'] || '').trim();
    if (title) {
      let body = content;
      if (sub) body += (body ? '\n\n' : '') + sub;
      data.push({ k: title, body });
    } else if (sub && data.length) {
      // Subcodex continuation row — merge into preceding entry
      const prev = data[data.length - 1];
      prev.body += (prev.body ? '\n\n' : '') + sub;
    }
  }
  return data;
}

// ── HTML patcher ──────────────────────────────────────────────────────────────

function patchHTML(html, faqData, codexData) {
  let patched = html;
  let changed = 0;

  if (faqData) {
    const json = JSON.stringify(faqData);
    const before = patched;
    patched = patched.replace(/var FAQ_DATA=\[[\s\S]*?\];/, `var FAQ_DATA=${json};`);
    if (patched !== before) changed++;
    else console.warn('  ⚠️  Could not find FAQ_DATA marker in index.html');
  }
  if (codexData) {
    const json = JSON.stringify(codexData);
    const before = patched;
    patched = patched.replace(/var CODEX_DATA=\[[\s\S]*?\];/, `var CODEX_DATA=${json};`);
    if (patched !== before) changed++;
    else console.warn('  ⚠️  Could not find CODEX_DATA marker in index.html');
  }

  return { patched, changed };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(function main() {
  const args = parseArgs();
  const faqPath   = args.faq   || findLatestCSV(FAQ_GLOB);
  const codexPath = args.codex || findLatestCSV(CODEX_GLOB);

  console.log('\n🔧  Grimoire data builder');
  console.log('─'.repeat(44));

  if (!faqPath && !codexPath) {
    console.error('❌  No FAQ or Codex CSV found. Pass --faq and/or --codex.');
    process.exit(1);
  }
  if (!fs.existsSync(HTML_FILE)) {
    console.error(`❌  index.html not found at: ${HTML_FILE}`);
    process.exit(1);
  }

  let faqData = null, codexData = null;

  if (faqPath) {
    if (!fs.existsSync(faqPath)) { console.error(`❌  FAQ CSV not found: ${faqPath}`); process.exit(1); }
    faqData = buildFAQ(faqPath);
    console.log(`📄  FAQ   : ${path.basename(faqPath)}`);
    console.log(`     → ${faqData.length} entries across ${new Set(faqData.map(f=>f.card)).size} cards`);
  } else {
    console.log('⚠️   FAQ   : no CSV found, skipping');
  }

  if (codexPath) {
    if (!fs.existsSync(codexPath)) { console.error(`❌  Codex CSV not found: ${codexPath}`); process.exit(1); }
    codexData = buildCodex(codexPath);
    console.log(`📄  Codex : ${path.basename(codexPath)}`);
    console.log(`     → ${codexData.length} keywords`);
  } else {
    console.log('⚠️   Codex : no CSV found, skipping');
  }

  const html = fs.readFileSync(HTML_FILE, 'utf-8');
  const { patched, changed } = patchHTML(html, faqData, codexData);

  if (!changed) {
    console.error('\n❌  Nothing patched — markers not found in index.html');
    process.exit(1);
  }

  fs.writeFileSync(HTML_FILE, patched, 'utf-8');

  const before = Buffer.byteLength(html,    'utf-8');
  const after  = Buffer.byteLength(patched, 'utf-8');
  const diff   = after - before;

  console.log(`\n✅  index.html updated`);
  console.log(`   Size: ${(before/1024).toFixed(1)} KB → ${(after/1024).toFixed(1)} KB (${diff>=0?'+':''}${(diff/1024).toFixed(1)} KB)`);
  console.log('\n   git add index.html && git commit -m "update faq/codex data" && git push\n');
})();
