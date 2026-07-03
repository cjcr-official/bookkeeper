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
    if (url.pathname === '/run' && url.searchParams.get('key') === env.MANUAL_KEY) {
      const summary = { jobs: await runReminders(env), recurring: await runRecurringReminders(env) };
      return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/plaid/status' && req.method === 'GET') return plaidStatus(req, env);
    if (url.pathname === '/plaid/link-token' && req.method === 'POST') return plaidLinkToken(req, env);
    if (url.pathname === '/plaid/exchange' && req.method === 'POST') return plaidExchange(req, env);
    if (url.pathname === '/plaid/transactions' && req.method === 'POST') return plaidTransactions(req, env);
    if (url.pathname === '/plaid/disconnect' && req.method === 'POST') return plaidDisconnect(req, env);
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Bookkeeper. Static assets binding missing.', { status: 500 });
  }
};

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

// Persist / read the per-user Plaid item (access_token, item_id, institution).
// plaid_items has RLS enabled with NO authenticated policy, so only the Worker's
// service key can touch it — the browser can never read the access_token.
async function plaidStore(env, userId, row) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/plaid_items?on_conflict=user_id`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, ...row, updated_at: new Date().toISOString() })
  });
}
async function plaidLoad(env, userId) {
  const rows = await supaGet(env, `plaid_items?user_id=eq.${userId}&select=access_token,item_id,institution`);
  return rows && rows[0];
}

// Is Plaid set up, and has this user linked a bank yet? (Non-sensitive — drives UI.)
async function plaidStatus(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  let item = null;
  if (plaidConfigured(env)) { try { item = await plaidLoad(env, user.id); } catch (e) { console.error('plaid status load', e); } }
  return jsonResp({ ok: true, configured: plaidConfigured(env), connected: !!(item && item.access_token), institution: (item && item.institution) || null });
}

// Mint a short-lived Link token so the browser can open Plaid Link.
async function plaidLinkToken(req, env) {
  if (!plaidConfigured(env)) return jsonResp({ error: 'Bank sync isn’t configured (missing PLAID_CLIENT_ID / PLAID_SECRET).' }, 500);
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  try {
    const data = await plaidApi(env, '/link/token/create', {
      user: { client_user_id: user.id },
      client_name: 'Bookkeeper',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      // Ask for the maximum history (24 months) instead of Plaid's 90-day default,
      // so older months can be reconciled. This is fixed at link time — an already
      // linked bank must be reconnected for the longer window to take effect.
      transactions: { days_requested: 730 }
    });
    return jsonResp({ ok: true, link_token: data.link_token });
  } catch (e) { console.error('plaid link-token', e.plaid || e); return jsonResp({ error: e.message || 'Plaid error' }, 502); }
}

// Swap the browser's public_token for a stored access_token; record the bank name.
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
    // Mirror the (non-sensitive) bank name onto profiles for the UI. Best-effort:
    // silently no-ops if the plaid_institution column hasn't been added yet.
    await supaPatch(env, `profiles?id=eq.${user.id}`, { plaid_institution: institution || 'bank' });
    return jsonResp({ ok: true, institution });
  } catch (e) { console.error('plaid exchange', e.plaid || e); return jsonResp({ error: e.message || 'Plaid error' }, 502); }
}

// Pull one date range of cleared transactions, mapped into the statement shape the
// reconcile view consumes. Sign is flipped: Plaid uses +money-out / −money-in, but
// the app's convention (matching the bank ledger) is −out / +in.
async function plaidTransactions(req, env) {
  if (!plaidConfigured(env)) return jsonResp({ error: 'Bank sync isn’t configured.' }, 500);
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  const item = await plaidLoad(env, user.id).catch(() => null);
  if (!item || !item.access_token) return jsonResp({ error: 'No bank connected yet.' }, 400);
  let b; try { b = await req.json(); } catch { b = {}; }
  const start = (b.start_date || '').slice(0, 10), end = (b.end_date || '').slice(0, 10);
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(start) || !isDate(end)) return jsonResp({ error: 'Bad date range.' }, 400);
  try {
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
    const transactions = all
      .filter(t => !t.pending)   // only cleared lines reconcile against the ledger
      .map(t => ({ date: t.date, description: t.merchant_name || t.name || 'Transaction', amount: -(Number(t.amount) || 0), balance: null }));
    return jsonResp({ ok: true, institution: item.institution || null, transactions, accounts: accounts.map(a => ({ name: a.name, mask: a.mask, subtype: a.subtype })) });
  } catch (e) {
    console.error('plaid transactions', e.plaid || e);
    const code = e.plaid && e.plaid.error_code;
    if (code === 'PRODUCT_NOT_READY') return jsonResp({ error: 'Plaid is still preparing your transactions — try again in a minute.' }, 503);
    if (code === 'ITEM_LOGIN_REQUIRED') return jsonResp({ error: 'Your bank needs re-authentication — reconnect the account.', reconnect: true }, 409);
    return jsonResp({ error: e.message || 'Plaid error' }, 502);
  }
}

// Unlink: invalidate the item at Plaid, then drop our stored token + bank name.
async function plaidDisconnect(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);
  const item = await plaidLoad(env, user.id).catch(() => null);
  if (item && item.access_token && plaidConfigured(env)) {
    try { await plaidApi(env, '/item/remove', { access_token: item.access_token }); } catch (e) { console.error('plaid item/remove', e.plaid || e); }
  }
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/plaid_items?user_id=eq.${user.id}`, {
      method: 'DELETE', headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, Prefer: 'return=minimal' }
    });
  } catch (e) { console.error('plaid_items delete', e); }
  await supaPatch(env, `profiles?id=eq.${user.id}`, { plaid_institution: null });
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
      await sendWebPush(sub, env);
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
  if (hour < 8) return { checked: 0, fired: 0 };          // hold until morning
  const rows = await supaGet(env, 'recurring?active=eq.true&notify=eq.true&select=id,user_id,next_date,reminded_date');
  const due = rows.filter(r => r.next_date && r.next_date <= todayDen && r.reminded_date !== r.next_date);
  if (!due.length) return { checked: rows.length, fired: 0 };
  const userIds = [...new Set(due.map(r => r.user_id))];
  const profs = await supaGet(env, `profiles?id=in.(${userIds.join(',')})&push_subscription=not.is.null&select=id,push_subscription`);
  const subByUser = {};
  for (const p of profs) subByUser[p.id] = p.push_subscription;
  let fired = 0, failed = 0;
  for (const r of due) {
    const sub = subByUser[r.user_id];
    if (!sub || !sub.endpoint) continue;                  // no device yet — try again next run
    try {
      await sendWebPush(sub, env);
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

async function sendWebPush(sub, env) {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJwt(audience, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '3600', Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}` } });
  if (!r.ok) throw new Error(`push status ${r.status} ${await r.text().catch(()=>'')}`);
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
