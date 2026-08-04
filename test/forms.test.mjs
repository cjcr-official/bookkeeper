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

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
