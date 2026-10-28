// Plaid: who may touch bank data, and what "disconnected" has to mean.
//
// WHY THIS EXISTS: two promises the security policies make to Plaid were only kept
// by the browser, or only on a good day.
//
//  1. "MFA must be enabled before a bank can be connected." The client asked for a
//     TOTP factor before opening Plaid Link — but the anon key is public, so a stolen
//     PASSWORD alone mints a valid aal1 token, and every /plaid/* endpoint accepted
//     it from curl. "Remember this device" leaves real sessions at aal1 too. The
//     Worker now refuses bank data below aal2, and this suite drives the real router.
//
//  2. "Bank access tokens are revoked at Plaid … and the stored token record is
//     deleted." Disconnect and account deletion deleted our copy of the token even
//     when Plaid's /item/remove FAILED — leaving a bank connection that was still
//     live at Plaid and that nobody could ever revoke again. A failed store on
//     exchange did the same from the other end: a linked item with no token kept.
//
// Every one of these fails silently: the UI says "Bank disconnected" either way.
//
//   run:  node test/plaid.test.mjs
//
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workerSrc = readFileSync(join(root, 'worker', 'push-cron.js'), 'utf8');
const client = readFileSync(join(root, 'index.html'), 'utf8');

// Import the SHIPPED Worker as a module (copied to .mjs so Node treats it as ESM
// without a package.json) and call its real fetch() router.
const dir = mkdtempSync(join(tmpdir(), 'bk-plaid-'));
writeFileSync(join(dir, 'worker.mjs'), workerSrc);
const worker = (await import(pathToFileURL(join(dir, 'worker.mjs')).href)).default;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('• ' + name); pass++; }
  catch (e) { console.log('✗ ' + name + '\n    ' + e.message); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'mismatch') + ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const SUPA = 'https://supa.test';
const env = { SUPABASE_URL: SUPA, SUPABASE_SERVICE_KEY: 'svc', PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_ENV: 'sandbox' };
const b64u = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenFor = aal => `${b64u('{"alg":"HS256"}')}.${b64u(JSON.stringify({ sub: 'u1', aal }))}.sig`;

