// Recurring auto-posting — the one path that writes financial records unattended.
//
// WHY THIS EXISTS: processRecurring() runs on every launch and catches up every
// missed period, inserting real expenses, draft invoices and (v514) mileage-log
// trips. genOneRecurring() used
// to swallow a failed insert and return normally, and the caller advanced next_date
// regardless — so a failed insert skipped that occurrence PERMANENTLY. The expense
// never existed, the schedule had moved past it, and the toast counted it as
// generated. Nothing anywhere said otherwise.
//
// The three properties pinned here pull against each other, which is why they need
// a test rather than a careful read:
//   • a failed insert must NOT advance past that occurrence (no silent loss)
//   • whatever DID insert must be stamped (no duplicates on the next launch)
//   • a throw must not escape (all three login paths await this immediately before
//     hiding the loading screen, with no catch — an escape strands the app there)
//
//   run:  node test/recurring.test.mjs
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

// The kind → section table, lifted whole so the gates below are the shipped ones.
function extractConst(name) {
  const start = src.indexOf('const ' + name + ' = ');
  if (start < 0) throw new Error('cannot find const ' + name);
  return src.slice(start, src.indexOf(';\n', start) + 1);
}

// Build a sandbox around the SHIPPED functions. `failOn` makes the Nth insert fail,
// the way a dropped connection mid-catch-up does. `hidden` is the Sections set — a
// switched-off section must not keep generating records behind the user's back.
function build({ recurring, failOn = 0, todayStr = '2026-04-15', hidden = [], customers = [] }) {
  const inserted = [], updates = [], toasts = [];
  let inserts = 0;
  const sb = {
    from: table => ({
      insert: row => ({ select: () => ({ single: async () => {
        inserts++;
        if (inserts === failOn) return { error: { message: 'network' }, data: null };
        inserted.push({ ...row, _table: table });
        return { error: null, data: { ...row, id: 'row' + inserts } };
      } }) }),
      update: patch => ({ eq: async (_c, id) => { updates.push({ id, ...patch }); return { error: null }; } })
    })
  };
  const logged = [];
  const factory = new Function(
    'sb', 'cache', 'profile', 'currentUser', 'today', 'isModuleHidden', 'showToast', 'console', 'parseDate',
    `const nextInvoiceNumber = () => '2601';
     ${extractConst('RECUR_KINDS')}
     ${extract('recurMeta')}
     ${extract('recurHidden')}
     ${extract('advanceDate')}
     ${'async ' + extract('genOneRecurring')}
     ${'async ' + extract('processRecurring')}
     return { processRecurring };`
  );
  const cache = { recurring, expenses: [], invoices: [], customers, trips: [] };
  const api = factory(
    sb, cache, { tax: 0 }, { id: 'u1' },
    () => todayStr, id => hidden.includes(id),
    (m, k) => toasts.push({ m, k }),
    { error: (...a) => logged.push(a.join(' ')) },   // keep the suite's output readable
    d => (d ? new Date(d + 'T12:00:00') : new Date(NaN))
  );
  return { ...api, cache, inserted, updates, toasts, logged };
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { return fn(); } catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
async function atest(name, fn) {
  try { await fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'not equal'}\n    got:      ${JSON.stringify(a)}\n    expected: ${JSON.stringify(b)}`);
  }
}

console.log('\nRECURRING auto-posting\n');

// A monthly expense behind since January, with "today" 2026-04-15 — so Jan 10,
// Feb 10, Mar 10 and Apr 10 are all due.
const threeBehind = () => ([{
  id: 'r1', active: true, kind: 'expense', frequency: 'monthly',
  next_date: '2026-01-10', data: { vendor: 'Rent', amount: 900 }
}]);

await atest('a clean catch-up generates every missed period and stamps the schedule', async () => {
  const h = build({ recurring: threeBehind() });
  const n = await h.processRecurring();
  eq(n, 4, 'Jan, Feb, Mar and Apr are all on or before 2026-04-15');
  eq(h.inserted.map(r => r.date), ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10'], 'one expense per period');
  eq(h.updates.length, 1, 'the schedule is stamped once');
  eq(h.updates[0].next_date, '2026-05-10', 'stamped past everything generated');
});

await atest('a failed insert does not silently skip that occurrence', async () => {
  // Third insert fails. Jan and Feb are real; March must NOT be stamped past.
  const h = build({ recurring: threeBehind(), failOn: 3 });
  await h.processRecurring();
  eq(h.inserted.map(r => r.date), ['2026-01-10', '2026-02-10'], 'only the two that worked were written');
  eq(h.updates[0].next_date, '2026-03-10',
    'next_date must still point AT the failed occurrence — advancing past it loses '
    + 'that expense forever, with the toast reporting success');
});

await atest('the periods that did generate are stamped, so a retry cannot duplicate them', async () => {
  const h = build({ recurring: threeBehind(), failOn: 3 });
  await h.processRecurring();
  ok(h.updates.length === 1, 'progress is persisted even though the run threw');
  // Re-run from the stamped position: it resumes AT the failed period. The months
  // that already posted must not come round again — a duplicate auto-posted expense
  // is one the owner has to notice and delete by hand.
  const h2 = build({ recurring: [{ ...threeBehind()[0], next_date: h.updates[0].next_date }] });
  await h2.processRecurring();
  const dates = h2.inserted.map(r => r.date);
  ok(!dates.includes('2026-01-10') && !dates.includes('2026-02-10'),
    'Jan/Feb were written a second time: ' + dates.join(', '));
  ok(dates[0] === '2026-03-10', 'the retry resumes at the period that failed');
});

await atest('a failure is reported, never counted as a success', async () => {
  const h = build({ recurring: threeBehind(), failOn: 3 });
  await h.processRecurring();
  ok(h.toasts.some(t => t.k === 'error'), 'the user is told something did not generate');
});

await atest('a throw never escapes into the boot sequence', async () => {
  // All three login paths await this right before hiding the loading screen with no
  // catch of their own, so an escaping rejection strands the app on the spinner.
  const h = build({ recurring: threeBehind(), failOn: 1 });
  let threw = false;
  try { await h.processRecurring(); } catch (e) { threw = true; }
  ok(!threw, 'processRecurring rejected — boot would hang on the loading screen');
});

await atest('one broken template does not block the others', async () => {
  const h = build({ recurring: [
    { id: 'bad', active: true, kind: 'expense', frequency: 'monthly', next_date: '2026-04-10', data: { vendor: 'A', amount: 1 } },
    { id: 'good', active: true, kind: 'expense', frequency: 'monthly', next_date: '2026-04-11', data: { vendor: 'B', amount: 2 } }
  ], failOn: 1 });
  await h.processRecurring();
  eq(h.inserted.map(r => r.vendor), ['B'], 'the second template still ran');
  eq(h.updates.map(u => u.id), ['good'], 'the failed template is not stamped past its occurrence');
});

// ---------------------------------------------------------------- trips (v514)
// A trip made on a schedule rides the SAME table and the same catch-up engine, so
// everything above already covers its failure modes. What is new — and what a
// two-way `kind==='invoice' ? … : …` ternary gets wrong in a way nothing surfaces —
// is that it must write a TRIP, into the Mileage section's books, and stop when
// Mileage is switched off.
const weeklyRun = () => ([{
  id: 't1', active: true, kind: 'trip', frequency: 'weekly',
  next_date: '2026-04-01', data: { customer_id: 'c1', miles: 12.5, trips: 2, purpose: 'Bank run' }
}]);

await atest('a recurring trip logs real trips, not expenses', async () => {
  const h = build({ recurring: weeklyRun(), customers: [{ id: 'c1', name: 'Acme' }] });
  const n = await h.processRecurring();
  eq(n, 3, 'Apr 1, 8 and 15 are all on or before 2026-04-15');
  eq(h.inserted.map(r => r._table), ['trips', 'trips', 'trips'], 'a trip must not post as an expense');
  eq(h.inserted.map(r => r.date), ['2026-04-01', '2026-04-08', '2026-04-15'], 'one trip per period');
  eq(h.updates[0].next_date, '2026-04-22', 'stamped past everything generated');
});

await atest('the generated row is the one saveTrip() writes', async () => {
  // Anything else and the mileage log, the year total and the reports each read a
  // hand-logged trip and a generated one differently.
  const h = build({ recurring: weeklyRun(), customers: [{ id: 'c1', name: 'Acme' }] });
  await h.processRecurring();
  const t = h.inserted[0];
  eq(t.miles, 12.5, 'miles per round trip');
  eq(t.trips, 2, 'round trips');
  eq(t.total_miles, 25, 'total_miles = miles × trips — this is the figure every total sums');
  eq(t.customer_id, 'c1');
  eq(t.client_name, 'Acme', 'the client name is denormalised onto the row, as saveTrip does');
  eq(t.purpose, 'Bank run');
  eq(h.cache.trips.length, 3, 'the new trips land in the cache, so the log shows them without a reload');
});

await atest('a trip with no client is still a complete record', async () => {
  // Mileage stands alone: a bank run needs no customer, and Invoices may be off.
  const h = build({ recurring: [{ ...weeklyRun()[0], data: { miles: 8, trips: 1, purpose: 'Parts pickup' } }] });
  await h.processRecurring();
  eq(h.inserted[0].customer_id, null);
  eq(h.inserted[0].client_name, '');
  eq(h.inserted[0].total_miles, 8);
});

await atest('a customer deleted since the schedule was made does not strand it', async () => {
  // The client link is the optional half; the miles are the record the deduction
  // rests on. A dangling customer_id would throw on the insert (FK) and, because
  // next_date never advances past a failure, retry forever — a schedule permanently
  // stuck on a customer who no longer exists.
  const h = build({ recurring: weeklyRun(), customers: [{ id: 'c2', name: 'Someone else' }] });
  await h.processRecurring();
  eq(h.inserted[0].customer_id, null, 'the dead link should be dropped');
  eq(h.inserted[0].total_miles, 25, 'the miles are still logged');
});

await atest('an empty customer list does not unlink a live customer', async () => {
  // safe() hands out [] when a table will not load. "Not in the list" then means
  // "the list is missing", not "the customer was deleted" — unlinking there would
  // silently drop a real link on every trip generated during the outage.
  const h = build({ recurring: weeklyRun(), customers: [] });
  await h.processRecurring();
  eq(h.inserted[0].customer_id, 'c1', 'the link should be passed through untouched');
});

await atest('switching Mileage off stops recurring trips — and never skips them', async () => {
  const h = build({ recurring: weeklyRun(), hidden: ['mileage'] });
  eq(await h.processRecurring(), 0, 'nothing may be generated into a hidden section');
  eq(h.inserted, [], 'no trip was written');
  eq(h.updates, [], 'next_date must NOT advance — turning Mileage back on catches up');
});

await atest('a recurring trip is not gated by Expenses or Invoices', async () => {
  // The old two-way ternary filed every non-invoice kind under Expenses, so a trip
  // would have stopped generating for a section it has nothing to do with — and gone
  // on generating with its own section switched off.
  const h = build({ recurring: weeklyRun(), hidden: ['expenses', 'invoicing'] });
  ok(await h.processRecurring() > 0, 'trips stopped because a different section is off');
});

await atest('one hidden section does not stop the kinds that are still on', async () => {
  const h = build({ recurring: [
    { id: 'e1', active: true, kind: 'expense', frequency: 'monthly', next_date: '2026-04-10', data: { vendor: 'Rent', amount: 900 } },
    weeklyRun()[0]
  ], hidden: ['mileage'] });
  await h.processRecurring();
  eq(h.inserted.map(r => r._table), ['expenses'], 'the expense should still post');
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
