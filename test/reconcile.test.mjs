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
  'reconBankMap', 'reconBankKey', 'recBankFor', 'manualMatchTagMap', 'reconcileMatch',
  'shiftMonthKey', 'adjMonths', 'accountedFpsOf', 'clearedElsewhereMap',
  'applyClearedElsewhere', 'txnKey', 'makeTxnRefResolver'];

// --- Sandbox globals the extracted functions close over. ---------------------
// Tests set `cache` / `profile` per scenario via the returned setters.
const sandbox = { cache: {}, profile: {} };
const bodies = NEEDED.map(extract).join('\n\n');
const factory = new Function(
  'cache', 'profile', 'billPaidMap', 'getBills',
  bodies + '\n\nreturn { reconcileMatch, parseDate, manualMatchTagMap, shiftMonthKey, adjMonths,'
         + ' accountedFpsOf, clearedElsewhereMap, applyClearedElsewhere, txnKey, makeTxnRefResolver };'
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

// 2. NEW MODEL: a bare matched_fps guess on another bank has NO effect here — the
//    weak-inference system is gone, so nothing is withheld and the real line matches.
//    (This is the v473 orphan bug made structurally impossible.)
test('a stale matched_fps guess elsewhere is inert', ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-03-10', amount: 100, vendor: 'Shared' }];
  sandbox.profile.plaid_recon = { bankB: { '2026-03': { matched_fps: ['e:e1'] } } };   // legacy key, now ignored
  const s = stmt('2026-03', [{ date: '2026-03-10', amount: -100, description: 'SHARED' }], { bankKey: 'bankA' });
  const r = reconcileMatch(s, null);
  eq(r.passed, true, 'bankA balances — matched_fps no longer influences matching');
  eq(r.onBankOnly.length, 0, 'the real bank line is not orphaned');
});

// 3. MIGRATION → EXCLUSION. Cross-account separation now flows through the tag: a
//    manual match on another bank becomes a "Paid from" tag (migrateReconTags), and
//    that tag withholds the record here. Tests the full new path end to end.
test('a manual match elsewhere migrates to a tag that withholds here', ({ reconcileMatch, manualMatchTagMap }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-03-10', amount: 100, vendor: 'Shared' }];
  const recon = { bankB: { '2026-03': { manual_matches: [{ rFps: ['e:e1'], tIdxs: [0] }] } } };
  sandbox.profile.plaid_recon = recon;
  // Run the migration the app runs on load.
  sandbox.profile.recon_bank = manualMatchTagMap(recon, {});
  eq(sandbox.profile.recon_bank, { 'e:e1': 'bankB' }, 'manual match became an explicit tag');
  const s = stmt('2026-03', [{ date: '2026-03-10', amount: -100, description: 'SHARED' }], { bankKey: 'bankA' });
  const r = reconcileMatch(s, null);
  eq(r.inRecordsOnly.length, 0, 'record does not appear in bankA books');
  eq([...r.assignedAway.keys()], ['e:e1'], 'record reported as paid-from bankB');
  eq(r.onBankOnly.length, 1, 'bankA bank line is left unmatched (record belongs to bankB)');
});

// 3b. The migration drops WEAK matched_fps guesses — they must NOT become tags.
test('migration ignores matched_fps (weak) — only manual matches become tags', ({ manualMatchTagMap }) => {
  const recon = { bankB: { '2026-03': { matched_fps: ['e:e1'], manual_matches: [{ rFps: ['p:p9'] }] } } };
  const map = manualMatchTagMap(recon, {});
  eq(map, { 'p:p9': 'bankB' }, 'only the manual-matched fp is tagged; the auto-match guess is dropped');
});

// 3c. Migration must tag the EXACT occurrence, not the folded loan/bill parent —
//     one matched loan payment must not retag every other payment on that loan.
test('migration tags the exact occurrence, not the whole loan', ({ manualMatchTagMap }) => {
  const recon = { bankB: { '2026-03': { manual_matches: [{ rFps: ['l:loan1:pay1'] }] } } };
  eq(manualMatchTagMap(recon, {}), { 'l:loan1:pay1': 'bankB' }, 'only that payment is tagged');
});