// A scripted network. `world` is what each test arranges; `calls` is what happened.
let world, calls;
function reset(over = {}) {
  calls = [];
  world = {
    goTrueOk: true,
    factors: [{ factor_type: 'totp', status: 'verified' }],
    items: [{ item_id: 'it1', access_token: 'access-1', institution: 'First Bank' }],
    removeError: null,          // null = /item/remove succeeds; else a Plaid error_code
    storeStatus: 201,
    ...over
  };
}
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const method = init.method || 'GET';
  calls.push({ url, method, body: init.body });
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  if (url === `${SUPA}/auth/v1/user`) return world.goTrueOk ? json({ id: 'u1', email: 'a@b.c', factors: world.factors }) : json({ msg: 'bad jwt' }, 401);
  if (url.startsWith(`${SUPA}/rest/v1/plaid_items`)) {
    if (method === 'GET') return json(world.items);
    if (method === 'POST') return new Response('', { status: world.storeStatus });
    if (method === 'DELETE') return new Response(null, { status: 204 });
  }
  if (url.startsWith(`${SUPA}/rest/v1/`)) return new Response(null, { status: 204 });
  if (url.startsWith(`${SUPA}/auth/v1/admin/users/`)) return new Response(null, { status: 200 });
  if (url.startsWith(`${SUPA}/storage/v1/object/list/`)) return json([]);
  if (url.startsWith('https://sandbox.plaid.com/')) {
    const path = url.slice('https://sandbox.plaid.com'.length);
    if (path === '/item/remove') return world.removeError ? json({ error_code: world.removeError, error_message: 'nope' }, 400) : json({ removed: true });
    if (path === '/link/token/create') return json({ link_token: 'link-xyz' });
    if (path === '/transactions/get') return json({ transactions: [], accounts: [], total_transactions: 0 });
    if (path === '/transactions/refresh') return json({});
    if (path === '/item/get') return json({ item: {} });
    if (path === '/item/public_token/exchange') return json({ access_token: 'access-new', item_id: 'it-new' });
  }
  throw new Error('unexpected fetch ' + method + ' ' + url);
};
async function call(path, { aal = 'aal2', body = {}, method = 'POST' } = {}) {
  const req = new Request('https://app.test' + path, {
    method, headers: { Authorization: 'Bearer ' + tokenFor(aal), 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body)
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const plaidCalls = () => calls.filter(c => c.url.includes('plaid.com'));
const tokenDeletes = () => calls.filter(c => c.method === 'DELETE' && c.url.includes('/plaid_items'));

console.log('\nPLAID — 2FA on bank data, and revocation that holds\n');

// ── 1. The Worker, not the browser, decides who reaches bank data ──────────

const GATED = [
  ['/plaid/link-token', {}],
  ['/plaid/exchange', { public_token: 'public-1' }],
  ['/plaid/transactions', { start_date: '2026-09-01', end_date: '2026-09-30' }],
  ['/plaid/refresh', {}],
];

for (const [path, body] of GATED) {
  await test(`${path} refuses a password-only (aal1) session — and never calls Plaid`, async () => {
    reset();
    const r = await call(path, { aal: 'aal1', body });
    eq(r.status, 403, 'status');
    eq(r.data.mfa_required, 'verify', 'a user WITH a factor is told to step up');
    eq(plaidCalls().length, 0, 'Plaid was called before the 2FA check');
  });
}

await test('with no 2FA factor at all, the answer is "enroll", not "verify"', async () => {
  reset({ factors: [{ factor_type: 'totp', status: 'unverified' }] });
  const r = await call('/plaid/link-token', { aal: 'aal1' });
  eq(r.status, 403); eq(r.data.mfa_required, 'enroll');
});

await test('an aal2 session gets through', async () => {
  reset();
  const r = await call('/plaid/link-token', { aal: 'aal2' });
  eq(r.status, 200); eq(r.data.link_token, 'link-xyz');
  const t = await call('/plaid/transactions', { aal: 'aal2', body: GATED[2][1] });
  eq(t.status, 200);
});

await test('an "aal2" claim on a token GoTrue rejects is still a 401', async () => {
  // The claims are only read AFTER GoTrue has verified the signature. A forged
  // payload must never be enough on its own.
  reset({ goTrueOk: false });
  const r = await call('/plaid/link-token', { aal: 'aal2' });
  eq(r.status, 401);
  eq(plaidCalls().length, 0);
});

await test('status (bank names) and disconnect still work at plain sign-in', async () => {
  // Removing access must never be harder than granting it, and the bank list is
  // what draws the Statements card before any step-up.
  reset();
  eq((await call('/plaid/status', { aal: 'aal1', method: 'GET' })).status, 200);
  eq((await call('/plaid/disconnect', { aal: 'aal1', body: { item_id: 'it1' } })).status, 200);
});

// ── 2. "Disconnected" means revoked at Plaid, or nothing changes ───────────

await test('disconnect keeps the token when Plaid refuses the revoke', async () => {
  reset({ removeError: 'INTERNAL_SERVER_ERROR' });
  const r = await call('/plaid/disconnect', { aal: 'aal1', body: { item_id: 'it1' } });
  eq(r.status, 502, 'a failed revoke must not report success');
  eq(tokenDeletes().length, 0, 'deleted the only token that could still revoke a live item');
});

await test('disconnect treats "item already gone" as revoked', async () => {
  for (const code of ['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN']) {
    reset({ removeError: code });
    const r = await call('/plaid/disconnect', { aal: 'aal1', body: { item_id: 'it1' } });
    eq(r.status, 200, code);
    eq(tokenDeletes().length, 1, code + ': the dead token row should be dropped');
  }
});

await test('the disconnect DELETE is scoped to the caller as well as the item', async () => {
  reset();
  await call('/plaid/disconnect', { aal: 'aal1', body: { item_id: 'it1' } });
  const d = tokenDeletes()[0];
  ok(d && /item_id=eq\.it1/.test(d.url) && /user_id=eq\.u1/.test(d.url), 'DELETE runs on the service key — it must self-scope');
});

await test('exchange undoes the link at Plaid when the token cannot be stored', async () => {
  reset({ storeStatus: 500 });
  const r = await call('/plaid/exchange', { aal: 'aal2', body: { public_token: 'public-1' } });
  eq(r.status, 502, 'reported success for a bank whose token was lost');
  const rm = calls.find(c => c.url.endsWith('/item/remove'));
  ok(rm && JSON.parse(rm.body).access_token === 'access-new', 'the orphaned item was left live at Plaid');
});

await test('account deletion stops BEFORE deleting anything if a revoke fails', async () => {
  reset({ removeError: 'INTERNAL_SERVER_ERROR' });
  const r = await call('/delete-account', { aal: 'aal1' });
  eq(r.status, 502);
  eq(calls.filter(c => c.method === 'DELETE').length, 0, 'rows/login deleted while a bank stayed linked');
});

await test('account deletion revokes, then removes the tokens and the login', async () => {
  reset();
  const r = await call('/delete-account', { aal: 'aal1' });
  eq(r.status, 200);
  ok(calls.some(c => c.url.endsWith('/item/remove')), 'never revoked at Plaid');
  ok(tokenDeletes().length >= 1, 'token rows left behind');
  ok(calls.some(c => c.method === 'DELETE' && c.url.includes('/auth/v1/admin/users/u1')), 'login left behind');
});

// ── 3. The client steps up instead of dead-ending ──────────────────────────

await test('plaidFetch answers mfa_required:"verify" with one step-up and one retry', () => {
  const start = client.indexOf('async function plaidFetch(');
  const body = client.slice(start, client.indexOf('\n}', start));
  ok(/mfa_required === 'verify'/.test(body) && /plaidStepUp\(\)/.test(body), 'no step-up on a 403');
  ok(/!steppedUp/.test(body), 'a retry that 403s again would loop forever');
});

await test('every /plaid/* call from the client goes through plaidFetch', () => {
  // A bare fetch() would 403 with no step-up — bank sync would just stop working
  // for a remembered device, with a generic error.
  const bare = [...client.matchAll(/fetch\(\s*['"`]\/plaid\//g)];
  eq(bare.length, 0, 'direct fetch to /plaid/');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
