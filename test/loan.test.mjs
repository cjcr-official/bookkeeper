// Harness for the LOAN engine — computeLoan / loanActual / loanForwardSchedule.
//
// WHY THIS EXISTS: this is the only place in the app that does compound arithmetic,
// and every number the Loan tab shows (the payment, the interest, the remaining
// balance, the payoff date, the calendar dots, the Dashboard's "next payment due")
// comes out of these three functions. A wrong figure here doesn't throw and doesn't
// look wrong — it just quietly misstates what is owed. The engine is pure, so it can
// be checked against closed-form amortization instead of against itself.
//
//   run:  node test/loan.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// --- Extract a top-level `function name(...) {...}` by brace matching. --------
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

// The shipped engine, with its one dependency (ymd — local calendar dates).
const L = new Function(`
  ${extract('ymd')}
  ${extract('loanNum')}
  ${extract('loanStepPaymentNo')}
  ${extract('computeLoan')}
  ${extract('loanToObj')}
  ${extract('loanPays')}
  ${extract('loanRateOn')}
  ${extract('loanActual')}
  ${extract('loanForwardSchedule')}
  return { computeLoan, loanToObj, loanPays, loanRateOn, loanActual, loanForwardSchedule, loanStepPaymentNo };
`)();

// --- Tiny assert harness (matches the other suites' output style). -----------
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error((msg ? msg + ': ' : '') + 'expected ' + b + ' ±' + tol + ', got ' + a);
}
// Closed-form monthly payment, independent of the code under test.
const annuity = (P, annualPct, n) => {
  const r = annualPct / 100 / 12;
  return r === 0 ? P / n : P * r / (1 - Math.pow(1 + r, -n));
};

const BASE = { amount: 20000, rate: 6, term_num: 5, term_unit: 'years', extra: 0, start_date: '2025-01-15', rate_steps: [] };

console.log('\n── the amortization itself ──\n');

test('the payment matches the closed-form annuity', () => {
  const c = L.computeLoan(BASE);
  ok(c.valid, 'should be a valid loan');
  near(c.firstMonthly, annuity(20000, 6, 60), 0.005, 'monthly payment');
  near(c.firstMonthly, 386.66, 0.01, '$20k at 6% over 5 years');
  eq(c.payoffCount, 60, 'pays off in exactly the term');
  near(c.totalPaid, c.firstMonthly * 60, 0.02, 'total paid');
  near(c.totalInterest, c.firstMonthly * 60 - 20000, 0.02, 'total interest');
});

test('every row is self-consistent and the balance lands on zero', () => {
  const c = L.computeLoan(BASE);
  let bal = 20000, interest = 0;
  c.rows.forEach(r => {
    near(r.interest, bal * r.rateM, 0.005, 'interest on row ' + r.k);
    near(r.pay, r.principal + r.interest, 0.005, 'payment splits on row ' + r.k);
    bal -= r.principal; interest += r.interest;
    near(r.bal, Math.max(0, bal), 0.005, 'running balance on row ' + r.k);
  });
  near(bal, 0, 0.005, 'final balance');
  near(interest, c.totalInterest, 0.02, 'summed interest matches the total');
});

test('a 0% loan is just the principal split evenly', () => {
  const c = L.computeLoan({ ...BASE, rate: 0, term_num: 10, term_unit: 'months' });
  near(c.firstMonthly, 2000, 0.005, 'monthly');
  eq(c.payoffCount, 10);
  near(c.totalInterest, 0, 0.005, 'no interest');
});

test('dates walk the calendar from the first payment', () => {
  const c = L.computeLoan(BASE);
  eq(c.rows[0].date, '2025-01-15', 'first payment');
  eq(c.rows[1].date, '2025-02-15');
  eq(c.rows[11].date, '2025-12-15');
  eq(c.rows[59].date, '2029-12-15', 'last payment, 60 months out');
});

test('extra principal shortens the loan and cuts the interest', () => {
  const plain = L.computeLoan(BASE);
  const extra = L.computeLoan({ ...BASE, extra: 100 });
  near(extra.firstMonthly, plain.firstMonthly + 100, 0.005, 'the extra rides on the payment');
  ok(extra.payoffCount < plain.payoffCount, 'should pay off sooner');
  ok(extra.totalInterest < plain.totalInterest, 'and cost less interest');
  // Closed form: n = -ln(1 - P·r/pmt) / ln(1+r) = 46.1 → 47 payments (vs 60).
  eq(extra.payoffCount, 47, '$100/mo extra on $20k at 6% clears it 13 months early');
});