// 4. CROSS-MONTH PROTECTION (v477 regression). A record explicitly matched in an
//    EARLIER month must not be stolen by a coincidental line in a later month —
//    that orphans the later month's real record and the month stops balancing.
test('a record manually matched in another month is not stolen here', ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-01-20', amount: 250, vendor: 'JanExpense' }];
  sandbox.profile.plaid_recon = { bankA: { '2026-01': { manual_matches: [{ tIdxs: [0], rFps: ['e:e1'] }] } } };
  const s = stmt('2026-02', [{ date: '2026-02-03', amount: -250, description: 'DIFFERENT CHARGE' }], { bankKey: 'bankA' });
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 0, 'the January record does not match a February line');
  eq(r.onBankOnly.length, 1, "February's line is correctly reported as needing a record");
  eq(r.gManual.has('e:e1'), true, 'finder can label it as matched in January');
});

// 4b. ...but the SAME month's own manual matches still apply (Pass 0 wins).
test("this month's own manual match still holds", ({ reconcileMatch }) => {
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-02-20', amount: 250, vendor: 'FebExpense' }];
  sandbox.profile.plaid_recon = { bankA: { '2026-02': { manual_matches: [{ tIdxs: [0], rFps: ['e:e1'] }] } } };
  const s = stmt('2026-02', [{ date: '2026-02-03', amount: -250, description: 'CHARGE' }], {
    bankKey: 'bankA', manual_matches: [{ tIdxs: [0], rFps: ['e:e1'] }] });
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 1, 'the pairing holds in its own month');
  eq(r.passed, true, 'month balances');
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

// 5b. A bill created from a bank line (createBillFromTxn's row shape) must become a
//     matchable candidate for that month — both one-time and recurring.
for (const recurring of [false, true]) {
  test(`a bill created from a charge matches its line (${recurring ? 'recurring' : 'one-time'})`, ({ reconcileMatch }) => {
    const ds = '2026-07-22';
    // Exactly what createBillFromTxn writes.
    const bill = { id: 'b1', name: 'Blackfoot Tele Auto',
      due: recurring ? parseInt(ds.slice(8, 10), 10) : null,
      date: recurring ? null : ds, recurring, amount: 69.95, reimbursed: 0, notes: '' };
    sandbox.profile.budget_bills = [bill];
    sandbox.profile.bill_paid = { '2026-07': { b1: true } };   // toggleBillPaid marks the occurrence
    const s = stmt('2026-07', [{ date: ds, amount: -69.95, description: 'BLACKFOOT TELE AUTO' }]);
    const r = reconcileMatch(s, null);
    eq(r.matched.length, 1, 'the new bill matches the charge');
    eq(r.matched[0].rIdxs.map(i => r.recs[i].fp), ['b:b1:2026-07'], 'paired via the bill occurrence fp');
    eq(r.passed, true, 'month balances');
  });
}

// 5c. A paycheck recorded on the Budget tab must match its payday deposit — without
//     this the deposit stays unmatched and the month can't balance.
test('a recorded paycheck matches its payday deposit', ({ reconcileMatch }) => {
  sandbox.profile.paycheck_amounts = { '2026-07-17': 1842.30 };
  const s = stmt('2026-07', [{ date: '2026-07-17', amount: 1842.30, description: 'DIRECT DEP PAYROLL' }]);
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 1, 'the deposit matches the paycheck');
  eq(r.matched[0].rIdxs.map(i => r.recs[i].fp), ['pc:2026-07-17'], 'paired via the paycheck fp');
  eq(r.passed, true, 'month balances');
});

// 5d. Paychecks are opt-in: no recorded amount means no candidate (an unrecorded
//     payday must not invent a record), and the deposit is correctly flagged.
test('an unrecorded payday creates no candidate', ({ reconcileMatch }) => {
  sandbox.profile.paycheck_amounts = {};
  const s = stmt('2026-07', [{ date: '2026-07-17', amount: 1842.30, description: 'DIRECT DEP PAYROLL' }]);
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 0, 'nothing matches');
  eq(r.onBankOnly.length, 1, 'the deposit is reported as needing a record');
});

