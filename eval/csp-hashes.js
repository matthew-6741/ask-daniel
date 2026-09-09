#!/usr/bin/env node
/**
 * Recompute the CSP script hashes and write them into netlify.toml.
 *
 * script-src allows no 'unsafe-inline', so each inline <script> block in
 * index.html is permitted by its SHA-256 hash. Change a block and the hash
 * changes; ship without updating it and the browser blocks every script, which
 * takes the whole site down at once. `node eval/local-check.js` fails if you
 * forget — that guard is the only thing making this arrangement safe.
 *
 * This edits ONLY the quoted value of the Content-Security-Policy line. An
 * earlier version pattern-matched the script-src directive across the whole
 * file, hit the same words inside a nearby comment, rewrote the comment while
 * leaving the real directive untouched, and then deleted the directive
 * outright. Never pattern-match a config file for a phrase your own comments
 * also contain.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tomlPath = path.join(root, 'netlify.toml');
const toml = fs.readFileSync(tomlPath, 'utf8');

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]);
if (!blocks.length) { console.error('No inline script blocks found — refusing to write.'); process.exit(1); }
const hashes = blocks.map(b => "'sha256-" + crypto.createHash('sha256').update(b).digest('base64') + "'");

const CSP_LINE = /^(\s*Content-Security-Policy\s*=\s*")([^"]*)(")/m;
const m = toml.match(CSP_LINE);
if (!m) { console.error('No Content-Security-Policy line found — refusing to write.'); process.exit(1); }

const updated = m[2].replace(/script-src ([^;]*)/, (_, cur) => {
  const keep = cur.split(/\s+/).filter(t =>
    t && t !== "'self'" && t !== "'unsafe-inline'" && !/^'sha256-/.test(t));
  return `script-src 'self' ${hashes.join(' ')} ${keep.join(' ')}`.replace(/\s+/g, ' ').trim();
});

fs.writeFileSync(tomlPath, toml.replace(CSP_LINE, `$1${updated}$3`));

// Read it back and prove the change landed where it was meant to.
const after = fs.readFileSync(tomlPath, 'utf8').match(CSP_LINE);
const src = (after[2].match(/script-src ([^;]*)/) || [])[1] || '';
const ok = hashes.every(h => src.includes(h)) && !src.includes("'unsafe-inline'");
console.log(`${blocks.length} inline script block(s):`);
hashes.forEach((h, i) => console.log(`  block ${i + 1} (${blocks[i].split('\n').length} lines)  ${h}`));
console.log(ok ? 'netlify.toml updated and verified.' : 'WROTE BUT VERIFICATION FAILED — inspect netlify.toml');
process.exit(ok ? 0 : 1);
