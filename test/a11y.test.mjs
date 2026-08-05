// Tappable divs stay operable as the app redraws itself.
//
// WHY THIS EXISTS: this app is built out of onclick <div>s — list rows, cards,
// filter tabs, notification rows. enhanceA11y() is what makes them real controls
// (role=button + tabindex, which the global keydown handler turns into Enter/Space
// activation). It ran over the static shell once, and after that ONLY through
// rerenderCurrentView() — page navigation and rotation. Everything a renderer
// redrew in place came back bare:
//
//   • typing in the invoice or expense search re-renders that list on every keystroke
//   • changing a filter, the year scope, or a status tab re-renders it
//   • saving or deleting a record re-renders it
//   • the notification centre draws its own rows into a modal — those had NEVER
//     been keyboard-reachable, on any path
//
// v497 fixed Home and the calendar by adding a call to each renderer. That is the
// fix that has to be remembered every time, and it was already missed in a dozen
// places, so the sweep now runs off a MutationObserver: inserted elements get
// enhanced, whoever drew them.
//
// Two things are load-bearing and easy to get subtly wrong, so they're tested
// against the SHIPPED enhanceA11y over a small fake DOM:
//   1. the ROOT node itself must be considered — a row inserted by
//      `list.innerHTML = rows.map(...)` IS the onclick div, not a parent of one
//   2. a container holding a real control must still be skipped (no nested buttons)
//
//   run:  node test/a11y.test.mjs
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
const code = name => extract(name).replace(/^\s*\/\/.*$/gm, '');

