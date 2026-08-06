// Budget — paydays, and which of them a bank statement can possibly show.
//
// WHY THIS EXISTS: the Budget tab projects paydays from a schedule, and on a
// fixed-day schedule a payday landing on a weekend MOVES (the default is "pay the
// Friday before"). That means the payday a month plans against is routinely dated in
// the month NEXT DOOR: with a monthly schedule on the 1st, August 2026's paycheck is
// a July 31st deposit, because Aug 1 is a Saturday.
//
// paydaysForMonth() is keyed to the BUDGET month on purpose — that's where the
// Budget page shows the card, and paycheck_amounts is keyed by that projected date,
// so anything saved under another key is invisible there. But reconciliation asks a
// different question: "which paydays could be on THIS statement?" It used to answer
// with paydaysForMonth(statement month), so a deposit on July 31st offered only
// "Jul 1" — every option was wrong, and the honest move (record nothing) left the
// deposit unexplained and July's audit mark amber forever. paydaysOnStatement()
// answers the statement's question. The two must not be confused again.
//
// These tests run the SHIPPED functions, extracted out of index.html.
//
//   run:  node test/budget.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// --- Extract a top-level `function name(...) {...}` by brace matching. --------
// Keeps a leading `async` — everything that writes to the profile is async, and
// dropping the keyword yields a plain function whose `await`s are a syntax error.
function extract(name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('cannot find function ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
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

// The pay-schedule projection + the bill-month helpers, over a given profile.
function sandbox(sched) {
  const factory = new Function('profile', `
    ${extract('ymd')}
    ${extract('paySchedule')}
    ${extract('budDateAt')}
    ${extract('adjustWeekend')}
    ${extract('paydaysForMonth')}
    ${extract('paydaysOnStatement')}
    ${extract('billRecurs')}
    ${extract('billDueDay')}
    ${extract('billInMonth')}
    return { ymd, paydaysForMonth, paydaysOnStatement, budDateAt,
             billRecurs, billDueDay, billInMonth };
  `);
  const api = factory({ pay_schedule: sched });
  // Month args are 0-based in the app; these helpers take a human month so the
  // tests read like a calendar.
  api.paydays = (y, mHuman) => api.paydaysForMonth(y, mHuman - 1).map(api.ymd);
  api.onStatement = (y, mHuman) => api.paydaysOnStatement(y, mHuman - 1).map(api.ymd);
  return api;
}

// Tests are QUEUED and run in order at the end, so an async case (the paid-flag
// writers are async, like everything that touches the profile) is actually awaited.
// Running them inline would print the summary before they settled and count a
// rejected promise as a pass — a green suite that checks nothing.
let pass = 0, fail = 0;
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log('• ' + name); pass++; }
    catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
  });
}
function head(title) { queue.push(() => console.log('\n── ' + title + ' ──\n')); }
async function runAll() { for (const step of queue) await step(); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { process.env.TZ = prev; }
}
const denver = fn => withTZ('America/Denver', fn);

// Paid on the 1st, weekends paid the Friday before (the app's default).
const monthly1 = { freq: 'monthly', day: 1, weekend: 'before' };

head('projected paydays');

test('a payday on a weekend moves to the Friday before', () => {
  denver(() => {
    const s = sandbox(monthly1);
    eq(s.paydays(2026, 7).join(), '2026-07-01', 'Jul 1 2026 is a Wednesday — untouched');
    eq(s.paydays(2026, 8).join(), '2026-07-31', 'Aug 1 is a Saturday → paid Fri Jul 31');
    eq(s.paydays(2026, 11).join(), '2026-10-30', 'Nov 1 is a Sunday → paid Fri Oct 30');
  });
});

test('or the Monday after, or the exact date, when told to', () => {
  denver(() => {
    eq(sandbox({ freq: 'monthly', day: 1, weekend: 'after' }).paydays(2026, 8).join(), '2026-08-03');
    eq(sandbox({ freq: 'monthly', day: 1, weekend: 'none' }).paydays(2026, 8).join(), '2026-08-01');
  });
});

test('a day past the end of a short month falls on its last day', () => {
  denver(() => {
    const s = sandbox({ freq: 'monthly', day: 31, weekend: 'none' });
    eq(s.paydays(2026, 2).join(), '2026-02-28', 'February has no 31st');
    eq(s.paydays(2026, 4).join(), '2026-04-30');
  });
});