// 5e. UNLINK (v480 regression). Unlinking a manual pair used to only drop the
//     manual_matches entry — and since a record created from a bank line matches it
//     by construction, the auto passes re-paired them on the same render, so Unlink
//     appeared to do nothing. unmatchByIdx now also parks both sides.
test('unlinking a manual pair does not let it re-form', ({ reconcileMatch }) => {
  sandbox.profile.paycheck_amounts = { '2026-07-17': 1842.30 };
  const txn = { date: '2026-07-17', amount: 1842.30, description: 'PAYROLL' };
  // Paired by applyPaycheckFromTxn.
  const paired = reconcileMatch(stmt('2026-07', [txn], { manual_matches: [{ tIdxs: [0], rFps: ['pc:2026-07-17'] }] }), null);
  eq(paired.matched.length, 1, 'starts paired');
  // What unmatchByIdx now writes: manual entry dropped AND both sides parked.
  const after = reconcileMatch(stmt('2026-07', [txn], {
    manual_matches: [], unmatch_t: [0], unmatch_r: ['pc:2026-07-17'] }), null);
  eq(after.matched.length, 0, 'stays unlinked instead of instantly re-pairing');
  eq(after.onBankOnly.length, 1, 'the deposit is free to match something else');
  eq(after.inRecordsOnly.length, 1, 'the paycheck is back in your books');
});

// 5f. A blocked pair can still be re-linked explicitly (Pass 0 beats the block),
//     which is the escape hatch that makes parking both sides safe.
test('an unlinked pair can still be re-matched by hand', ({ reconcileMatch }) => {
  sandbox.profile.paycheck_amounts = { '2026-07-17': 1842.30 };
  const s = stmt('2026-07', [{ date: '2026-07-17', amount: 1842.30, description: 'PAYROLL' }], {
    unmatch_t: [0], unmatch_r: ['pc:2026-07-17'],
    manual_matches: [{ tIdxs: [0], rFps: ['pc:2026-07-17'] }] });
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 1, 'explicit re-match wins over the block');
  eq(r.passed, true, 'month balances again');
});

// 5g. TWO paychecks on ONE payday (two earners). paycheck_amounts holds a single
//     amount per payday, so both deposits are recorded as that payday's combined
//     total and paired to BOTH lines (manual_matches is N↔1). Real numbers from
//     a Jul 10 payroll pair.
test('two same-day paychecks record as one payday total and both lines clear', ({ reconcileMatch }) => {
  sandbox.profile.paycheck_amounts = { '2026-07-10': 1143.62 + 1139.14 };
  const s = stmt('2026-07', [
    { date: '2026-07-10', amount: 1143.62, description: 'GLACIER BANCORP PAYROLL PPD JOHNSTON CASE' },
    { date: '2026-07-10', amount: 1139.14, description: 'GLACIER BANCORP PAYROLL PPD JOHNSTON MADISON' },
  ], { manual_matches: [{ tIdxs: [0, 1], rFps: ['pc:2026-07-10'] }] });
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 1, 'one group covering both deposits');
  eq(r.matched[0].tIdxs, [0, 1], 'both bank lines are in it');
  eq(r.onBankOnly.length, 0, 'neither deposit is left over');
  eq(r.passed, true, 'month balances');
});

