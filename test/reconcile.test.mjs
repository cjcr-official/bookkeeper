// Characterization harness for the reconciliation matcher.
//
// WHY THIS EXISTS: `reconcileMatch` (index.html) is ~290 lines, drives the whole
// Statements/reconcile feature, and had NO tests despite CLAUDE.md claiming a
// "regression harness". This pins its CURRENT behavior so the section can be
// refactored (the "collapse attribution" work) without silently breaking the
// account-separation and combo-match logic the bug-scar comments describe.
//
// HOW: it extracts the ACTUAL functions from index.html by name (brace-matched)
// and evals them with stubbed globals (cache/profile/etc.). No copy-paste — the
// harness always runs shipped code. There is no build step, matching the app.
//
//   run:  node test/reconcile.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// --- Extract a top-level `function name(...) {...}` by brace matching. --------
// Comment-aware: the matcher's comments are full of contractions ("doesn't",
// "it's"), so a naive scanner treats those apostrophes as string delimiters and
// overruns. Skip //-line and /* */ comments; track strings with escape handling.
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('cannot find function ' + name);
  let i = src.indexOf('{', start), depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const NEEDED = ['fmt', 'parseDate', 'ymd', 'budDateAt', 'billRecurs', 'billDueDay',
  'reconBankMap', 'reconBankKey', 'recBankFor', 'reconcileMatch'];

// --- Sandbox globals the extracted functions close over. ---------------------
// Tests set `cache` / `profile` per scenario via the returned setters.
const sandbox = { cache: {}, profile: {} };
const bodies = NEEDED.map(extract).join('\n\n');
const factory = new Function(
  'cache', 'profile', 'billPaidMap', 'getBills',
  bodies + '\n\nreturn { reconcileMatch, parseDate };'
);
function build() {
  return factory(
    sandbox.cache,
    sandbox.profile,
    () => sandbox.profile.bill_paid || {},
    () => Array.isArray(sandbox.profile.budget_bills) ? sandbox.profile.budget_bills : []
  );
}

// --- Tiny assertion kit. -----------------------------------------------------
let pass = 0, fail = 0;
const fails = [];
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; fails.push(`  ✗ ${msg}\n      expected ${e}\n      got      ${a}`); }
}
function test(name, fn) {
  // reset sandbox each scenario
  sandbox.cache = { expenses: [], invoices: [], owner_transactions: [], store_credits: [], loans: [] };
  sandbox.profile = { plaid_recon: {}, recon_bank: {}, bill_paid: {}, budget_bills: [] };
  const api = build();
  try { fn(api); console.log('• ' + name); }
  catch (e) { fail++; fails.push(`  ✗ ${name} THREW: ${e.message}`); }
}

// Helper: a minimal Plaid-shaped statement.
function stmt(month, txns, extra = {}) {
  const dates = txns.map(t => t.date).filter(Boolean).sort();
  return {
    statement_month: month + '-15',
    period_start: month + '-01',
    period_end: month + '-28',
    transactions: txns,
    opening_balance: null, closing_balance: null,
    bankKey: extra.bankKey || 'bankA',
    ...extra,
  };
}

// ============================================================================
// SCENARIOS — each pins a behavior the CLAUDE.md comments promise.
// ============================================================================

// 1. A plain expense auto-matches the bank line that mirrors it (sign flipped).
test('one expense auto-matches one bank line', ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-03-10', amount: 42.00, vendor: 'Parts' }];
  const s = stmt('2026-03', [{ date: '2026-03-11', amount: -42.00, description: 'PARTS' }]);
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 1, 'one match group');
  eq(r.onBankOnly.length, 0, 'no unmatched bank lines');
  eq(r.inRecordsOnly.length, 0, 'no unmatched records');
  eq(r.passed, true, 'month passes');
  eq(r.matchedFps, ['e:e1'], 'matchedFps records the expense fp');
});

// 2. THE v473 REGRESSION. A record that only AUTO-matched on another bank must
//    NOT be withheld here — it must still match this bank's real line. (Weak
//    claim deferred until after the passes.) Pre-fix code fails this.
test('weak cross-bank claim does not orphan this month (v473)', ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-03-10', amount: 100, vendor: 'Shared' }];
  // Another bank's saved month auto-matched e1 (weak claim only).
  sandbox.profile.plaid_recon = { bankB: { '2026-03': { matched_fps: ['e:e1'] } } };
  const s = stmt('2026-03', [{ date: '2026-03-10', amount: -100, description: 'SHARED' }], { bankKey: 'bankA' });
  const r = reconcileMatch(s, null);
  eq(r.passed, true, 'bankA still balances despite weak claim elsewhere');
  eq(r.onBankOnly.length, 0, 'the real bank line is not orphaned');
});

// 3. A record explicitly (STRONG) matched on another bank is withheld here.
test('strong cross-bank claim withholds the record here', ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-03-10', amount: 100, vendor: 'Shared' }];
  sandbox.profile.plaid_recon = { bankB: { '2026-03': { manual_matches: [{ rFps: ['e:e1'], tIdxs: [0] }] } } };
  const s = stmt('2026-03', [{ date: '2026-03-10', amount: -100, description: 'SHARED' }], { bankKey: 'bankA' });
  const r = reconcileMatch(s, null);
  eq(r.inRecordsOnly.length, 0, 'record does not appear in bankA books');
  eq(r.onBankOnly.length, 1, 'bankA bank line is left unmatched (record spoken for)');
});

// 4. Combo pass: one $120 deposit = two recorded payments ($100 + $20).
test('combo pass: one line = several records', ({ reconcileMatch }) => {
  sandbox.cache.invoices = [
    { id: 'i1', amount_paid: 100, paid_date: '2026-03-05', number: '2601', customer_name: 'A' },
    { id: 'i2', amount_paid: 20, paid_date: '2026-03-06', number: '2602', customer_name: 'B' },
  ];
  const s = stmt('2026-03', [{ date: '2026-03-06', amount: 120, description: 'DEPOSIT' }]);
  const r = reconcileMatch(s, null);
  eq(r.passed, true, 'month passes via combo');
  eq(r.matched.length, 1, 'single combo group');
  eq(r.matched[0].rIdxs.length, 2, 'two records in the group');
});

// 5. "Paid from" tag routes a record to its bank only.
test('recon_bank tag routes a record to one bank', ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-03-10', amount: 50, vendor: 'Tagged' }];
  sandbox.profile.recon_bank = { 'e:e1': 'bankB' };
  const s = stmt('2026-03', [{ date: '2026-03-10', amount: -50, description: 'TAGGED' }], { bankKey: 'bankA' });
  const r = reconcileMatch(s, null);
  eq(r.inRecordsOnly.length, 0, 'tagged-away record absent from bankA books');
  eq([...r.assignedAway.keys()], ['e:e1'], 'record reported as assigned away');
  eq(r.onBankOnly.length, 1, 'bankA line unmatched (its record belongs to bankB)');
});

// 6. skip_fps sets a record aside; it neither matches nor blocks the pass.
test('skip_fps sets a record aside without failing the month', ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-03-10', amount: 7, vendor: 'Cash only' }];
  const s = stmt('2026-03', [], { skip_fps: ['e:e1'] });
  const r = reconcileMatch(s, null);
  eq(r.inRecordsOnly.length, 0, 'skipped record not in unmatched list');
  eq(r.skippedRecs.map(x => x.fp), ['e:e1'], 'record shows in skipped list');
  eq(r.passed, true, 'empty statement with only a set-aside still passes');
});

// ============================================================================
console.log('');
if (fails.length) { console.log(fails.join('\n')); console.log(''); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