test('semimonthly gives two paydays, in order', () => {
  denver(() => {
    const s = sandbox({ freq: 'semimonthly', days: [15, 1], weekend: 'before' });
    eq(s.paydays(2026, 3).join(), '2026-02-27,2026-03-13',
       'Mar 1 is a Sunday → Fri Feb 27; Mar 15 is a Sunday → Fri Mar 13');
    eq(s.paydays(2026, 6).join(), '2026-06-01,2026-06-15', 'and an ordinary month is untouched');
  });
});

test('biweekly projects off the anchor and finds the third-paycheck months', () => {
  denver(() => {
    const s = sandbox({ freq: 'biweekly', anchor: '2026-01-02' });
    eq(s.paydays(2026, 1).join(), '2026-01-02,2026-01-16,2026-01-30', 'three in January');
    eq(s.paydays(2026, 2).join(), '2026-02-13,2026-02-27');
    eq(s.paydays(2026, 7).join(), '2026-07-03,2026-07-17,2026-07-31', 'and three in July');
  });
});

test('no schedule projects nothing (the page prompts to set one up)', () => {
  denver(() => eq(sandbox(null).paydays(2026, 8).length, 0));
});

head('which paydays a statement can show');

test("July's statement offers the payday that shifted back into July", () => {
  denver(() => {
    const s = sandbox(monthly1);
    eq(s.onStatement(2026, 7).join(), '2026-07-01,2026-07-31',
       'Jul 31 is August\'s paycheck — but it is JULY\'s bank line');
    ok(!s.paydays(2026, 7).includes('2026-07-31'),
       'and the budget month still lists it under August, where the card lives');
  });
});

test("August's statement keeps it too — a payday can post a day or two late", () => {
  denver(() => {
    eq(sandbox(monthly1).onStatement(2026, 8).join(), '2026-07-31',
       'the month\'s own list is never dropped, only added to');
  });
});

test('and the same shift the other way, when weekends pay the Monday after', () => {
  denver(() => {
    const s = sandbox({ freq: 'monthly', day: 31, weekend: 'after' });
    eq(s.paydays(2026, 10).join(), '2026-11-02', 'Oct 31 is a Saturday → paid Mon Nov 2');
    ok(s.onStatement(2026, 11).includes('2026-11-02'),
       "November's statement holds October's paycheck");
  });
});

test('a weekly/biweekly schedule is unaffected — nothing shifts', () => {
  denver(() => {
    const s = sandbox({ freq: 'biweekly', anchor: '2026-01-02' });
    for (const m of [1, 2, 7, 12]) {
      eq(s.onStatement(2026, m).join(), s.paydays(2026, m).join(), 'month ' + m);
    }
  });
});

test('the list is deduped and in date order', () => {
  denver(() => {
    const s = sandbox({ freq: 'semimonthly', days: [1, 15], weekend: 'before' });
    const got = s.onStatement(2026, 7);
    eq(got.join(), [...new Set(got)].sort().join(), 'no repeats, sorted');
    eq(got.join(), '2026-07-01,2026-07-15,2026-07-31');
  });
});

head('bills belong to a month');

test('a recurring bill is due every month; a one-time bill only in its own', () => {
  denver(() => {
    const s = sandbox(monthly1);
    const rent = { id: 'r', due: 5, recurring: true, amount: 900 };
    const tyres = { id: 't', date: '2026-08-20', recurring: false, amount: 610 };
    ok(s.billInMonth(rent, 2026, 6) && s.billInMonth(rent, 2026, 7), 'rent, both months');
    ok(s.billInMonth(tyres, 2026, 7), 'tyres in August');
    ok(!s.billInMonth(tyres, 2026, 6), 'and nowhere else');
  });
});

test('a legacy bill saved before the flag existed still repeats', () => {
  denver(() => {
    const s = sandbox(monthly1);
    const old = { id: 'o', due: 12, amount: 40 };   // no `recurring` key at all
    ok(s.billRecurs(old), 'undefined means monthly, as it always did');
    ok(s.billInMonth(old, 2025, 0), 'so it shows in any month');
    eq(s.billDueDay(old), 12);
  });
});

test("a one-time bill's due day comes from its date", () => {
  denver(() => {
    const s = sandbox(monthly1);
    eq(sandbox(monthly1).billDueDay({ id: 'x', date: '2026-08-20', recurring: false }), 20);
    eq(s.billDueDay({ id: 'y', recurring: true, due: null }), null, 'no due day is not day 1');
  });
});

