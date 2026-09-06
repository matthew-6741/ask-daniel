#!/usr/bin/env node
/**
 * Ask Danny evaluation harness.
 *
 * Runs the job set against the live API and writes a CSV for a tradesperson to
 * grade. The scoring the machine can do is deliberately narrow: whether an
 * essential item appeared, whether aisles came from verified data, whether a
 * safety job was flagged. Everything that matters more than that — is this the
 * part a plumber would actually buy, is the aisle right in THIS store — is a
 * column for a human to fill in.
 *
 *   node eval/run.js                     # all jobs
 *   node eval/run.js --trade plumbing    # one trade
 *   node eval/run.js --limit 10          # first N
 *   node eval/run.js --endpoint council  # council instead of single model
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.EVAL_BASE || 'https://diagnostechai.com';
const args = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const TRADE     = opt('--trade', null);
const LIMIT     = parseInt(opt('--limit', '0'), 10);
// The app calls /api/council, so that is what the eval must measure. Defaulting
// to the proxy graded a path no user takes, and produced 15 jobs of zeros.
const ENDPOINT  = opt('--endpoint', 'council');
const DELAY_MS  = parseInt(opt('--delay', '1500'), 10);

const { jobs } = JSON.parse(fs.readFileSync(path.join(__dirname, 'jobs.json'), 'utf8'));
let queue = TRADE ? jobs.filter(j => j.trade === TRADE) : jobs;
if (LIMIT > 0) queue = queue.slice(0, LIMIT);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseItems(text) {
  const m = String(text || '').match(/MATERIALS:\s*([\s\S]+?)(?:\/MATERIALS|$)/);
  if (!m) return [];
  return m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).map(line => {
    const p = line.replace(/^-\s*/, '').split('|').map(x => x.trim());
    return { name: p[0] || '', spec: p[1] || '', qty: p[2] || '', aisle: p[3] || '', price: p[4] || '' };
  }).filter(i => i.name);
}

function notesOf(text) {
  const m = String(text || '').match(/NOTES:\s*(.+?)(?=\nTOOLS:|\nMATERIALS:|$)/s);
  return m ? m[1].trim() : '';
}

// Did the response cover each thing a tradesperson would call non-negotiable?
function essentialsCovered(items, notes, essentials) {
  const hay = (items.map(i => `${i.name} ${i.spec}`).join(' ') + ' ' + notes).toLowerCase();
  return essentials.map(e => ({
    term: e,
    found: e.toLowerCase().split(/\s+/).every(w => hay.includes(w)),
  }));
}

const SAFETY_WORDS = /licensed|professional|electrician|plumber|permit|inspector|gas company|evacuate|do not|shut off|turn off|call a|engineer|fire (risk|hazard)/i;

async function runJob(job) {
  const started = Date.now();
  const url = `${BASE}/api/${ENDPOINT}`;
  const body = {
    tier: 'free',
    prompt: job.text,
    store: 'hd',
    trade: job.trade,
    // 1100 truncates the JSON on longer lists; the plan cap is 1600.
    max_tokens: 1600,
  };

  let res, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://diagnostechai.com' },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (e) {
    return { job, error: `request failed: ${e.message}`, ms: Date.now() - started };
  }

  if (data.error) return { job, error: String(data.error).slice(0, 160), ms: Date.now() - started };

  const items = Array.isArray(data.items) ? data.items : parseItems(data.text);
  const notes = data.notes || notesOf(data.text);
  const covered = essentialsCovered(items, notes, job.expectEssential || []);

  return {
    job,
    ms: Date.now() - started,
    provider: data.provider || (data.opinionsUsed || []).join('+') || '?',
    model: data.model || '',
    itemCount: items.length,
    verifiedCount: items.filter(i => i.aisleVerified).length,
    items,
    notes,
    covered,
    missing: covered.filter(c => !c.found).map(c => c.term),
    safetyFlagged: SAFETY_WORDS.test(notes),
  };
}

