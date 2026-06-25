// Bookkeeper Worker.
//   /run?key=...        — push reminder cron trigger (per-job, every minute)
//   /ms-config (GET)    — public OAuth client id + redirect uri for the app
//   /ms-exchange (POST) — trade an OAuth auth-code for tokens; store refresh token
//   /ms-disconnect(POST)— forget the stored Outlook tokens
//   /send-invoice (POST)— email an invoice PDF FROM the user's Outlook mailbox
//                         via Microsoft Graph (auth'd by the Supabase token)
//   anything else → static assets (index.html, sw.js, manifest.json, version.json, icons)
//
// Required Worker secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, MANUAL_KEY,
// MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI.

const TZ = 'America/Denver';
const FIRE_WINDOW_MS = 30 * 60 * 1000;
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_SCOPE = 'openid profile email offline_access User.Read Mail.Send';

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runReminders(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/run' && url.searchParams.get('key') === env.MANUAL_KEY) {
      const summary = await runReminders(env);
      return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/ms-config' && req.method === 'GET') {
      return jsonResp({ clientId: env.MS_CLIENT_ID || '', redirectUri: env.MS_REDIRECT_URI || '', scope: MS_SCOPE });
    }
    if (url.pathname === '/ms-exchange' && req.method === 'POST') return msExchange(req, env);
    if (url.pathname === '/ms-disconnect' && req.method === 'POST') return msDisconnect(req, env);
    if (url.pathname === '/send-invoice' && req.method === 'POST') return sendInvoice(req, env);
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Bookkeeper. Static assets binding missing.', { status: 500 });
  }
};

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

// Verify the caller's Supabase access token → { id, email } or null.
async function authUser(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id, email: (u.email || '').trim() } : null;
}

// ──────────────────────────────────────────────────────────────────────
// Microsoft OAuth: connect the user's Outlook mailbox.
//
// The browser runs the authorization-code + PKCE redirect and hands us the
// code; we (the confidential client, holding MS_CLIENT_SECRET) exchange it for
// tokens server-side. The refresh token is stored in ms_tokens (service-role
// only — never exposed to the browser); the connected address is mirrored to
// profiles.ms_email for display.
async function msExchange(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Not signed in.' }, 401);
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return jsonResp({ error: 'Outlook is not configured on the server.' }, 500);
  let b; try { b = await req.json(); } catch { return jsonResp({ error: 'Bad request.' }, 400); }
  if (!b.code || !b.code_verifier) return jsonResp({ error: 'Missing authorization code.' }, 400);

  const form = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: b.code,
    redirect_uri: env.MS_REDIRECT_URI,
    code_verifier: b.code_verifier,
    scope: MS_SCOPE
  });
  const r = await fetch(MS_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.refresh_token) {
    console.error('ms token exchange failed', r.status, JSON.stringify(tok).slice(0, 300));
    return jsonResp({ error: tok.error_description || `Outlook sign-in failed (${r.status}).` }, 502);
  }
  // Find out which mailbox we just connected.
  let mailbox = user.email;
  try {
    const me = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (me.ok) { const j = await me.json(); mailbox = (j.mail || j.userPrincipalName || mailbox || '').trim(); }
  } catch {}

  await saveRefreshToken(env, user.id, tok.refresh_token);
  await supaPatch(env, `profiles?id=eq.${user.id}`, { ms_email: mailbox });
  return jsonResp({ ok: true, email: mailbox });
}

async function msDisconnect(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Not signed in.' }, 401);
  await fetch(`${env.SUPABASE_URL}/rest/v1/ms_tokens?user_id=eq.${user.id}`, {
    method: 'DELETE',
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, Prefer: 'return=minimal' }
  });
  await supaPatch(env, `profiles?id=eq.${user.id}`, { ms_email: null });
  return jsonResp({ ok: true });
}

async function saveRefreshToken(env, userId, refreshToken) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/ms_tokens`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({ user_id: userId, refresh_token: refreshToken, updated_at: new Date().toISOString() })
  });
}

async function getRefreshToken(env, userId) {
  const rows = await supaGet(env, `ms_tokens?user_id=eq.${userId}&select=refresh_token`);
  return rows.length ? rows[0].refresh_token : null;
}

// Trade the stored refresh token for a fresh access token (and store the
// rotated refresh token Microsoft returns).
async function getGraphAccessToken(env, userId) {
  const refresh = await getRefreshToken(env, userId);
  if (!refresh) return null;
  const form = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refresh,
    scope: MS_SCOPE
  });
  const r = await fetch(MS_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) {
    console.error('ms refresh failed', r.status, JSON.stringify(tok).slice(0, 200));
    return null;
  }
  if (tok.refresh_token) await saveRefreshToken(env, userId, tok.refresh_token);
  return tok.access_token;
}

// ──────────────────────────────────────────────────────────────────────
// Email an invoice PDF from the user's Outlook mailbox via Microsoft Graph.
async function sendInvoice(req, env) {
  const user = await authUser(req, env);
  if (!user) return jsonResp({ error: 'Session expired — sign in again.' }, 401);

  let b; try { b = await req.json(); } catch { return jsonResp({ error: 'Bad request.' }, 400); }
  const to = (b.to || '').trim();
  const subject = (b.subject || '').trim() || 'Invoice';
  const body = (b.body || '').toString();
  const pdfBase64 = (b.pdfBase64 || '').toString();
  const filename = (b.filename || 'Invoice.pdf').toString();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return jsonResp({ error: 'A valid recipient email is required.' }, 400);
  if (!pdfBase64) return jsonResp({ error: 'Missing invoice PDF.' }, 400);

  const accessToken = await getGraphAccessToken(env, user.id);
  if (!accessToken) return jsonResp({ error: 'Outlook isn’t connected. Open Settings and tap Connect Outlook.' }, 412);

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const message = {
    message: {
      subject,
      body: { contentType: 'HTML', content: '<div style="font-family:sans-serif;white-space:pre-wrap">' + (esc(body) || '&nbsp;') + '</div>' },
      toRecipients: [{ emailAddress: { address: to } }],
      attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: filename, contentType: 'application/pdf', contentBytes: pdfBase64 }]
    },
    saveToSentItems: true
  };
  const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('graph sendMail failed', r.status, detail);
    return jsonResp({ error: `Send failed (${r.status}). ${detail.slice(0, 300)}` }, 502);
  }
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
