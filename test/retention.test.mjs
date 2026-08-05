// Account deletion must actually delete everything.
//
// WHY THIS EXISTS: deleteAccount() (worker/push-cron.js) removes the user's rows
// table by table, from a hard-coded list. Adding a feature adds a table — and
// nothing connected that list to the rest of the app, so the list silently fell
// behind. time_entries (the Time Clock) and loans (the Loan tab, with balances and
// payment history) were both missing: deleting the account removed the login, so
// those rows became unreachable via RLS but were never deleted, and sat in the
// database indefinitely. data-retention-policy.html promises the opposite.
//
// The failure is invisible in code review — the list LOOKS thorough — and invisible
// at runtime, because the deletion "succeeds". So pin it to a source of truth that
// changes whenever a table is added: the client's own `cache` object, which names
// every user-owned table the app reads or writes.
//
//   run:  node test/retention.test.mjs
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const client = readFileSync(join(root, 'index.html'), 'utf8');
const worker = readFileSync(join(root, 'worker', 'push-cron.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function test(name, fn) {
  try { fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; fails.push(name); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

console.log('\nACCOUNT DELETION / data retention\n');

// Every key of the client's `cache` is a table name it loads for the signed-in
// user. That is the list account deletion has to keep up with.
function cacheTables() {
  const m = /let cache = \{([^}]*)\}/.exec(client);
  ok(m, 'could not find the cache literal in index.html');
  return [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(x => x[1]);
}
// The table list inside deleteAccount's `for (const t of [...])`.
function deletedTables() {
  const start = worker.indexOf('async function deleteAccount(');
  ok(start >= 0, 'could not find deleteAccount in the worker');
  const body = worker.slice(start, worker.indexOf('\n}', start));
  const m = /for \(const t of \[([^\]]*)\]\)/.exec(body);
  ok(m, "could not find deleteAccount's table list");
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

test('every table the client loads is deleted with the account', () => {
  const missing = cacheTables().filter(t => !deletedTables().includes(t));
  ok(missing.length === 0,
    'deleteAccount never deletes: ' + missing.join(', ')
    + '\n    Rows survive the login being removed — unreachable, but retained,'
    + '\n    which contradicts data-retention-policy.html.');
});

test('deletion still runs children before parents', () => {
  const list = deletedTables();
  const before = (a, b) => list.indexOf(a) >= 0 && list.indexOf(b) >= 0 && list.indexOf(a) < list.indexOf(b);
  // FK targets must be deleted last or the delete is refused.
  ok(before('trips', 'invoices'), 'trips references invoices');
  ok(before('trips', 'expenses'), 'trips references expenses');
  ok(before('expenses', 'invoices'), 'expenses.invoice_id references invoices');
  ok(before('jobs', 'customers'), 'jobs.customer_id references customers');
  ok(before('owner_transactions', 'accounts'), 'owner_transactions.account_id references accounts');
});

test('the profile row and the login are removed too', () => {
  const start = worker.indexOf('async function deleteAccount(');
  const body = worker.slice(start, worker.indexOf('\n}', start));
  ok(/profiles\?id=eq\./.test(body), 'the profiles row is left behind');
  ok(/auth\/v1\/admin\/users\//.test(body), 'the auth login is left behind');
  ok(/plaid_items\?user_id=eq\./.test(body), 'the stored bank tokens are left behind');
});

// The same "hand-kept copy of the table list" failure, one function over: doLogout
// rebuilt `cache` from a SECOND literal, and that one never got `loans` — so a
// signed-out session carried cache.loans === undefined until the next login refilled
// it. Clearing by key can't drift.
test('signing out clears every cached table, without a second list', () => {
  const start = client.indexOf('async function doLogout(');
  ok(start >= 0, 'could not find doLogout');
  const body = client.slice(start, client.indexOf('\n}', start));
  ok(!/cache\s*=\s*\{[^}]*:/.test(body),
     'doLogout retypes the table list — it will fall behind the real one again');
  ok(/Object\.keys\(cache\)/.test(body), 'clear every key of the one cache literal');
});

test('private-bucket wipe pages past the 1000-object list cap', () => {
  const start = worker.indexOf('async function deleteUserStorage(');
  ok(start >= 0, 'could not find deleteUserStorage');
  const body = worker.slice(start, worker.indexOf('\n}', start));
  ok(/for \(|while \(/.test(body),
    'deleteUserStorage lists once — receipts past the first 1000 stay in the bucket');
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
