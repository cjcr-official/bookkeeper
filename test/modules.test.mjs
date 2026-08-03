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

// --- Sandbox for buildNotifications() ----------------------------------------
// The bell feed is derived from `cache`, so it is the one place a switched-off
// section can still put a row in front of the user (and badge the app icon with
// it). Runs the SHIPPED function over the real module gates; everything else it
// touches — formatting, status helpers — is stubbed to something inert.
function buildNotifSandbox(hidden, cache) {
  const store = new Map([['bk-hidden-modules', JSON.stringify(hidden)]]);
  const factory = new Function('lsGet', 'lsSet', 'cache', `
    ${extractConst('MODULES')}
    let _hidMods = null, _hidPages = null;
    ${extract('getHiddenModules')}
    ${extract('setHiddenModulesLS')}
    ${extract('isModuleHidden')}
    const NOTIF_SOON_DAYS = 3;
    const today = () => new Date().toISOString().slice(0,10);
    ${extract('_daysAhead')}
    const effectiveStatus = i => i.status;
    const balanceDue = i => i.total || 0;
    const fmt = v => '$' + v;
    const fmtDate = d => d;
    const fmtTime = t => t;
    ${extract('buildNotifications')}
    return buildNotifications();
  `);
  return factory(k => (store.has(k) ? store.get(k) : null), () => {}, cache);
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

// --------------------------------------------------- a module with no nav page
test('jobs is a module and owns no nav page', () => {
  // Jobs & Calendar lives on Home, so it has no tab to hide — every gate is a
  // data-module attribute or an isModuleHidden('jobs') check. Hiding it must not
  // take any OTHER page down with it.
  const m = build();
  const jobs = m.MODULES.find(x => x.id === 'jobs');
  ok(jobs, 'jobs module missing from MODULES');
  eq(jobs.pages, [], 'jobs should own no nav page');
  m.setHiddenModulesLS(['jobs']);
  eq([...m.hiddenPagesSet()], [], 'hiding a page-less module must hide no pages');
  ok(m.isModuleHidden('jobs'));
});

// ----------------------------------------------- the notification feed follows
const _d = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const NOTIF_FIXTURE = {
  invoices: [{ id:'i1', status:'sent', due:_d(-2), total:100, customer_name:'Acme' }],
  jobs:     [{ id:'j1', date:_d(1), title:'On-site', done:false }],
  customers:[],
  recurring:[{ id:'r1', active:true, next_date:_d(1), kind:'invoice', label:'Monthly retainer', data:{} },
             { id:'r2', active:true, next_date:_d(1), kind:'expense', label:'Web hosting', data:{} }],
};
const notifIds = hidden => buildNotifSandbox(hidden, NOTIF_FIXTURE).map(n => n.id.replace(/-.*/, ''));

test('nothing hidden → every source shows up in the bell', () => {
  const kinds = new Set(notifIds([]));
  ok(kinds.has('inv'), 'expected an invoice notification');
  ok(kinds.has('job'), 'expected a job notification');
  ok(kinds.has('rec'), 'expected recurring notifications');
});

test('a switched-off section puts nothing in the bell', () => {
  // The badge also drives the Home Screen app-icon badge, so a leak here is a red
  // dot for a tab that no longer exists — and a row that opens a hidden page.
  ok(!notifIds(['invoicing']).includes('inv'), 'invoice notifications survived Invoices being off');
  ok(!notifIds(['jobs']).includes('job'), 'job notifications survived Jobs being off');
});

test('recurring notifications follow the section that owns each kind', () => {
  const withInvOff = buildNotifSandbox(['invoicing'], NOTIF_FIXTURE).filter(n => n.id.startsWith('rec-'));
  eq(withInvOff.map(n => n.id.split('-')[1]), ['r2'], 'the recurring INVOICE should be gone, the expense kept');
  const withExpOff = buildNotifSandbox(['expenses'], NOTIF_FIXTURE).filter(n => n.id.startsWith('rec-'));
  eq(withExpOff.map(n => n.id.split('-')[1]), ['r1'], 'the recurring EXPENSE should be gone, the invoice kept');
});

test('everything off → an empty bell, not a crash', () => {
  eq(buildNotifSandbox(build().MODULES.map(m => m.id), NOTIF_FIXTURE), []);
});

// ------------------------------------------- generated records follow sections
test('processRecurring skips kinds whose section is off', () => {
  // Otherwise a hidden section keeps filling up behind the user's back: expenses
  // auto-post and draft invoices pile up where nobody can see them.
  const body = extract('processRecurring');
  ok(/rec\.kind==='invoice' \? hidInv : hidExp/.test(body),
    'processRecurring still generates for switched-off sections');
});

// --------------------------------------------- shared surfaces + settings gates
test('Home\'s calendar surfaces linger while ANY of their sources is on', () => {
  // Events come from Jobs, but the same cards also carry invoice due dates,
  // recurring runs, budget bills and loan payments — so they use data-module-all.
  // Each card must list EXACTLY what it draws from: renderUpcoming has no budget-bill
  // rows, so tagging it with `budget` would leave a permanently-empty Upcoming card
  // on Home for someone running Budget on its own.
  const want = {
    'dash-grp-cal':  'jobs invoicing expenses budget loan',   // header over both cards
    'dash-card-up':  'jobs invoicing expenses loan',          // renderUpcoming's sources
    'dash-card-cal': 'jobs invoicing expenses budget loan',   // calItemsByDate's sources
  };
  for (const [id, list] of Object.entries(want)) {
    const tag = src.match(new RegExp('<div[^>]*id="' + id + '"[^>]*>'));
    ok(tag, id + ' not found');
    ok(tag[0].includes('data-module-all="' + list + '"'),
      id + ' should hide only when every section it draws from is off (expected: ' + list + ')');
  }
  // The two renderers back that up: only the calendar reads budget bills.
  ok(/isModuleHidden\('budget'\)/.test(extract('calItemsByDate')), 'calendar should draw budget bills');
  ok(!/isModuleHidden\('budget'\)/.test(extract('renderUpcoming')), 'Upcoming has no budget rows to gate');
});

test('a topbar action never writes into a switched-off section', () => {
  // "Rebuild" on the Mileage tab overwrites mileage on EVERY invoice and recreates
  // their trips — a destructive bulk write into Invoices, offered from a different
  // tab. Logging a trip needs nothing but Mileage, so only Rebuild is gated.
  const body = extract('showPage');
  ok(/mileage:\(isModuleHidden\('invoicing'\)\?''/.test(body),
    'the Mileage tab still offers Rebuild with Invoices switched off');
  ok(/openTripModal\(\)/.test(body), 'Log Trip must survive — Mileage stands alone');
});

test('a hidden card does not keep calling out to the network', () => {
  // The Tax card is data-module="invoicing" and openTaxModal() is only reachable
  // from it, so with Invoices off every dashboard render was posting to
  // /tax-estimate (which proxies PolicyEngine) for a card nobody can see.
  const body = extract('renderTaxCard');
  ok(/isModuleHidden\('invoicing'\)/.test(body), 'renderTaxCard still fetches with Invoices off');
  ok(body.indexOf("isModuleHidden('invoicing')") < body.indexOf('ensureLiveTax()'),
    'the gate must come before the fetch');
});

test('a section that is off costs nothing at launch', () => {
  // ensurePlaidBanks() runs fire-and-forget from loadAllData on every launch. With
  // Statements off every picker it feeds is hidden, so the round trip is pure waste
  // — and it must NOT memoize the empty result, or switching Statements back on
  // mid-session could never fetch for real.
  const body = extract('ensurePlaidBanks');
  ok(/isModuleHidden\('statements'\)/.test(body), 'ensurePlaidBanks still fetches with Statements off');
  const gate = body.indexOf("isModuleHidden('statements')");
  ok(gate >= 0 && gate < body.indexOf('if (_plaidBanksPromise)'),
    'the gate must come before the promise memo, or the empty result gets cached');
});

test('the Notifications panel follows everything that can push', () => {
  // Push only fires for recurring items (Invoices/Expenses) and events (Jobs).
  const tag = 'data-module-all="invoicing expenses jobs"';
  eq((src.match(new RegExp(tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2,
    'the Notifications nav button and panel should both be tagged');
  ok(/data-module-all="invoicing expenses">\s*<span><span class="setting-row-title">Morning reminder time/.test(src),
    'the morning-reminder row configures recurring items only — gate it on those');
});

test('the "new event" buttons follow Jobs alone', () => {
  const btns = [...src.matchAll(/<button[^>]*openJobModal\(\)[^>]*>/g)].map(m => m[0]);
  eq(btns.length, 2, 'expected the Upcoming + calendar "new event" buttons');
  btns.forEach(b => ok(/data-module="jobs"/.test(b), 'a "new event" button is not gated on jobs'));
});

test('Settings panels that configure one section follow it', () => {
  ok(/data-sec="invoice" data-module="invoicing"/.test(src), 'Invoice Defaults panel not gated');
  ok(/data-sec="categories" data-module="expenses"/.test(src), 'Expense Categories panel not gated');
  // Both the nav button and the panel carry the tag, so neither is left orphaned.
  eq((src.match(/data-sec="invoice"/g) || []).length, 2, 'nav button + panel should both be tagged');
  eq((src.match(/data-sec="categories"/g) || []).length, 2, 'nav button + panel should both be tagged');
});

test('customer expenses on an invoice follow the Expenses section', () => {
  // They are written into the expenses ledger — but hidden only, so an existing
  // invoice keeps its links (openInvoiceModal fills it, saveInvoice writes it).
  ok(/data-module="expenses">\s*<label[^>]*>Customer Expenses/.test(src),
    'the invoice editor\'s Customer Expenses block is not gated on the expenses module');
  ok(/id="inv-exp-wrap"/.test(src) && /function saveInvoice/.test(src));
});

test('Home explains itself when every section is off', () => {
  ok(/id="dash-all-off"/.test(src), 'no all-sections-off empty state on Home');
  ok(/MODULES\.every\(m => hid\.includes\(m\.id\)\)/.test(extract('applyModuleVisibility')),
    'applyModuleVisibility does not toggle the all-off empty state');
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