// 5h. The combined total also auto-matches on a later pull, with no manual pairing —
//     Pass 4 (one record = several bank lines) covers it, so the pairing is durable.
test('a combined payday total auto-matches its two deposits', ({ reconcileMatch }) => {
  sandbox.profile.paycheck_amounts = { '2026-07-10': 2282.76 };
  const s = stmt('2026-07', [
    { date: '2026-07-10', amount: 1143.62, description: 'PAYROLL CASE' },
    { date: '2026-07-10', amount: 1139.14, description: 'PAYROLL MADISON' },
  ]);
  const r = reconcileMatch(s, null);
  eq(r.matched.length, 1, 'auto-matched as one group');
  eq(r.matched[0].tIdxs.length, 2, 'both deposits consumed');
  eq(r.passed, true, 'month balances without any manual pairing');
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
// CROSS-MONTH SETTLEMENT (v488). A record dated near a month boundary clears on
// the NEXT month's statement. Its own month used to report it "in your books ·
// not on the bank" and fail, while the neighbour matched it and passed — the
// July-30th / August-1st bug. Phase 2 forgives exactly that, after matching.
// ============================================================================

// 7. The reported bug, end to end: July fails on its own, passes once August's
//    reconcile is taken into account, and says where the record went.
test('a July 30th record that posts August 1st stops failing July', (api) => {
  const { reconcileMatch, clearedElsewhereMap, applyClearedElsewhere } = api;
  sandbox.cache.expenses = [
    { id: 'e1', date: '2026-07-30', amount: 80, vendor: 'Month-end parts' },
    { id: 'e2', date: '2026-07-05', amount: 20, vendor: 'Mid-month' },
  ];
  const july = reconcileMatch(stmt('2026-07', [{ date: '2026-07-06', amount: -20, description: 'MID' }], { period_end: '2026-07-31' }), null);
  eq(july.inRecordsOnly.map(r => r.fp), ['e:e1'], 'July alone reports the 30th as missing');
  eq(july.passed, false, 'July alone fails');

  const aug = reconcileMatch(stmt('2026-08', [{ date: '2026-08-01', amount: -80, description: 'PARTS' }]), null);
  eq(aug.matchedFps, ['e:e1'], 'August matched it at the bank');
  eq(aug.passed, true, 'August passes');

  applyClearedElsewhere(july, clearedElsewhereMap({ '2026-08': aug }));
  eq(july.passed, true, 'July passes once August is taken into account');
  eq(july.inRecordsOnly.length, 0, 'no longer reported as a discrepancy');
  eq(july.clearedElsewhere.map(r => [r.fp, r.clearedIn]), [['e:e1', '2026-08']], 'reported as cleared in August instead');
});

// 7b. Forgiveness is MONOTONE — it can only turn a failure into a pass. A bank
//     line with no record behind it must still fail the month.
test('cross-month forgiveness never hides an unexplained bank line', (api) => {
  const { reconcileMatch, clearedElsewhereMap, applyClearedElsewhere } = api;
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-07-30', amount: 80, vendor: 'Parts' }];
  const july = reconcileMatch(stmt('2026-07', [{ date: '2026-07-12', amount: -13.5, description: 'MYSTERY' }], { period_end: '2026-07-31' }), null);
  const aug = reconcileMatch(stmt('2026-08', [{ date: '2026-08-01', amount: -80, description: 'PARTS' }]), null);
  applyClearedElsewhere(july, clearedElsewhereMap({ '2026-08': aug }));
  eq(july.inRecordsOnly.length, 0, 'the record is forgiven');
  eq(july.onBankOnly.length, 1, 'the unexplained bank line is untouched');
  eq(july.passed, false, 'July still fails on the bank line');
});

// 7c. Only real MATCHES forgive. "Set aside" in the neighbour means "not on THAT
//     statement" — no evidence at all that it cleared here.
test('a set-aside in the neighbour month does not forgive', (api) => {
  const { reconcileMatch, clearedElsewhereMap, applyClearedElsewhere, accountedFpsOf } = api;
  sandbox.cache.expenses = [{ id: 'e1', date: '2026-07-30', amount: 80, vendor: 'Parts' }];
  const july = reconcileMatch(stmt('2026-07', [], { period_end: '2026-07-31' }), null);
  const aug = reconcileMatch(stmt('2026-08', [], { skip_fps: ['e:e1'] }), null);
  eq([...accountedFpsOf(aug)], ['e:e1'], 'the finder still knows August accounted for it');
  applyClearedElsewhere(july, clearedElsewhereMap({ '2026-08': aug }));
  eq(july.inRecordsOnly.map(r => r.fp), ['e:e1'], 'but it is NOT forgiven as cleared');
  eq(july.passed, false, 'July still needs review');
});

// 7d. Month-key arithmetic used to pick the neighbours (rolls over years).
test('adjMonths gives the two neighbouring month keys', ({ adjMonths, shiftMonthKey }) => {
  eq(adjMonths('2026-01'), ['2025-12', '2026-02'], 'January neighbours cross the year');
  eq(adjMonths('2026-12'), ['2026-11', '2027-01'], 'December neighbours cross the year');
  eq(shiftMonthKey('2026-03', -3), '2025-12', 'multi-month shift');
});

// ============================================================================
// BANK-LINE IDENTITY (v488). Manual matches and Unlinks were stored as bare
// positions into a live-refetched month, so one late-settling transaction shifted
// every later index and silently re-pointed them at a different line.
// ============================================================================

// 8. A transaction that settles into the middle of the month must not move an
//    existing manual match onto its neighbour.
test('a manual match survives a transaction inserted before it', ({ makeTxnRefResolver, txnKey }) => {
  const before = [
    { date: '2026-07-01', description: 'A', amount: -10 },
    { date: '2026-07-15', description: 'B', amount: -20 },
    { date: '2026-07-20', description: 'C', amount: -30 },
  ];
  const saved = { tIdxs: [2], tKeys: [txnKey(before[2])] };
  const after = [before[0], { date: '2026-07-10', description: 'LATE', amount: -5 }, before[1], before[2]];
  eq(makeTxnRefResolver(after)(saved.tKeys, saved.tIdxs), [3], 'follows the line, not the position');
  eq(makeTxnRefResolver(after)(null, saved.tIdxs), [2], 'legacy rows with no key still use the stored index');
});

// 8b. Two byte-identical lines stay distinguishable — keys are consumed, so the
//     same line is never handed to two different matches.
test('duplicate bank lines resolve to distinct indices', ({ makeTxnRefResolver, txnKey }) => {
  const txns = [
    { date: '2026-07-08', description: 'FUEL', amount: -40 },
    { date: '2026-07-08', description: 'FUEL', amount: -40 },
  ];
  const resolve = makeTxnRefResolver(txns);
  const k = txnKey(txns[0]);
  eq(resolve([k], [0]), [0], 'first reference takes the first line');
  eq(resolve([k], [1]), [1], 'second reference takes the other one');
  eq(resolve([k], [0]), [], 'a third has nothing left to claim');
});

// 8c. Banks rewrite the merchant name when a charge settles — fall back to
//     date + amount rather than losing the pairing.
test('a renamed merchant still resolves on date + amount', ({ makeTxnRefResolver, txnKey }) => {
  const key = txnKey({ date: '2026-07-08', description: 'SQ *PENDING AUTH', amount: -40 });
  const settled = [{ date: '2026-07-08', description: 'Ace Hardware', amount: -40 }];
  eq(makeTxnRefResolver(settled)(key ? [key] : [], [0]), [0], 'matched by date + amount');
});

// 8d. A keyed reference to a line the bank no longer reports is DROPPED, not
//     guessed onto whatever now sits at that index.
test('an unresolvable keyed reference is dropped, not guessed', ({ makeTxnRefResolver, txnKey }) => {
  const key = txnKey({ date: '2026-07-08', description: 'GONE', amount: -40 });
  const txns = [{ date: '2026-07-09', description: 'SOMETHING ELSE', amount: -95 }];
  eq(makeTxnRefResolver(txns)([key], [0]), [], 'no pairing rather than a wrong one');
});

// 8e. A '|' inside the description must not corrupt the date/amount parsing the
//     looser fallback tiers do.
test('a pipe in the description does not corrupt the key', ({ makeTxnRefResolver, txnKey }) => {
  const t = { date: '2026-07-08', description: 'ACME | STORE #12', amount: -40 };
  eq(makeTxnRefResolver([t])([txnKey(t)], [0]), [0], 'exact key still matches');
  const renamed = [{ date: '2026-07-08', description: 'ACME STORE', amount: -40 }];
  eq(makeTxnRefResolver(renamed)([txnKey(t)], [0]), [0], 'date + amount fallback still parses');
});

// ============================================================================
console.log('');
if (fails.length) { console.log(fails.join('\n')); console.log(''); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
