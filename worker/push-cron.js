// Bookkeeper Worker.
//   /run?key=... — push reminder cron trigger (per-job + recurring, every minute)
//   /plaid/* — bank reconciliation via Plaid: status (GET), link-token, exchange,
//              transactions, disconnect (all POST, auth'd by Supabase token).
//              The Plaid access_token is stored server-side only (plaid_items).
//   anything else → static assets (index.html, sw.js, manifest.json, version.json, icons)
//
// Required Worker secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, MANUAL_KEY.
// Bank reconciliation (Plaid): PLAID_CLIENT_ID, PLAID_SECRET secrets + PLAID_ENV var
// ('sandbox' | 'production', defaults to sandbox).

const TZ = 'America/Denver';
const FIRE_WINDOW_MS = 30 * 60 * 1000;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(Promise.all([runReminders(env), runRecurringReminders(env)])); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/run') {
      // Gated by MANUAL_KEY. Refuse if the secret is unset (never leave the
      // endpoint open) and compare in constant time so the key can't be
      // recovered by timing the response.
      if (!env.MANUAL_KEY || !timingSafeEqual(url.searchParams.get('key') || '', env.MANUAL_KEY)) {
        return new Response('Not found', { status: 404 });
      }
      const summary = { jobs: await runReminders(env), recurring: await runRecurringReminders(env) };
      return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/plaid/status' && req.method === 'GET') return plaidStatus(req, env);
    if (url.pathname === '/plaid/link-token' && req.method === 'POST') return plaidLinkToken(req, env);
    if (url.pathname === '/plaid/exchange' && req.method === 'POST') return plaidExchange(req, env);
    if (url.pathname === '/plaid/transactions' && req.method === 'POST') return plaidTransactions(req, env);
    if (url.pathname === '/plaid/refresh' && req.method === 'POST') return plaidRefresh(req, env);
    if (url.pathname === '/plaid/disconnect' && req.method === 'POST') return plaidDisconnect(req, env);
    if (url.pathname === '/delete-account' && req.method === 'POST') return deleteAccount(req, env);
    if (env.ASSETS) return withSecurityHeaders(await env.ASSETS.fetch(req), env);
    return new Response('Bookkeeper. Static assets binding missing.', { status: 500 });
  }
};

// Security headers on served assets. The CSP allowlists exactly what the app
// loads — Supabase (REST/auth/storage), jsdelivr + cdnjs (pinned, SRI'd libs),
// Plaid Link, Google Fonts — so injected script can't pull code from or
// exfiltrate data to anywhere else. 'unsafe-inline' is required: the whole app
// is one inline <script>.
function withSecurityHeaders(res, env) {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  // Cross-origin isolation + clickjacking defense apply to every asset, not just
  // the HTML doc. COOP severs the opener relationship (no window.opener leaks);
  // X-Frame-Options backs up CSP frame-ancestors for pre-CSP2 browsers.
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('X-Frame-Options', 'DENY');
  if ((h.get('content-type') || '').includes('text/html')) {
    const supa = env.SUPABASE_URL || '';
    h.set('Content-Security-Policy', [
      "default-src 'self'",
      `connect-src 'self' ${supa} https://*.plaid.com`,
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://cdn.plaid.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
      "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net",
      `img-src 'self' data: blob: ${supa}`,
      "frame-src 'self' blob: https://cdn.plaid.com https://*.plaid.com",
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests"
    ].join('; '));
    h.set('Referrer-Policy', 'no-referrer');
    h.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()');
    h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Constant-time string comparison (avoids leaking secret length/prefix via timing).
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

// Verify the caller's Supabase access token → user object or null.
async function authUser(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// ──────────────────────────────────────────────────────────────────────
// Plaid bank reconciliation. The user links a
// bank via Plaid Link; the Worker exchanges the public_token for a long-lived
// access_token (stored server-side ONLY in the plaid_items table via the service
// key — never handed to the browser) and, on demand, pulls a month's cleared
// transactions. Those are mapped into the SAME statement shape the reconcile view
// already consumes (sign flipped: Plaid amounts are +out/−in), so all downstream
// matching, buckets, and the audit grid work unchanged.
const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };
function plaidHost(env) { return PLAID_HOSTS[(env.PLAID_ENV || 'sandbox').toLowerCase()] || PLAID_HOSTS.sandbox; }
function plaidConfigured(env) { return !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET); }
const jsonResp = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

// Call a Plaid endpoint with the app credentials merged in. Throws on non-2xx,
// attaching Plaid's structured error (error_code/error_message) to the Error.
async function plaidApi(env, path, body) {
  const r = await fetch(plaidHost(env) + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error_message || `Plaid ${r.status}`); e.plaid = data; e.status = r.status; throw e; }
  return data;
}