test('an incomplete loan is invalid, not zero', () => {
  ok(!L.computeLoan({ ...BASE, amount: 0 }).valid, 'no amount');
  ok(!L.computeLoan({ ...BASE, term_num: 0 }).valid, 'no term');
  ok(!L.computeLoan({ ...BASE, amount: 'abc' }).valid, 'garbage amount');
  ok(L.computeLoan({ ...BASE, rate: 0 }).valid, '0% is a real loan');
});

console.log('\n── adjustable rates ──\n');

test('a rate change re-amortizes the remaining balance', () => {
  const c = L.computeLoan({ ...BASE, rate_steps: [{ date: '2026-01-15', rate: 9 }] });
  eq(c.changeCount, 1);
  const step = c.rows.find(r => r.isStep);
  eq(step.k, 13, 'payment 13 is January 2026');
  near(step.rateM, 9 / 100 / 12, 1e-9, 'the new monthly rate');
  ok(c.rows[12].pay > c.rows[11].pay, 'the payment rises to keep the term');
  eq(c.payoffCount, 60, 'and the loan still ends on schedule');
  ok(c.totalInterest > L.computeLoan(BASE).totalInterest, 'costing more interest');
});

test('a step is resolved by date when there is a first-payment date, else by number', () => {
  const start = new Date('2025-01-15T12:00:00');
  eq(L.loanStepPaymentNo({ date: '2025-01-15' }, start), 1, 'the first payment is #1');
  eq(L.loanStepPaymentNo({ date: '2026-01-15' }, start), 13);
  eq(L.loanStepPaymentNo({ month: '13' }, null), 13, 'no start date → the typed number');
});

test('a step before the second payment is ignored, not applied backwards', () => {
  // stepMap only takes m >= 2 — a rate "change" at origination is the opening rate.
  const c = L.computeLoan({ ...BASE, rate_steps: [{ date: '2024-06-15', rate: 12 }] });
  eq(c.changeCount, 0, 'a step dated before the loan starts must not take effect');
  near(c.firstMonthly, annuity(20000, 6, 60), 0.005, 'the opening rate still rules');
});

test('the rate in effect on a date walks the schedule', () => {
  const c = L.computeLoan({ ...BASE, rate_steps: [{ date: '2026-01-15', rate: 9 }] });
  near(L.loanRateOn(c, '2025-06-15'), 6 / 100 / 12, 1e-9, 'before the change');
  near(L.loanRateOn(c, '2026-06-15'), 9 / 100 / 12, 1e-9, 'after it');
  near(L.loanRateOn(c, '2099-01-01'), 9 / 100 / 12, 1e-9, 'past the end of the schedule');
});

console.log('\n── recorded payments vs. the schedule ──\n');

const paysFrom = (rows, n, amt) => rows.slice(0, n).map((r, i) => ({ id: 'p' + i, date: r.date, amount: amt == null ? r.pay : amt }));

test('paying exactly on schedule lands on exactly the scheduled balance', () => {
  const c = L.computeLoan(BASE);
  const loan = { ...BASE, payments: paysFrom(c.rows, 12) };
  const act = L.loanActual(loan, c);
  eq(act.count, 12);
  near(act.remaining, c.rows[11].bal, 0.02, 'balance after a year of on-time payments');
  near(act.paidTotal, c.firstMonthly * 12, 0.02);
  near(act.interestPaid + act.principalPaid, act.paidTotal, 0.02, 'every dollar is interest or principal');
});

test('and the forward projection reproduces the rest of the original schedule', () => {
  // The claim the whole "re-forecast from reality" design rests on: an on-time payer
  // must see the SAME remaining schedule they'd have seen before it existed.
  const c = L.computeLoan(BASE);
  const loan = { ...BASE, payments: paysFrom(c.rows, 12) };
  const fwd = L.loanForwardSchedule(loan, c, L.loanActual(loan, c));
  eq(fwd.made, 12);
  eq(fwd.count, 48, '48 payments left of 60');
  eq(fwd.rows[0].date, '2026-01-15', 'next payment is the 13th');
  eq(fwd.rows[0].n, 13, 'numbered absolutely');
  eq(fwd.payoffDate, '2029-12-15', 'and it still ends on the original payoff date');
  near(fwd.rows[0].pay, c.rows[12].pay, 0.02, 'same payment');
  near(fwd.rows[47].bal, 0, 0.02, 'ending at zero');
});

test('paying extra moves the payoff IN', () => {
  const c = L.computeLoan(BASE);
  const loan = { ...BASE, payments: paysFrom(c.rows, 12, 800) };   // ~2x the payment
  const act = L.loanActual(loan, c);
  const fwd = L.loanForwardSchedule(loan, c, act);
  ok(act.remaining < c.rows[11].bal, 'balance is further down than scheduled');
  ok(fwd.count < 48, 'fewer payments left');
  ok(fwd.payoffDate < '2029-12-15', 'payoff date moves in: ' + fwd.payoffDate);
});

