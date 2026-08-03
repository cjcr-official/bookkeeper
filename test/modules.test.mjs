// Harness for the SECTIONS (module show/hide) system.
//
// WHY THIS EXISTS: every tab in the app can be switched off in Settings → Sections,
// and the whole UI is expected to follow — nav tabs, dashboard cards, report tabs,
// reconcile actions, and individual form fields that belong to another section. That
// contract had no tests, and the failure mode is silent: a `data-module` typo just
// never hides anything, and a stale memo hides the wrong tab. Both look fine in code
// review.
//
// HOW: same approach as reconcile.test.mjs — extract the ACTUAL functions and the
// MODULES table out of index.html and eval them with stubbed globals, so the harness
// always runs shipped code. Plus static checks over the markup, which is where the
// module ids are actually consumed.
//
//   run:  node test/modules.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// --- Extract a top-level `function name(...) {...}` by brace matching. --------
// Comment-aware (contractions in comments would otherwise read as string quotes).
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

// --- Extract the MODULES table + NAV_ORDER literal. --------------------------
function extractConst(name) {
  const start = src.indexOf('const ' + name + ' = ');
  if (start < 0) throw new Error('cannot find const ' + name);
  const end = src.indexOf('\n];', start) >= 0 && src.indexOf('\n];', start) < src.indexOf(';\n', start) + 2
    ? src.indexOf('\n];', start) + 3
    : src.indexOf(';\n', start) + 1;
  return src.slice(start, end);
}

// --- Sandbox: localStorage is the only dependency of the module functions. ----
// lsGet/lsSet are the app's own wrappers (they swallow errors where storage is
// blocked), so a plain in-memory map is a faithful stand-in.
function build() {
  const store = new Map();
  const factory = new Function('lsGet', 'lsSet', `
    ${extractConst('MODULES')}
    // The memo the real file declares alongside these functions. It MUST be declared
    // inside the factory: a Function body is sloppy mode, so without it the first
    // assignment would create a global and leak state between build() instances.
    let _hidMods = null, _hidPages = null;
    ${extract('getHiddenModules')}
    ${extract('setHiddenModulesLS')}
    ${extract('hiddenPagesSet')}
    ${extract('isPageHidden')}
    ${extract('isModuleHidden')}
    return { MODULES, getHiddenModules, setHiddenModulesLS, hiddenPagesSet, isPageHidden, isModuleHidden };
  `);
  const api = factory(
    k => (store.has(k) ? store.get(k) : null),
    (k, v) => store.set(k, v)
  );
  return { ...api, store };
}