function csvCell(v) {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

(async () => {
  console.log(`Ask Danny eval — ${queue.length} jobs against ${BASE}/api/${ENDPOINT}\n`);
  const results = [];

  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${queue.length}] ${job.id} ${job.text.slice(0, 44).padEnd(46)}`);
    const r = await runJob(job);
    results.push(r);

    if (r.error) {
      console.log(`ERROR  ${r.error.slice(0, 50)}`);
    } else {
      const miss = r.missing.length ? `missing: ${r.missing.join(', ')}` : 'all essentials present';
      const trap = job.trap ? (r.safetyFlagged ? ' [safety flagged]' : ' [SAFETY NOT FLAGGED]') : '';
      console.log(`${String(r.itemCount).padStart(2)} items  ${String(r.verifiedCount)} verified  ${miss}${trap}`);
    }
    if (i < queue.length - 1) await sleep(DELAY_MS);
  }

  // ── machine-checkable summary ──
  const ok = results.filter(r => !r.error);
  const withEssentials = ok.filter(r => (r.job.expectEssential || []).length);
  const fullyCovered = withEssentials.filter(r => !r.missing.length);
  const traps = results.filter(r => r.job.trap);
  // An errored request is not a handled safety case. Counting errors as passes
  // reported 12/13 on a run where most traps never reached a provider.
  const trapsAnswered = traps.filter(r => !r.error);
  const trapsFlagged = trapsAnswered.filter(r => r.safetyFlagged);

  console.log('\n─────────────────────────────────────────────');
  console.log(`  completed          ${ok.length}/${results.length}`);
  console.log(`  essentials covered ${fullyCovered.length}/${withEssentials.length} jobs`);
  console.log(`  aisles verified    ${ok.reduce((n, r) => n + r.verifiedCount, 0)}/${ok.reduce((n, r) => n + r.itemCount, 0)} items`);
  console.log(`  safety/trap jobs   ${trapsFlagged.length}/${trapsAnswered.length} flagged (${traps.length - trapsAnswered.length} never answered)`);
  console.log(`  median latency     ${(() => {
    const t = ok.map(r => r.ms).sort((a, b) => a - b);
    return t.length ? (t[Math.floor(t.length / 2)] / 1000).toFixed(1) + 's' : 'n/a';
  })()}`);
  console.log('─────────────────────────────────────────────');

  // ── grading sheet ──
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const csvPath = path.join(__dirname, `results-${stamp}.csv`);
  const rows = [[
    'job_id', 'trade', 'what_the_customer_said', 'daniel_item', 'spec', 'qty',
    'aisle_given', 'aisle_verified', 'price',
    'TRADESPERSON_would_buy_this? (y/n)', 'TRADESPERSON_aisle_correct? (y/n/na)', 'TRADESPERSON_notes',
  ]];
  results.forEach(r => {
    if (r.error) {
      rows.push([r.job.id, r.job.trade, r.job.text, `ERROR: ${r.error}`, '', '', '', '', '', '', '', '']);
      return;
    }
    if (!r.items.length) {
      rows.push([r.job.id, r.job.trade, r.job.text, '(no items returned)', '', '', '', '', '', '', '', '']);
    }
    r.items.forEach(i => rows.push([
      r.job.id, r.job.trade, r.job.text, i.name, i.spec, i.qty,
      i.aisle, i.aisleVerified ? 'verified' : 'guessed', i.price, '', '', '',
    ]));
    // a row for what was missing entirely — the most valuable column
    r.missing.forEach(m => rows.push([
      r.job.id, r.job.trade, r.job.text, `*** MISSING: ${m} ***`, '', '', '', '', '', 'n', '', 'expected but not listed',
    ]));
  });
  fs.writeFileSync(csvPath, rows.map(r => r.map(csvCell).join(',')).join('\n'));

  const jsonPath = path.join(__dirname, `results-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  console.log(`\ngrading sheet  ${path.relative(process.cwd(), csvPath)}`);
  console.log(`raw results    ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`\nOpen the CSV, fill the three TRADESPERSON columns, and the misses`);
  console.log(`will tell you what to fix — in products.json or in the prompt.`);
})();