test('a bill due the 31st lands on the last day of a short month', () => {
  denver(() => {
    const s = sandbox(monthly1);
    eq(s.ymd(s.budDateAt(2026, 1, 31)), '2026-02-28');
    eq(s.ymd(s.budDateAt(2026, 7, 31)), '2026-08-31');
  });
});

head('reconciliation asks the statement, not the budget month');

test('the paycheck picker is built from paydaysOnStatement', () => {
  const body = extract('paycheckFromTxn');
  ok(/paydaysOnStatement\(/.test(body),
     'paycheckFromTxn must offer the STATEMENT\'s paydays');
  ok(!/=\s*\(typeof paydaysForMonth[^\n]*paydaysForMonth\(by, bm-1\)/.test(body),
     'a weekend-shifted payday would have no option to file under');
});

test('the amount is still keyed by the projected payday the Budget page reads', () => {
  const body = extract('applyPaycheckFromTxn');
  ok(/savePaycheckAmount\(dateKey/.test(body),
     'paycheck_amounts stays keyed by the payday date — any other key is invisible on the Budget page');
});

head('a paid bill records what it actually cost');

// bill_paid used to hold a bare `true`, so the only amount reconciliation could offer
// for a paid occurrence was the bill's CURRENT planned figure. Two silent failures fell
// out of that: a variable bill (planned $118.42, charged $143.10) could never match its
// own bank line, and editing a recurring bill's amount restated every occurrence ever
// paid — flipping months that had already reconciled and stamped ✅ back to amber.
// The flag carries the real amount now, and must stay TRUTHY or the row un-ticks.

// Run the shipped toggle against an in-memory profile, with the network stubbed.
function paidFlagSandbox(initial) {
  const profile = { bill_paid: initial || {} };
  const factory = new Function('profile', 'updateProfileJson', 'renderBudget', 'showToast', `
    ${extract('budMonthKey')}
    ${extract('billPaidMap')}
    ${extract('isBillPaid')}
    ${extract('billPaidAmount')}
    ${extract('billPaidFlagAmount')}
    ${extract('toggleBillPaid')}
    ${extract('forgetBillTraces')}
    return { toggleBillPaid, isBillPaid, billPaidAmount, billPaidFlagAmount, forgetBillTraces };
  `);
  // Stand-in for the delta writer: apply() against the CURRENT server copy.
  const server = { bill_paid: JSON.parse(JSON.stringify(profile.bill_paid)), recon_bank: {} };
  const updateProfileJson = async (col, apply, empty) => {
    const start = server[col] == null ? (empty === undefined ? {} : empty)
                                      : JSON.parse(JSON.stringify(server[col]));
    server[col] = apply(start);
    profile[col] = server[col];
    return { error: null };
  };
  const api = factory(profile, updateProfileJson, () => {}, () => {});
  api.profile = profile; api.server = server;
  return api;
}

test('ticking a bill paid stores what it cost, not just that it was paid', async () => {
  const s = paidFlagSandbox();
  await s.toggleBillPaid('b1', 2026, 6, 143.10);          // July 2026
  eq(s.isBillPaid('b1', 2026, 6), true, 'the row shows paid');
  eq(s.billPaidAmount('b1', 2026, 6), 143.10, 'and the occurrence carries its real amount');
});

test('a $0 or unknown amount still marks the bill paid', async () => {
  const s = paidFlagSandbox();
  await s.toggleBillPaid('b1', 2026, 6, 0);
  eq(s.isBillPaid('b1', 2026, 6), true, '0 must not read as unpaid — the flag stays truthy');
  eq(s.billPaidAmount('b1', 2026, 6), null, 'with no amount to report');
  const s2 = paidFlagSandbox();
  await s2.toggleBillPaid('b2', 2026, 6);                  // no amount passed at all
  eq(s2.isBillPaid('b2', 2026, 6), true, 'an amount-less call still marks it paid');
});

test('un-ticking clears the occurrence entirely', async () => {
  const s = paidFlagSandbox();
  await s.toggleBillPaid('b1', 2026, 6, 143.10);
  await s.toggleBillPaid('b1', 2026, 6, 143.10);
  eq(s.isBillPaid('b1', 2026, 6), false, 'unpaid again');
  eq(JSON.stringify(s.profile.bill_paid), '{}', 'and the empty month is pruned');
});

test('a legacy `true` flag reports no amount, so the planned one stays the fallback', () => {
  const s = paidFlagSandbox({ '2026-07': { b1: true } });
  eq(s.isBillPaid('b1', 2026, 6), true, 'still paid');
  eq(s.billPaidAmount('b1', 2026, 6), null, 'no amount recorded → reconciliation falls back');
  eq(s.billPaidFlagAmount(true), null);
  eq(s.billPaidFlagAmount(undefined), null);
  eq(s.billPaidFlagAmount('143.10'), 143.10, 'a jsonb round-trip may hand back a string');
  eq(s.billPaidFlagAmount(-143.10), 143.10, 'stored positive either way');
});

test('reconciliation records the BANK line amount, not the planned one', () => {
  const body = extract('applyBillPayFromTxn');
  ok(/toggleBillPaid\([^)]*realAmt\)/.test(body),
     'the one path that knows the true amount must pass it through');
  ok(/s\.stmt\.transactions/.test(body), 'and it comes off the transaction being paired');
});

head('deleting a bill leaves nothing behind');

test('deleting a bill drops its paid flags and its "Paid from" tag', async () => {
  const s = paidFlagSandbox({ '2026-06': { b1: 90, b2: 45 }, '2026-07': { b1: 95 } });
  s.server.bill_paid = JSON.parse(JSON.stringify(s.profile.bill_paid));
  s.server.recon_bank = { 'b:b1': 'bankA', 'b:b1:2026-07': 'bankB', 'b:b2': 'bankA', 'e:e1': 'bankA' };
  s.profile.recon_bank = { ...s.server.recon_bank };
  // reconBankMap() is the app's reader; the extracted body closes over it.
  globalThis.reconBankMap = () => s.profile.recon_bank;
  globalThis.console = console;
  await s.forgetBillTraces('b1');
  eq(JSON.stringify(s.profile.bill_paid), JSON.stringify({ '2026-06': { b2: 45 } }),
     "b1's flags are gone and the month it emptied is pruned");
  eq(JSON.stringify(s.profile.recon_bank), JSON.stringify({ 'b:b2': 'bankA', 'e:e1': 'bankA' }),
     'the folded tag AND the per-occurrence override go, nothing else does');
  delete globalThis.reconBankMap;
});

test('deleteBill actually runs the cleanup', () => {
  const body = extract('deleteBill');
  ok(/forgetBillTraces\(/.test(body), 'deleteBill must clean up after itself');
});

test('the cleanup is a delta, never a whole-column write', () => {
  const body = extract('forgetBillTraces');
  ok(/updateProfileJson\('bill_paid'/.test(body) && /updateProfileJson\('recon_bank'/.test(body),
     'both columns go through the delta writer');
  ok(!/\.upsert\(/.test(body),
     'a whole-column upsert would roll back what another device changed since login');
});

head('the Budget report prints the month you asked for');

test('the Budget report is month-selectable, not pinned to today', () => {
  const body = extract('renderReport');
  const branch = body.slice(body.indexOf("r==='budget'"), body.indexOf("r==='loan'"));
  ok(/_reportBudgetMonth/.test(branch),
     'the printed month must be selectable — new Date() alone made every other month unreachable');
  ok(/selectReportBudgetMonth\(/.test(branch), 'and the picker has to be wired up');
  ok(!/buildBudgetReportDoc\(now\.getFullYear\(\)/.test(branch),
     'the current month is a default, not the only option');
});

test('it defaults to the month the Budget page is showing', () => {
  const body = extract('renderReport');
  const branch = body.slice(body.indexOf("r==='budget'"), body.indexOf("r==='loan'"));
  ok(/budgetCursor/.test(branch),
     'opening the report after browsing to a month should print that month');
});

test('the month list always contains the selected month', () => {
  const factory = new Function('budMonthKey', extract('budgetReportMonths') + '\nreturn budgetReportMonths;');
  const budgetReportMonths = factory((y, m) => `${y}-${String(m + 1).padStart(2, '0')}`);
  const near = budgetReportMonths(null);
  eq(near.length, 13, 'six months either side of today');
  const far = budgetReportMonths('2019-03');
  ok(far.some(o => o.key === '2019-03'),
     'a Budget page browsed far out of range must not silently print a different month');
  eq(far[0].key, '2019-03', 'and the list stays in date order');
});

await runAll();
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