// --- A fake element tree, just rich enough for enhanceA11y. ------------------
// Only the handful of DOM calls it makes: matches, querySelector(All), tagName,
// has/setAttribute. Selectors are matched by the two shapes the function asks for.
function el(tag, opts = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    attrs: { ...(opts.attrs || {}) },
    children: opts.children || [],
    hasAttribute(a) { return this.attrs[a] !== undefined; },
    setAttribute(a, v) { this.attrs[a] = String(v); },
    getAttribute(a) { return this.attrs[a]; },
    descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); },
    matches(sel) { return matchSel(this, sel); },
    querySelectorAll(sel) { return this.descendants().filter(n => matchSel(n, sel)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  return node;
}
function matchSel(n, sel) {
  // enhanceA11y asks for exactly these: '[onclick]', 'label:not([for])',
  // and the nested-control list 'button,a,input,select,textarea,[role="button"]'.
  return sel.split(',').map(s => s.trim()).some(s => {
    if (s === '[onclick]') return n.hasAttribute('onclick');
    if (s === 'label:not([for])') return n.tagName === 'LABEL' && !n.hasAttribute('for');
    if (s === '[role="button"]') return n.getAttribute('role') === 'button';
    if (/^input:not/.test(s)) return n.tagName === 'INPUT' && n.attrs.type !== 'hidden';
    return n.tagName === s.toUpperCase();
  });
}

function enhancer() {
  const factory = new Function(`
    let _a11yUid = 0;
    ${extract('enhanceA11y')}
    return enhanceA11y;
  `);
  return factory();
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const enhanceA11y = enhancer();

console.log('\n── a redrawn row is a real control ──\n');

test('an inserted row that IS the onclick div gets wired', () => {
  // `el.innerHTML = list.map(i => '<div class="m-card" onclick=…>')` inserts the
  // rows themselves — the observer hands each one to enhanceA11y as the root.
  const row = el('div', { attrs: { onclick: "editInvoice('x')" },
                          children: [el('div', { attrs: {} })] });
  enhanceA11y(row);
  eq(row.getAttribute('role'), 'button', 'the row is the control');
  eq(row.getAttribute('tabindex'), '0', 'and it takes focus');
});

test('descendants are still wired when the root is a container', () => {
  const child = el('div', { attrs: { onclick: 'foo()' } });
  const list = el('div', { attrs: { id: 'invoices-table' }, children: [child] });
  enhanceA11y(list);
  eq(child.getAttribute('role'), 'button');
  eq(list.getAttribute('role'), undefined, 'the plain container is not a control');
});

test('a row holding a real button is left alone (no nested controls)', () => {
  const row = el('div', { attrs: { onclick: 'openRow()' }, children: [el('button')] });
  enhanceA11y(row);
  eq(row.getAttribute('role'), undefined,
     'wiring it would bury the inner button inside a button');
});

test('a heading inside does NOT disqualify a fold header', () => {
  const header = el('div', { attrs: { onclick: 'toggleDashCard()' }, children: [el('h3')] });
  enhanceA11y(header);
  eq(header.getAttribute('role'), 'button', 'the <h3> becomes its accessible name');
});

test('native controls and already-wired elements are untouched', () => {
  const btn = el('button', { attrs: { onclick: 'x()' } });
  const already = el('div', { attrs: { onclick: 'x()', role: 'switch' } });
  enhanceA11y(btn); enhanceA11y(already);
  eq(btn.getAttribute('role'), undefined, 'a <button> needs nothing');
  eq(already.getAttribute('role'), 'switch', 'an explicit role is not overwritten');
});

test('running twice changes nothing (the observer may re-sweep)', () => {
  const row = el('div', { attrs: { onclick: 'x()' } });
  enhanceA11y(row); const first = { ...row.attrs };
  enhanceA11y(row);
  eq(JSON.stringify(row.attrs), JSON.stringify(first), 'idempotent');
});

console.log('\n── the sweep follows every redraw, not just navigation ──\n');

test('a MutationObserver enhances whatever gets inserted', () => {
  const script = src.slice(src.indexOf('<script>', src.indexOf('</style>')))
    .replace(/^\s*\/\/.*$/gm, '');
  ok(/new MutationObserver\(/.test(script), 'nothing watches for inserted nodes');
  const obs = script.slice(script.indexOf('new MutationObserver('));
  ok(/addedNodes/.test(obs), 'it must react to inserted nodes');
  ok(/enhanceA11y\(/.test(obs.slice(0, 900)), 'and hand them to enhanceA11y');
  ok(/observe\(document\.body,\s*\{[^}]*childList:\s*true[^}]*subtree:\s*true/.test(obs),
     'it has to watch the whole body subtree, or a modal’s rows are missed');
  ok(!/attributes:\s*true/.test(obs.slice(0, 900)),
     'watching attributes would make enhanceA11y re-trigger itself');
});

test('enhanceA11y considers the root, not only its descendants', () => {
  const body = code('enhanceA11y');
  ok(/root\.matches/.test(body),
     'without a root check, every list ROW inserted by innerHTML is skipped');
});

console.log('\n── deleting an expense takes its receipt with it ──\n');

// Not a11y, but the same shape of bug: a cleanup step that exists in one path and
// was never copied to the siblings. The row is the only reference to the file, so
// what's left behind is unreachable AND still counted against the storage quota.
test('every path that deletes an expense removes its receipt', () => {
  const paths = ['deleteExpense', 'deleteInvoice', 'bulkDelete', 'syncInvoiceExpenses'];
  for (const fn of paths) {
    const body = code(fn);
    if (!/from\('expenses'\)\.delete\(\)/.test(body)) throw new Error(fn + ' no longer deletes expenses — update this test');
    ok(/removeReceipts\(/.test(body), fn + ' deletes an expense row but leaves its receipt in storage');
  }
});

test('the receipt removal lives in one helper, not four copies', () => {
  const body = code('removeReceipts');
  ok(/receipt_path/.test(body) && /storage\.from\('receipts'\)\.remove\(/.test(body),
     'removeReceipts must map rows to paths and delete them');
  const inline = (src.replace(/^\s*\/\/.*$/gm, '').match(/storage\.from\('receipts'\)\.remove\(/g) || []).length;
  eq(inline, 1, 'only removeReceipts should call storage remove for receipts');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
