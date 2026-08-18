// Editing a record must not erase fields the form doesn't recognise.
//
// WHY THIS EXISTS: assigning select.value a string with no matching <option> sets
// selectedIndex to -1, so `.value` reads '' — and every save*() reads straight from
// `.value`. The form silently blanks a field nobody touched, and persists it.
//
// This is not hypothetical or multi-bank-only. Reconciliation books expenses with
// method 'bank' and category 'Prior-year refund', and invoice payments with method
// 'bank'; none of those appear in the corresponding option lists. Opening one of
// those records to fix a typo and saving used to wipe the field. Deleting a category
// that older expenses still use, and per-account category lists, land in the same
// place.
//
//   run:  node test/forms.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('cannot find function ' + name);
  let i = src.indexOf('{', start), depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// A <select> faithful to the one behaviour under test: assigning a value with no
// matching option deselects everything, and .value then reads ''. (HTML spec: "if
// no option has that value, set the selectedness of all options to false".)
function fakeSelect(optionValues = []) {
  const sel = {
    options: optionValues.map(v => ({ value: v, textContent: v })),
    _idx: optionValues.length ? 0 : -1,
    appendChild(o) { this.options.push(o); },
    get value() { return this._idx >= 0 && this.options[this._idx] ? this.options[this._idx].value : ''; },
    set value(v) { this._idx = this.options.findIndex(o => o.value === String(v)); },
    get innerHTML() { return this._html || ''; },
    set innerHTML(h) {
      this._html = h;
      // <option>Label</option> and <option value="x">Label</option>
      this.options = [...String(h).matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)<\/option>/g)]
        .map(m => ({ value: m[1] !== undefined ? m[1] : m[2], textContent: m[2] }));
      this._idx = this.options.length ? 0 : -1;
    }
  };
  return sel;
}
const fakeDocument = sel => ({
  getElementById: () => sel,
  createElement: () => ({ value: '', textContent: '' })
});

