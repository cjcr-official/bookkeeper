// Harness for the money math: what you're owed, what counts as earned, and what
// state an invoice is really in.
//
// WHY THIS EXISTS: reconcileMatch had 51 tests while balanceDue / effectiveStatus /
// invoiceRevenue — the three functions the dashboard, the P&L and Outstanding are
// built on — had none. They decide the numbers the owner files taxes on.
//
// It also pins invoiceRevenue's two paths against each other: it takes an optional
// prebuilt index (reimbursedByInvoice()) so the dashboard's 6-month loop doesn't
// re-scan every expense per invoice. Indexed and unindexed MUST agree — if they ever
// diverge, the chart and the P&L quietly disagree about revenue.
//
//   run:  node test/money.test.mjs
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

// `today` is stubbed so overdue tests don't drift with the real clock.
const sandbox = { cache: { expenses: [] }, todayStr: '2026-06-15' };
const factory = new Function('cache', 'today', `
  ${extract('invoiceRevenue')}
  ${extract('reimbursedByInvoice')}
  ${extract('balanceDue')}
  ${extract('effectiveStatus')}
  return { invoiceRevenue, reimbursedByInvoice, balanceDue, effectiveStatus };
`);
const M = factory(sandbox.cache, () => sandbox.todayStr);
const setExpenses = (rows) => { sandbox.cache.expenses = rows; };

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error((msg || 'not equal') + `\n    got:      ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
}

console.log('\nMONEY MATH\n');

// ------------------------------------------------------------- balanceDue
test('an unpaid invoice owes its full total', () => {
  eq(M.balanceDue({ total: 250, amount_paid: 0, status: 'sent' }), 250);
});

test('a partial payment leaves the remainder', () => {
  eq(M.balanceDue({ total: 250, amount_paid: 100, status: 'sent' }), 150);
});

test('overpayment never goes negative', () => {
  // An invoice must not show as a NEGATIVE balance in Outstanding — that would
  // silently cancel out other invoices' balances in the dashboard total.
  eq(M.balanceDue({ total: 100, amount_paid: 175, status: 'sent' }), 0);
});

test('a legacy paid invoice with no amount_paid is settled', () => {
  // Old rows predate payment tracking; status alone has to settle them.
  eq(M.balanceDue({ total: 400, status: 'paid' }), 0);
});

test('missing/garbage amounts are treated as zero, not NaN', () => {
  // A NaN here propagates into Outstanding and poisons the whole dashboard figure.
  eq(M.balanceDue({ total: null, amount_paid: undefined, status: 'sent' }), 0);
  eq(M.balanceDue({ total: '250.50', amount_paid: '0.50', status: 'sent' }), 250);
});

// --------------------------------------------------------- effectiveStatus
test('paying the total in full flips it to paid', () => {
  eq(M.effectiveStatus({ total: 250, amount_paid: 250, status: 'sent', due: '2026-07-01' }), 'paid');
});

test('overpaying also reads as paid', () => {
  eq(M.effectiveStatus({ total: 250, amount_paid: 300, status: 'sent', due: '2026-07-01' }), 'paid');
});

test('past its due date and unpaid is overdue', () => {
  eq(M.effectiveStatus({ total: 250, amount_paid: 0, status: 'sent', due: '2026-06-14' }), 'overdue');
});

test('due TODAY is not yet overdue', () => {
  // Boundary: an invoice due today is still due, not late.
  eq(M.effectiveStatus({ total: 250, amount_paid: 0, status: 'sent', due: '2026-06-15' }), 'sent');
});

test('a draft is never overdue', () => {
  // Drafts were never sent, so they can't be late — and they must stay out of
  // Outstanding, which keys off this.
  eq(M.effectiveStatus({ total: 250, amount_paid: 0, status: 'draft', due: '2020-01-01' }), 'draft');
});

test('paid beats overdue', () => {
  eq(M.effectiveStatus({ total: 250, amount_paid: 250, status: 'sent', due: '2020-01-01' }), 'paid');
});

test('a zero-total invoice is not auto-paid', () => {
  // 0 >= 0 would be true, so an empty invoice must not report itself as paid.
  eq(M.effectiveStatus({ total: 0, amount_paid: 0, status: 'sent', due: '2026-07-01' }), 'sent');
});

// ---------------------------------------------------------- invoiceRevenue
test('revenue is the total when nothing was reimbursed', () => {
  setExpenses([]);
  eq(M.invoiceRevenue({ id: 'i1', total: 500 }), 500);
});

test('billed-back parts are excluded from revenue', () => {
  // The customer reimburses the part; it is a pass-through, not income. Outstanding
  // still shows the full amount owed — only revenue nets it out.
  setExpenses([
    { id: 'e1', invoice_id: 'i1', reimbursed: true, amount: 120 },
    { id: 'e2', invoice_id: 'i1', reimbursed: true, amount: 30 },
  ]);
  eq(M.invoiceRevenue({ id: 'i1', total: 500 }), 350);
});

test('a linked expense that is NOT reimbursed still counts as revenue', () => {
  setExpenses([{ id: 'e1', invoice_id: 'i1', reimbursed: false, amount: 120 }]);
  eq(M.invoiceRevenue({ id: 'i1', total: 500 }), 500);
});

test('another invoice\'s reimbursed expenses are not deducted', () => {
  setExpenses([{ id: 'e1', invoice_id: 'i2', reimbursed: true, amount: 120 }]);
  eq(M.invoiceRevenue({ id: 'i1', total: 500 }), 500);
});

// ------------------------------------------- indexed vs unindexed agreement
test('reimbursedByInvoice totals per invoice', () => {
  setExpenses([
    { id: 'e1', invoice_id: 'i1', reimbursed: true, amount: 120 },
    { id: 'e2', invoice_id: 'i1', reimbursed: true, amount: 30 },
    { id: 'e3', invoice_id: 'i2', reimbursed: true, amount: 45 },
    { id: 'e4', invoice_id: 'i2', reimbursed: false, amount: 999 },
    { id: 'e5', invoice_id: null, reimbursed: true, amount: 999 },
  ]);
  const idx = M.reimbursedByInvoice();
  eq(idx.get('i1'), 150);
  eq(idx.get('i2'), 45);
  eq(idx.has(null), false, 'an unlinked expense must not enter the index');
});

test('the indexed path matches the scanning path exactly', () => {
  // The dashboard chart uses the index and the P&L used to scan; if these ever
  // disagree the two screens report different revenue for the same year.
  const expenses = [], invoices = [];
  for (let i = 0; i < 60; i++) invoices.push({ id: 'i' + i, total: 100 + (i % 7) * 25 });
  for (let i = 0; i < 400; i++) expenses.push({
    id: 'e' + i,
    invoice_id: i % 3 === 0 ? 'i' + (i % 60) : null,
    reimbursed: i % 2 === 0,
    amount: (i % 9) * 1.11,
  });
  setExpenses(expenses);
  const idx = M.reimbursedByInvoice();
  const mismatched = invoices.filter(inv =>
    Math.abs(M.invoiceRevenue(inv) - M.invoiceRevenue(inv, idx)) > 1e-9);
  eq(mismatched.map(i => i.id), [], 'indexed and scanned revenue diverged');
});

test('an empty index means zero reimbursed, not a fallback rescan', () => {
  // Passing an index must be authoritative — if a caller builds it once and an
  // invoice has no entry, that means zero, not "go look again".
  setExpenses([{ id: 'e1', invoice_id: 'i1', reimbursed: true, amount: 120 }]);
  eq(M.invoiceRevenue({ id: 'i1', total: 500 }, new Map()), 500);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