// Persist / read the user's Plaid items (access_token, item_id, institution).
// plaid_items has RLS enabled with NO authenticated policy, so only the Worker's
// service key can touch it — the browser can never read the access_token. A user
// can link several banks, so there may be MANY rows per user; the primary key is
// item_id (unique per Plaid item), so upserting on item_id adds a new bank and a
// re-link of the same bank just refreshes its row.
async function plaidStore(env, userId, row) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/plaid_items?on_conflict=item_id`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, ...row, updated_at: new Date().toISOString() })
  });
}
async function plaidLoadAll(env, userId) {
  const rows = await supaGet(env, `plaid_items?user_id=eq.${userId}&select=access_token,item_id,institution&order=updated_at.asc`);
  return Array.isArray(rows) ? rows : [];
}
// Keep the legacy (non-sensitive) profiles.plaid_institution mirror roughly
// accurate for the UI: a comma-joined list of the linked bank names (or null).
async function plaidRefreshMirror(env, userId) {
  const items = await plaidLoadAll(env, userId).catch(() => []);
  const names = items.map(i => i.institution).filter(Boolean);
  await supaPatch(env, `profiles?id=eq.${userId}`, { plaid_institution: names.length ? names.join(', ') : null });
  return items;
}

// Is Plaid set up, and which banks has this user linked? (Non-sensitive — drives UI.)
async function plaidStatus(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  let items = [];
  if (plaidConfigured(env)) { try { items = await plaidLoadAll(env, user.id); } catch (e) { console.error('plaid status load', e); } }
  const banks = items.filter(i => i.access_token).map(i => ({ item_id: i.item_id, institution: i.institution || null }));
  // `connected`/`institution` kept for backward-compat; `banks` is the source of truth.
  return jsonResp({ ok: true, configured: plaidConfigured(env), connected: banks.length > 0, banks, institution: banks[0] ? banks[0].institution : null });
}

// Mint a short-lived Link token so the browser can open Plaid Link. With an
// `item_id`, mint an UPDATE-mode token (re-auth an existing bank in place)
// instead of adding a new one.
async function plaidLinkToken(req, env) {
  if (!plaidConfigured(env)) return jsonResp({ error: 'Bank sync isn’t configured (missing PLAID_CLIENT_ID / PLAID_SECRET).' }, 500);
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  let b; try { b = await req.json(); } catch { b = {}; }
  try {
    const cfg = { user: { client_user_id: user.id }, client_name: 'Bookkeeper', country_codes: ['US'], language: 'en' };
    if (b && b.item_id) {
      // Update mode: pass the existing item's access_token, no products.
      const items = await plaidLoadAll(env, user.id);
      const it = items.find(i => i.item_id === b.item_id);
      if (!it || !it.access_token) return jsonResp({ error: 'That bank isn’t connected.' }, 400);
      cfg.access_token = it.access_token;
    } else {
      cfg.products = ['transactions'];
      // Ask for the maximum history (24 months) instead of Plaid's 90-day default,
      // so older months can be reconciled. Fixed at link time — an already-linked
      // bank must be reconnected for the longer window to take effect.
      cfg.transactions = { days_requested: 730 };
    }
    const data = await plaidApi(env, '/link/token/create', cfg);
    return jsonResp({ ok: true, link_token: data.link_token });
  } catch (e) { console.error('plaid link-token', e.plaid || e); return jsonResp({ error: e.message || 'Plaid error' }, 502); }
}

// Swap the browser's public_token for a stored access_token; record the bank name.
// Upserts on item_id, so this ADDS a bank (or refreshes one relinked with the same
// login) without disturbing the user's other connected banks.
async function plaidExchange(req, env) {
  if (!plaidConfigured(env)) return jsonResp({ error: 'Bank sync isn’t configured.' }, 500);
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  let b; try { b = await req.json(); } catch { return jsonResp({ error: 'Bad request.' }, 400); }
  if (!b.public_token) return jsonResp({ error: 'Missing public_token.' }, 400);
  try {
    const ex = await plaidApi(env, '/item/public_token/exchange', { public_token: b.public_token });
    let institution = null;
    try {
      const item = await plaidApi(env, '/item/get', { access_token: ex.access_token });
      const instId = item.item && item.item.institution_id;
      if (instId) {
        const inst = await plaidApi(env, '/institutions/get_by_id', { institution_id: instId, country_codes: ['US'] });
        institution = inst.institution && inst.institution.name;
      }
    } catch (e) { /* institution name is best-effort */ }
    await plaidStore(env, user.id, { access_token: ex.access_token, item_id: ex.item_id, institution });
    await plaidRefreshMirror(env, user.id);
    return jsonResp({ ok: true, institution });
  } catch (e) { console.error('plaid exchange', e.plaid || e); return jsonResp({ error: e.message || 'Plaid error' }, 502); }
}

// Pull one bank's date range of cleared + pending transactions, mapped into the
// statement shape the reconcile view consumes. Sign is flipped: Plaid uses
// +money-out / −money-in, but the app's convention (matching the ledger) is −out/+in.
async function plaidPullItemRange(env, item, start, end) {
  let all = [], offset = 0, total = Infinity, accounts = [];
  while (offset < total) {
    const data = await plaidApi(env, '/transactions/get', {
      access_token: item.access_token, start_date: start, end_date: end, options: { count: 500, offset }
    });
    total = data.total_transactions || 0;
    if (data.accounts) accounts = data.accounts;
    const batch = data.transactions || [];
    all = all.concat(batch);
    offset += batch.length;
    if (!batch.length) break;
  }
  const bank = item.institution || null;
  const mapT = t => ({ date: t.date, description: t.merchant_name || t.name || 'Transaction', amount: -(Number(t.amount) || 0), balance: null, bank });
  return {
    transactions: all.filter(t => !t.pending).map(mapT),
    pending: all.filter(t => t.pending).map(mapT),
    accounts: accounts.map(a => ({ name: a.name, mask: a.mask, subtype: a.subtype, bank }))
  };
}

// Pull a month across ALL of the user's linked banks and merge the results into a
// single statement. One bank failing (e.g. needs re-auth) doesn't sink the rest —
// its error is reported in `itemErrors`; only when EVERY bank fails do we return an
// error status so the client can react (re-auth, retry).
async function plaidTransactions(req, env) {
  if (!plaidConfigured(env)) return jsonResp({ error: 'Bank sync isn’t configured.' }, 500);
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  const allItems = (await plaidLoadAll(env, user.id).catch(() => [])).filter(i => i.access_token);
  if (!allItems.length) return jsonResp({ error: 'No bank connected yet.' }, 400);
  let b; try { b = await req.json(); } catch { b = {}; }
  // With an item_id, pull just that ONE bank (per-bank reconciliation); without,
  // pull and merge every linked bank (legacy behavior).
  const items = (b && b.item_id) ? allItems.filter(i => i.item_id === b.item_id) : allItems;
  if (!items.length) return jsonResp({ error: 'That bank isn’t connected.' }, 400);
  const start = (b.start_date || '').slice(0, 10), end = (b.end_date || '').slice(0, 10);
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(start) || !isDate(end)) return jsonResp({ error: 'Bad date range.' }, 400);
  let transactions = [], pending = [], accounts = [];
  const itemErrors = [];
  for (const item of items) {
    try {
      const r = await plaidPullItemRange(env, item, start, end);
      transactions = transactions.concat(r.transactions);
      pending = pending.concat(r.pending);
      accounts = accounts.concat(r.accounts);
    } catch (e) {
      console.error('plaid transactions', item.item_id, e.plaid || e);
      const code = e.plaid && e.plaid.error_code;
      itemErrors.push({ item_id: item.item_id, institution: item.institution || null, code: code || null, message: e.message || 'Plaid error', reconnect: code === 'ITEM_LOGIN_REQUIRED' });
    }
  }
  if (itemErrors.length === items.length) {
    const first = itemErrors[0];
    if (first.code === 'PRODUCT_NOT_READY') return jsonResp({ error: 'Plaid is still preparing your transactions — try again in a minute.', itemErrors }, 503);
    if (first.reconnect) return jsonResp({ error: 'Your bank needs re-authentication — reconnect the account.', reconnect: true, itemErrors }, 409);
    return jsonResp({ error: first.message, itemErrors }, 502);
  }
  return jsonResp({ ok: true, institution: items[0].institution || null, transactions, pending, accounts, itemErrors });
}

// Repair a stale bank link in place — no re-linking, so the item_id (and all the
// reconciliation history keyed to it) is preserved. Checks each item's health,
// then asks Plaid to re-pull from the bank (`/transactions/refresh`) when the login
// is still good. If the item needs a fresh sign-in (ITEM_LOGIN_REQUIRED) it can't
// be refreshed silently — we report `needs_reauth` so the client opens update-mode
// Plaid Link instead. With an `item_id`, repair just that bank; without, all of them.
async function plaidRefresh(req, env) {
  if (!plaidConfigured(env)) return jsonResp({ error: 'Bank sync isn’t configured.' }, 500);
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  let b; try { b = await req.json(); } catch { b = {}; }
  const allItems = (await plaidLoadAll(env, user.id).catch(() => [])).filter(i => i.access_token);
  const items = (b && b.item_id) ? allItems.filter(i => i.item_id === b.item_id) : allItems;
  if (!items.length) return jsonResp({ error: 'That bank isn’t connected.' }, 400);
  const results = [];
  for (const item of items) {
    let needs_reauth = false, refreshed = false, error = null;
    // Is the login still valid? A pre-existing item error (esp. ITEM_LOGIN_REQUIRED)
    // means a silent refresh will just fail — go straight to re-auth.
    try {
      const info = await plaidApi(env, '/item/get', { access_token: item.access_token });
      const ie = info.item && info.item.error;
      if (ie) { if (ie.error_code === 'ITEM_LOGIN_REQUIRED') needs_reauth = true; else error = ie.error_message || ie.error_code; }
    } catch (e) {
      if (e.plaid && e.plaid.error_code === 'ITEM_LOGIN_REQUIRED') needs_reauth = true; else error = (e.plaid && e.plaid.error_message) || e.message;
    }
    if (!needs_reauth) {
      try { await plaidApi(env, '/transactions/refresh', { access_token: item.access_token }); refreshed = true; }
      catch (e) {
        if (e.plaid && e.plaid.error_code === 'ITEM_LOGIN_REQUIRED') needs_reauth = true;
        else error = error || (e.plaid && e.plaid.error_message) || e.message;
      }
    }
    results.push({ item_id: item.item_id, needs_reauth, refreshed, error });
  }
  return jsonResp({ ok: true, needs_reauth: results.some(r => r.needs_reauth), results });
}

// Unlink: invalidate the item(s) at Plaid, then drop the stored token(s). With an
// `item_id`, disconnect just that one bank; without, disconnect them all (legacy).
async function plaidDisconnect(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  let b; try { b = await req.json(); } catch { b = {}; }
  const items = await plaidLoadAll(env, user.id).catch(() => []);
  const targets = (b && b.item_id) ? items.filter(i => i.item_id === b.item_id) : items;
  for (const item of targets) {
    if (item.access_token && plaidConfigured(env)) {
      try { await plaidApi(env, '/item/remove', { access_token: item.access_token }); } catch (e) { console.error('plaid item/remove', e.plaid || e); }
    }
    try {
      await fetch(`${env.SUPABASE_URL}/rest/v1/plaid_items?item_id=eq.${encodeURIComponent(item.item_id)}`, {
        method: 'DELETE', headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, Prefer: 'return=minimal' }
      });
    } catch (e) { console.error('plaid_items delete', e); }
  }
  await plaidRefreshMirror(env, user.id);
  return jsonResp({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────
// Account deletion. Verifies the caller's own session, then (service key)
// unlinks banks at Plaid, drops the service-key-only plaid_items rows, deletes
// the user's Storage files and every data row, and finally removes the auth
// login itself via the GoTrue admin API. Irreversible; the client requires the
// user to type DELETE before calling this.
function svcHeaders(env, prefer) {
  const h = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  return h;
}
// Best-effort wipe of a private bucket's <uid>/ folder.
async function deleteUserStorage(env, bucket, uid) {
  const listRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST', headers: svcHeaders(env), body: JSON.stringify({ prefix: uid + '/', limit: 1000 })
  });
  if (!listRes.ok) return;
  const files = await listRes.json().catch(() => []);
  const names = (Array.isArray(files) ? files : []).map(f => `${uid}/${f.name}`);
  if (!names.length) return;
  await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE', headers: svcHeaders(env), body: JSON.stringify({ prefixes: names })
  });
}
async function deleteAccount(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  const uid = user.id;
  // 1. Unlink banks at Plaid, then drop the stored tokens.
  try {
    const items = await plaidLoadAll(env, uid).catch(() => []);
    for (const item of items) {
      if (item.access_token && plaidConfigured(env)) {
        try { await plaidApi(env, '/item/remove', { access_token: item.access_token }); } catch (e) { console.error('del plaid remove', e.plaid || e); }
      }
    }
    await fetch(`${env.SUPABASE_URL}/rest/v1/plaid_items?user_id=eq.${uid}`, { method: 'DELETE', headers: svcHeaders(env, 'return=minimal') });
  } catch (e) { console.error('del plaid', e); }
  // 2. Storage files (best-effort).
  for (const bucket of ['receipts', 'statements']) {
    try { await deleteUserStorage(env, bucket, uid); } catch (e) { console.error('del storage ' + bucket, e); }
  }
  // 3. Data rows — children before parents so FKs don't block.
  for (const t of ['store_credits', 'owner_transactions', 'trips', 'jobs', 'recurring', 'expenses', 'invoices', 'customers', 'accounts']) {
    try { await fetch(`${env.SUPABASE_URL}/rest/v1/${t}?user_id=eq.${uid}`, { method: 'DELETE', headers: svcHeaders(env, 'return=minimal') }); } catch (e) { console.error('del ' + t, e); }
  }
  try { await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, { method: 'DELETE', headers: svcHeaders(env, 'return=minimal') }); } catch (e) { console.error('del profiles', e); }
  // 4. The login itself (GoTrue admin) — last, since it invalidates the session.
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
    method: 'DELETE', headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!r.ok) return jsonResp({ ok: false, error: 'Data removed, but the login could not be deleted (' + r.status + '). Contact support.' }, 500);
  return jsonResp({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────
// Push reminders cron — fires per-job at the user-configured offset.
async function runReminders(env) {
  const jobs = await supaGet(env, 'jobs?done=eq.false&remind_minutes=not.is.null&reminded_at=is.null&select=id,user_id,title,date,time,remind_minutes');
  if (!jobs.length) return { checked: 0, fired: 0 };
  const now = Date.now();
  let fired = 0, missed = 0, failed = 0;
  const userIds = [...new Set(jobs.map(j => j.user_id))];
  const profs = userIds.length
    ? await supaGet(env, `profiles?id=in.(${userIds.join(',')})&push_subscription=not.is.null&select=id,push_subscription`)
    : [];
  const subByUser = {};
  for (const p of profs) subByUser[p.id] = p.push_subscription;

  for (const j of jobs) {
    if (!j.date) continue;
    const jobUtcMs = wallToUtc(j.date, j.time || '00:00');
    const reminderAt = jobUtcMs - parseInt(j.remind_minutes) * 60000;
    if (reminderAt > now) continue;
    if (now > reminderAt + FIRE_WINDOW_MS) {
      await supaPatch(env, `jobs?id=eq.${j.id}`, { reminded_at: new Date(reminderAt).toISOString() });
      missed++;
      continue;
    }
    const sub = subByUser[j.user_id];
    if (!sub || !sub.endpoint) continue;
    try {
      const when = fmtClock(j.time);
      await sendWebPush(sub, env, {
        title: 'Upcoming job',
        body: (j.title || 'Job') + (when ? ' · ' + when : ''),
        url: '/', tag: 'job-' + j.id
      });
      await supaPatch(env, `jobs?id=eq.${j.id}`, { reminded_at: new Date().toISOString() });
      fired++;
    } catch (e) {
      const msg = String(e && e.message || e);
      console.error('reminder push failed', j.id, msg);
      failed++;
      if (/\b(404|410)\b/.test(msg)) await supaPatch(env, `profiles?id=eq.${j.user_id}`, { push_subscription: null });
    }
  }
  return { checked: jobs.length, fired, missed, failed };
}

// ──────────────────────────────────────────────────────────────────────
// Recurring reminders — one morning push (>= 8am Denver) on the day a recurring
// invoice/expense comes due, deduped per occurrence via recurring.reminded_date.
async function runRecurringReminders(env) {
  const { dateStr: todayDen, hour } = denverParts();
  if (hour < 6) return { checked: 0, fired: 0 };          // earliest selectable ping hour
  const rows = await supaGet(env, 'recurring?active=eq.true&notify=eq.true&select=id,user_id,next_date,reminded_date,label,data,kind');
  const due = rows.filter(r => r.next_date && r.next_date <= todayDen && r.reminded_date !== r.next_date);
  if (!due.length) return { checked: rows.length, fired: 0 };
  const userIds = [...new Set(due.map(r => r.user_id))];
  const profs = await supaGet(env, `profiles?id=in.(${userIds.join(',')})&push_subscription=not.is.null&select=id,push_subscription`);
  const subByUser = {};
  for (const p of profs) subByUser[p.id] = p.push_subscription;
  // Per-user morning-ping hour (best-effort; column may not exist yet → default 8).
  const hourByUser = {};
  try {
    const hrs = await supaGet(env, `profiles?id=in.(${userIds.join(',')})&select=id,notify_hour`);
    for (const p of hrs) if (p.notify_hour != null) hourByUser[p.id] = p.notify_hour;
  } catch (e) { /* notify_hour column not added yet — everyone defaults to 8 */ }
  let fired = 0, failed = 0;
  for (const r of due) {
    if (hour < (hourByUser[r.user_id] ?? 8)) continue;    // before this user's chosen time
    const sub = subByUser[r.user_id];
    if (!sub || !sub.endpoint) continue;                  // no device yet — try again next run
    try {
      const d = r.data || {};
      const label = r.label || (r.kind === 'invoice' ? 'Invoice' : 'Expense');
      const amt = fmtMoney(d.amount != null ? d.amount : d.total);
      await sendWebPush(sub, env, {
        title: r.kind === 'invoice' ? 'Invoice due today' : 'Payment due today',
        body: label + (amt ? ' (' + amt + ')' : '') + ' is due today',
        url: '/', tag: 'recur-' + r.id
      });
      await supaPatch(env, `recurring?id=eq.${r.id}`, { reminded_date: r.next_date });
      fired++;
    } catch (e) {
      const msg = String(e && e.message || e);
      console.error('recurring push failed', r.id, msg);
      failed++;
      if (/\b(404|410)\b/.test(msg)) await supaPatch(env, `profiles?id=eq.${r.user_id}`, { push_subscription: null });
    }
  }
  return { checked: rows.length, fired, failed };
}

// Current date ('YYYY-MM-DD') and hour (0–23) in the America/Denver wall clock.
function denverParts() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: TZ });   // en-CA → ISO yyyy-mm-dd
  let hour = parseInt(now.toLocaleString('en-US', { timeZone: TZ, hour12: false, hour: 'numeric' }), 10);
  if (hour === 24 || isNaN(hour)) hour = 0;
  return { dateStr, hour };
}

function wallToUtc(dateStr, timeStr) {
  const naive = new Date(dateStr + 'T' + (timeStr.length === 5 ? timeStr + ':00' : timeStr) + 'Z');
  const offsetMin = tzOffsetMin(naive);
  return naive.getTime() - offsetMin * 60000;
}
function tzOffsetMin(date) {
  const inv = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzv = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  return Math.round((tzv - inv) / 60000);
}

async function supaGet(env, path) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!r.ok) throw new Error(`supabase ${r.status} ${await r.text().catch(()=>'')}`);
  return r.json();
}
async function supaPatch(env, path, body) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
}

// Send a Web Push. When `message` is given (and the subscription carries the
// p256dh/auth keys), the JSON is encrypted per RFC 8291 (aes128gcm) so the
// service worker can render a detailed notification. Any failure to encrypt —
// or a push service that rejects the encrypted body — falls back to a plain
// payload-less push, so a reminder always lands (with the SW's generic text).
async function sendWebPush(sub, env, message) {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJwt(audience, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const auth = { TTL: '3600', Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}` };
  let body;
  if (message && sub.keys && sub.keys.p256dh && sub.keys.auth) {
    try {
      body = await encryptPayload(sub, JSON.stringify(message));
    } catch (e) {
      console.error('push encrypt failed, sending plain', String(e && e.message || e));
      body = undefined;
    }
  }
  const headers = body ? { ...auth, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } : auth;
  const r = await fetch(sub.endpoint, { method: 'POST', headers, body });
  if (!r.ok) {
    // A rejected detailed payload shouldn't cost the reminder — retry payload-less.
    if (body && !/\b(404|410)\b/.test(String(r.status))) {
      const r2 = await fetch(sub.endpoint, { method: 'POST', headers: auth });
      if (r2.ok) return;
    }
    throw new Error(`push status ${r.status} ${await r.text().catch(()=>'')}`);
  }
}