function build(sel, categories, bank = '') {
  return new Function('document', 'getCategories', 'currentExpBank', 'escHtml', `
    ${extract('selectValuePreserving')}
    ${extract('renderCategoryOptions')}
    return { selectValuePreserving, renderCategoryOptions };
  `)(fakeDocument(sel), () => categories.slice(), () => bank,
     s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'));
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}\n    got:      ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\nFORM ROUND-TRIPS (a save must not blank what it did not recognise)\n');

// --- the raw helper, against a fixed option list (exp-method / inv-pay-method) ---

test('an unknown stored value survives being loaded into a fixed select', () => {
  const sel = fakeSelect(['Credit Card', 'Debit Card', 'Cash', 'Check', 'ACH/Wire']);
  const api = build(sel, []);
  api.selectValuePreserving(sel, 'bank');   // what reconciliation writes
  eq(sel.value, 'bank', 'saving now would write "" over the record’s method');
});

test('the preserved option is labelled, not disguised as a normal choice', () => {
  const sel = fakeSelect(['Check', 'Card']);
  const api = build(sel, []);
  api.selectValuePreserving(sel, 'bank');
  const added = sel.options[sel.options.length - 1];
  eq(added.value, 'bank', 'the VALUE must be the stored string exactly — saves read it');
  ok(/not in the list/.test(added.textContent), 'the label should mark it as non-standard');
});

test('a known value selects normally and adds nothing', () => {
  const sel = fakeSelect(['Check', 'Card']);
  const api = build(sel, []);
  api.selectValuePreserving(sel, 'Card');
  eq(sel.value, 'Card');
  eq(sel.options.length, 2, 'no stray option appended for a value already present');
});

test('an empty value is left empty rather than invented', () => {
  const sel = fakeSelect(['', 'Check']);       // inv-pay-method has a real "—" option
  const api = build(sel, []);
  api.selectValuePreserving(sel, '');
  eq(sel.value, '', 'blank is a legitimate choice on that field');
  eq(sel.options.length, 2, 'nothing appended for a blank');
});

// --- the expense category picker, which rebuilds its own options ---

test('an expense keeps a category the current list no longer has', () => {
  // 'Prior-year refund' is written by reconciliation and is not a default category.
  const sel = fakeSelect();
  const api = build(sel, ['Advertising', 'Rent', 'Other']);
  api.renderCategoryOptions('Prior-year refund');
  eq(sel.value, 'Prior-year refund',
    'opening this expense and saving would have silently recategorised it');
});

test('switching Bank account does not recategorise the expense', () => {
  // onExpBankChange() re-renders with THAT account's list. The expense's own
  // category has to survive a list it isn't part of.
  const sel = fakeSelect();
  const accountList = ['Fuel', 'Parts'];
  const api = build(sel, accountList);
  sel.innerHTML = '<option>Rent</option>';
  sel.value = 'Rent';
  api.renderCategoryOptions();               // no argument — reads the live value
  eq(sel.value, 'Rent', 'the category changed underneath the user');
});

test('a brand-new expense still defaults to the first category', () => {
  const sel = fakeSelect();
  const api = build(sel, ['Advertising', 'Rent']);
  api.renderCategoryOptions('');
  eq(sel.value, 'Advertising', 'a new expense should land on a real category, not blank');
});

test('a category containing markup cannot break out of the option', () => {
  const sel = fakeSelect();
  const api = build(sel, ['Advertising']);
  api.renderCategoryOptions('<img src=x onerror=alert(1)>');
  const added = sel.options[sel.options.length - 1];
  eq(added.value, '<img src=x onerror=alert(1)>', 'the value is preserved verbatim');
  ok(!/<img/.test(sel.innerHTML), 'the raw tag must not reach innerHTML');
});


// ============================================================================
// The invoice form's FOLDS.
//
// The invoice editor asks for a lot, and almost none of it is the common case
// (a customer, a line, Save). Payment/status, customer expenses, mileage and
// notes are collapsed sections now — which is only safe under two rules:
//   1. Nothing is removed from the DOM. Every field keeps its value and
//      saveInvoice() reads exactly what it always did.
//   2. A collapsed fold STATES its contents in its header, so folding hides the
//      controls, never the facts. A summary that goes stale is the whole risk:
//      it would tell the owner an invoice is unpaid while it holds a payment.
// ============================================================================

// A fake element store keyed by id — enough for updateInvFolds(), which only
// reads .value / a select's selected option text and writes .textContent.
function foldDoc(fields) {
  const els = new Map();
  const mk = id => {
    const f = fields[id];
    if (f && f.options) {
      return { options: f.options.map(t => ({ text: t })), selectedIndex: f.selectedIndex, value: f.value || '' };
    }
    return { value: f == null ? '' : String(f), textContent: '' };
  };
  return {
    getElementById(id) {
      if (!els.has(id)) els.set(id, mk(id));
      return els.get(id);
    },
    _sum(key) { return this.getElementById('invfold-sum-' + key).textContent; },
  };
}
function runFolds(fields, expenses = []) {
  const doc = foldDoc(fields);
  new Function('document', 'fmt', 'editingInvExpenses', `
    ${extract('updateInvFolds')}
    updateInvFolds();
  `)(doc, v => '$' + Number(v).toFixed(2), expenses);
  return doc;
}
const paidFields = (over = {}) => Object.assign({
  'inv-status': { options: ['Draft', 'Sent', 'Paid', 'Overdue'], selectedIndex: 0 },
  'inv-amount-paid': '', 'inv-pay-method': '', 'inv-trips': '0',
  'inv-total-miles': '', 'inv-notes': '',
}, over);

test('a collapsed payment fold still says what was recorded', () => {
  const d = runFolds(paidFields({
    'inv-status': { options: ['Draft', 'Sent', 'Paid', 'Overdue'], selectedIndex: 2 },
    'inv-amount-paid': '300', 'inv-pay-method': 'Check',
  }));
  eq(d._sum('payment'), 'Paid · $300.00 Check');
});

test('an unpaid invoice says so rather than showing a blank fold', () => {
  const d = runFolds(paidFields());
  eq(d._sum('payment'), 'Draft · nothing recorded');
});

test('mileage and customer expenses summarise their own contents', () => {
  const d = runFolds(paidFields({ 'inv-trips': '2', 'inv-total-miles': '48.00' }),
    [{ amount: 40 }, { amount: 35 }]);
  eq(d._sum('mileage'), '2 trips · 48.00 mi');
  eq(d._sum('expenses'), '2 items · $75.00');
});

test('one trip and one item are not pluralised', () => {
  const d = runFolds(paidFields({ 'inv-trips': '1', 'inv-total-miles': '24.00' }), [{ amount: 40 }]);
  eq(d._sum('mileage'), '1 trip · 24.00 mi');
  eq(d._sum('expenses'), '1 item · $40.00');
});

test('empty sections read as None, never as an empty header', () => {
  const d = runFolds(paidFields());
  eq(d._sum('mileage'), 'None');
  eq(d._sum('expenses'), 'None');
  eq(d._sum('notes'), 'None');
});

test('a long note is previewed, not dumped into the header', () => {
  const long = 'Replaced the cameras at the pool park and re-ran the cable to the lift station';
  const d = runFolds(paidFields({ 'inv-notes': long }));
  ok(d._sum('notes').length <= 35, 'summary must stay on one line: ' + d._sum('notes'));
  ok(d._sum('notes').endsWith('…'), 'a truncated note should show it was truncated');
  ok(long.startsWith(d._sum('notes').slice(0, -1)), 'the preview must be the note itself');
});

test('folding moved the fields, it did not drop them', () => {
  // saveInvoice() reads each of these by id. A re-layout that loses one writes a
  // blank over real data with no error anywhere.
  const modal = src.slice(src.indexOf('id="modal-invoice"'), src.indexOf('id="save-inv-btn"'));
  for (const id of ['inv-id', 'inv-customer', 'inv-number', 'inv-date', 'inv-due', 'inv-status',
                    'inv-pay-method', 'inv-amount-paid', 'inv-paid-date', 'inv-recon-bank',
                    'inv-trips', 'inv-miles', 'inv-total-miles', 'inv-lines-wrap',
                    'inv-exp-wrap', 'inv-notes'])
    ok(modal.includes('id="' + id + '"'), 'the invoice form lost #' + id);
});

test('a fold body is hidden by CSS, so the values survive being collapsed', () => {
  ok(/\.form-fold-body\{display:none/.test(src), 'fold bodies must hide, not unmount');
  ok(/\.form-fold\.open .form-fold-body\{display:block/.test(src));
  ok(!/removeChild|innerHTML\s*=\s*''/.test(extract('toggleInvFold')),
    'toggleInvFold must not tear the fields out of the DOM');
});

test('every fold header has a summary slot and an aria-expanded state', () => {
  const modal = src.slice(src.indexOf('id="modal-invoice"'), src.indexOf('id="save-inv-btn"'));
  for (const key of ['payment', 'expenses', 'mileage', 'notes']) {
    ok(modal.includes('id="invfold-' + key + '"'), 'no fold container for ' + key);
    ok(modal.includes('id="invfold-sum-' + key + '"'), 'no summary slot for ' + key);
  }
  const heads = [...modal.matchAll(/class="form-fold-head"[^>]*/g)];
  eq(heads.length, 4, 'expected one header per fold');
  ok(heads.every(h => h[0].includes('aria-expanded')), 'a fold header must report its state');
  ok(/aria-expanded/.test(extract('toggleInvFold')), 'toggling must update aria-expanded');
});

test('openInvoiceModal opens a fold that already holds something', () => {
  // Otherwise editing a paid invoice would hide the payment behind a tap the user
  // has no reason to make.
  const fn = extract('openInvoiceModal');
  for (const key of ['payment', 'mileage', 'expenses', 'notes'])
    ok(fn.includes("toggleInvFold('" + key + "'"), 'openInvoiceModal never decides the ' + key + ' fold');
  ok(fn.includes('renderInvExpenses()'),
    'the billed-parts rows must be drawn on open, or an auto-opened fold shows an empty list');
  ok(fn.includes('updateInvFolds()'), 'the summaries must be painted before the modal shows');
});

test('every path that changes a summarised figure repaints the summaries', () => {
  for (const fn of ['calcInvMiles', 'markInvoicePaidFull', 'renderInvExpenses'])
    ok(extract(fn).includes('updateInvFolds()'), fn + ' can leave a fold summary stale');
  // The payment fields are plain inputs — they repaint from the markup.
  const modal = src.slice(src.indexOf('id="modal-invoice"'), src.indexOf('id="save-inv-btn"'));
  for (const id of ['inv-amount-paid', 'inv-status', 'inv-pay-method', 'inv-notes']) {
    const tag = modal.match(new RegExp('<(?:input|select|textarea)[^>]*id="' + id + '"[^>]*>'));
    ok(tag && /updateInvFolds\(\)/.test(tag[0]), id + ' can change a summary without repainting it');
  }
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