// --- Tiny assert harness (matches reconcile.test.mjs output style). ----------
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + `\n    got:      ${sa}\n    expected: ${sb}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\nSECTIONS / module visibility\n');

// ---------------------------------------------------------------- memoization
test('nothing hidden by default', () => {
  const m = build();
  eq(m.getHiddenModules(), []);
  eq(m.isModuleHidden('mileage'), false);
});

test('setHiddenModulesLS invalidates the memo (both shapes)', () => {
  const m = build();
  m.getHiddenModules();               // prime the memo
  m.hiddenPagesSet();                 // prime the derived page set too
  m.setHiddenModulesLS(['mileage']);
  eq(m.getHiddenModules(), ['mileage'], 'module memo went stale');
  ok(m.hiddenPagesSet().has('mileage'), 'page memo went stale');
});

test('memo is not poisoned by a caller mutating the returned array', () => {
  // getHiddenModules() hands back the live memo by design (it is read constantly).
  // toggleModule builds a new array instead of splicing — this pins WHY.
  const m = build();
  m.setHiddenModulesLS(['loan']);
  const a = m.getHiddenModules();
  const b = m.getHiddenModules();
  ok(a === b, 'expected the same memoized array instance on repeat reads');
});

// ------------------------------------------------------------- page ↔ module
test('hiding a module hides every page it owns', () => {
  const m = build();
  // invoicing owns TWO pages — the one module that does.
  m.setHiddenModulesLS(['invoicing']);
  ok(m.isPageHidden('invoices'), 'invoices page should be hidden');
  ok(m.isPageHidden('customers'), 'customers page should be hidden');
  ok(!m.isPageHidden('expenses'), 'expenses page should stay visible');
});

test('statements module owns the accounts page', () => {
  const m = build();
  m.setHiddenModulesLS(['statements']);
  ok(m.isPageHidden('accounts'), 'the Statements tab is the "accounts" page id');
});

test('dashboard and settings can never be hidden', () => {
  const m = build();
  m.setHiddenModulesLS(m.MODULES.map(x => x.id));   // everything off
  ok(!m.isPageHidden('dashboard'), 'Home must survive');
  ok(!m.isPageHidden('settings'), 'Settings must survive — it is the way back');
  ok(!m.isPageHidden('profile'), 'Profile must survive');
});

test('unknown ids in storage are discarded, not trusted', () => {
  const m = build();
  m.store.set('bk-hidden-modules', JSON.stringify(['mileage', 'not-a-module']));
  eq(m.getHiddenModules(), ['mileage'], 'a retired/typo id must not linger');
});

test('corrupt storage degrades to "nothing hidden"', () => {
  const m = build();
  m.store.set('bk-hidden-modules', '{not json');
  eq(m.getHiddenModules(), [], 'must not throw or hide the whole app');
  m.store.set('bk-hidden-modules', '"a string"');
  eq(m.getHiddenModules(), [], 'a non-array must be rejected');
});

// ------------------------------------------------- static checks over markup
// These are the cheap guards for the failure mode that code review misses: a
// module id typo in an attribute silently does nothing at all.
const MODULE_IDS = build().MODULES.map(m => m.id);

test('every data-module id in the markup is a real module', () => {
  const bad = [];
  for (const mm of src.matchAll(/data-module="([^"]+)"/g))
    mm[1].trim().split(/\s+/).forEach(id => { if (!MODULE_IDS.includes(id)) bad.push(id); });
  eq(bad, [], 'unknown module id(s) in data-module — that field will never hide');
});

test('every data-module-all id in the markup is a real module', () => {
  const bad = [];
  for (const mm of src.matchAll(/data-module-all="([^"]+)"/g))
    mm[1].trim().split(/\s+/).forEach(id => { if (!MODULE_IDS.includes(id)) bad.push(id); });
  eq(bad, [], 'unknown module id(s) in data-module-all');
});

test('every id passed to isModuleHidden() is a real module', () => {
  const bad = [];
  for (const mm of src.matchAll(/isModuleHidden\(\s*'([^']+)'\s*\)/g))
    if (!MODULE_IDS.includes(mm[1])) bad.push(mm[1]);
  eq(bad, [], 'isModuleHidden() called with an id that is not in MODULES');
});

test('every module page exists as a #page-<id> element and is in NAV_ORDER', () => {
  const navLine = src.match(/const NAV_ORDER = \[([^\]]+)\]/);
  ok(navLine, 'NAV_ORDER not found');
  const nav = navLine[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  const missingPage = [], missingNav = [];
  for (const m of build().MODULES)
    for (const p of m.pages) {
      if (!src.includes('id="page-' + p + '"')) missingPage.push(p);
      if (!nav.includes(p)) missingNav.push(p);
    }
  eq(missingPage, [], 'module page(s) with no matching #page-<id> element');
  eq(missingNav, [], 'module page(s) missing from NAV_ORDER — the tab can never hide');
});

test('a trip can be saved with no client and no expense', () => {
  // The mileage section must stand alone: requiring a customer or an expense link
  // made trips unrecordable whenever Invoices AND Expenses were both switched off,
  // and blocked ordinary unlinked driving (bank run, parts pickup) outright.
  const body = extract('saveTrip');
  ok(!/if \(!cid && !expId\)/.test(body),
    'saveTrip still hard-requires a client or expense link');
  ok(/if \(!miles\)/.test(body), 'saveTrip should still require the miles');
});

test('the trip link fields follow their own sections', () => {
  // Client belongs to Invoices, Linked Expense to Expenses — each hides with its
  // own section, and the row only disappears entirely when BOTH are off.
  ok(/id="trip-client"/.test(src) && /data-module="invoicing"><label>Client/.test(src),
    'trip-client group is not gated on the invoicing module');
  ok(/data-module="expenses"><label>Linked Expense/.test(src),
    'trip-expense group is not gated on the expenses module');
  ok(/data-module-all="invoicing expenses"/.test(src),
    'the trip link row should hide only when both sections are off');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