test('underpaying moves it OUT and can grow the balance', () => {
  const c = L.computeLoan(BASE);
  const interestOnly = c.rows[0].interest;
  const loan = { ...BASE, payments: paysFrom(c.rows, 6, Math.round(interestOnly - 10)) };
  const act = L.loanActual(loan, c);
  ok(act.remaining > 20000, 'paying less than the interest owes MORE: ' + act.remaining.toFixed(2));
  const fwd = L.loanForwardSchedule(loan, c, act);
  ok(fwd.count > 54, 'and the payoff pushes out');
});

test('a lump sum that clears the balance reads as paid off', () => {
  const c = L.computeLoan(BASE);
  const loan = { ...BASE, payments: [{ id: 'a', date: '2025-01-15', amount: 25000 }] };
  const act = L.loanActual(loan, c);
  ok(act.paidOff, 'should be paid off');
  eq(act.remaining, 0, 'never negative');
  const fwd = L.loanForwardSchedule(loan, c, act);
  ok(fwd.paidOff && !fwd.rows.length, 'nothing left to schedule');
  eq(fwd.payoffDate, null);
});

test('a skipped month is charged its interest, not waved through', () => {
  const c = L.computeLoan(BASE);
  const onTime = { ...BASE, payments: paysFrom(c.rows, 3) };
  // Same three payments, but the third lands three months late.
  const late = { ...BASE, payments: paysFrom(c.rows, 3).map((p, i) => i === 2 ? { ...p, date: '2025-06-15' } : p) };
  const a = L.loanActual(onTime, c), b = L.loanActual(late, c);
  near(a.paidTotal, b.paidTotal, 0.005, 'the same money went in');
  ok(b.remaining > a.remaining, 'but more is still owed after the gap');
  ok(b.interestPaid > a.interestPaid, 'because the extra months accrued interest');
});

test('payments are read in date order however they were entered', () => {
  const c = L.computeLoan(BASE);
  const inOrder = paysFrom(c.rows, 3);
  const shuffled = [inOrder[2], inOrder[0], inOrder[1]];
  near(L.loanActual({ ...BASE, payments: shuffled }, c).remaining,
       L.loanActual({ ...BASE, payments: inOrder }, c).remaining, 0.005, 'same balance');
});

test('a rate change between two payments is honored month by month', () => {
  // A payment gap spanning a rate change must accrue each month at ITS own rate —
  // charging one flat rate across the whole gap is what this guards.
  const steps = { ...BASE, rate_steps: [{ date: '2025-04-15', rate: 18 }] };
  const c = L.computeLoan(steps);
  const loan = { ...steps, payments: [
    { id: 'a', date: '2025-01-15', amount: 400 },
    { id: 'b', date: '2025-07-15', amount: 400 },   // six months later, across the step
  ] };
  const act = L.loanActual(loan, c);
  const flat6 = L.loanActual({ ...BASE, payments: loan.payments }, L.computeLoan(BASE));
  ok(act.remaining > flat6.remaining, 'the 18% months must cost more than 6% ones');
});

console.log('\n── the guards ──\n');

test('an absurd term cannot spin forever', () => {
  const c = L.computeLoan({ ...BASE, term_num: 200, term_unit: 'years' });   // 2400 months
  ok(c.rows.length <= 1200, 'capped at the MAX guard, got ' + c.rows.length);
  ok(c.noAmortize, 'and flagged as not amortizing inside the cap');
});

test('a payment that never covers the interest is flagged, not projected', () => {
  // Forward-only case: the schedule payment is fixed, so a later rate step can put
  // interest above it. It must stop and say so rather than emit a fake payoff date.
  const c = L.computeLoan(BASE);
  const act = { remaining: 20000, paidOff: false, count: 0 };
  const fwd = L.loanForwardSchedule({ ...BASE, payments: [] },
    { ...c, firstMonthly: 50, rows: c.rows, r: c.r }, act);   // $50 against ~$100 interest
  ok(fwd.noAmortize, 'should be flagged');
  eq(fwd.rows.length, 0, 'and emit no rows');
  eq(fwd.payoffDate, null, 'and above all no payoff date');
});

test('an invalid loan projects nothing', () => {
  const c = L.computeLoan({ ...BASE, amount: 0 });
  const fwd = L.loanForwardSchedule({ payments: [] }, c, { remaining: 0, paidOff: false });
  eq(fwd.rows.length, 0);
  eq(fwd.count, 0);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