// RFC 8291 aes128gcm Web Push encryption. The 16-byte salt and the ephemeral
// public key are embedded in the aes128gcm header, so no extra request headers
// are needed beyond Content-Encoding: aes128gcm.
async function encryptPayload(sub, plaintext) {
  const uaPublic = urlB64ToBytes(sub.keys.p256dh);   // subscriber key, 65 bytes
  const authSecret = urlB64ToBytes(sub.keys.auth);   // auth secret, 16 bytes
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('bad p256dh');
  const enc = new TextEncoder();

  // Ephemeral application-server ECDH key pair + shared secret with the browser.
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // Combine step: IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua||as).
  const ecdhKey = await crypto.subtle.importKey('raw', ecdh, 'HKDF', false, ['deriveBits']);
  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo }, ecdhKey, 256));

  // Content encryption key + nonce (RFC 8188), keyed off a random salt.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('Content-Encoding: aes128gcm\0') }, ikmKey, 128));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('Content-Encoding: nonce\0') }, ikmKey, 96));

  // Single record: plaintext + 0x02 delimiter, AES-128-GCM (16-byte tag appended).
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const record = concatBytes(enc.encode(plaintext), new Uint8Array([0x02]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // aes128gcm header: salt(16) || record_size(4 BE) || idlen(1) || keyid(as pub).
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ct);
}
function concatBytes(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
// "HH:MM[:SS]" (24h) → "h:MM AM/PM"; empty for anything unparseable.
function fmtClock(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  if (!m) return '';
  let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}
function fmtMoney(n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
async function makeVapidJwt(audience, subject, pubB64, privB64) {
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = { aud: audience, exp: Math.floor(Date.now()/1000) + 12 * 3600, sub: subject };
  const b64url = s => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const pub = urlB64ToBytes(pubB64);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY must be 65-byte uncompressed P-256');
  const jwk = { kty: 'EC', crv: 'P-256', d: privB64, x: bytesToUrlB64(pub.slice(1,33)), y: bytesToUrlB64(pub.slice(33,65)) };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return signingInput + '.' + bytesToUrlB64(new Uint8Array(sig));
}
function urlB64ToBytes(b) {
  const pad = '='.repeat((4 - b.length % 4) % 4);
  const std = (b + pad).replace(/-/g,'+').replace(/_/g,'/');
  const raw = atob(std);
  const arr = new Uint8Array(raw.length);
  for (let i=0;i<raw.length;i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function bytesToUrlB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
