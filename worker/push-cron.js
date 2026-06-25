// Bookkeeper Worker.
//   /run?key=... — push reminder cron trigger (per-job, every minute)
//   /send-invoice (POST) — emails an invoice PDF via Brevo (auth'd by the
//                          caller's Supabase access token)
//   anything else → static assets (index.html, sw.js, manifest.json, version.json, icons)
//
// Required Worker secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, MANUAL_KEY, BREVO_API_KEY.

const TZ = 'America/Denver';
const FIRE_WINDOW_MS = 30 * 60 * 1000;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runReminders(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/run' && url.searchParams.get('key') === env.MANUAL_KEY) {
      const summary = await runReminders(env);
      return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/send-invoice' && req.method === 'POST') {
      return sendInvoice(req, env);
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Bookkeeper. Static assets binding missing.', { status: 500 });
  }
};

// ──────────────────────────────────────────────────────────────────────
// Email an invoice PDF via Brevo. The caller must send its Supabase access
// token (Authorization: Bearer <token>); we verify it and use the verified
// account's email as the sender, so the endpoint can't be used to send mail
// on behalf of arbitrary addresses.
async function sendInvoice(req, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  if (!env.BREVO_API_KEY) return json({ error: 'Email is not configured (missing BREVO_API_KEY).' }, 500);

  // 1) Authenticate the caller via their Supabase token.
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'Not signed in.' }, 401);
  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!userRes.ok) return json({ error: 'Session expired — sign in again.' }, 401);
  const user = await userRes.json();
  const senderEmail = (user && user.email || '').trim();
  if (!senderEmail) return json({ error: 'Your account has no email address.' }, 400);

  // 2) Read the request.
  let b;
  try { b = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const to = (b.to || '').trim();
  const subject = (b.subject || '').trim() || 'Invoice';
  const body = (b.body || '').toString();
  const fromName = (b.fromName || '').toString().trim();
  const pdfBase64 = (b.pdfBase64 || '').toString();
  const filename = (b.filename || 'Invoice.pdf').toString();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: 'A valid recipient email is required.' }, 400);
  if (!pdfBase64) return json({ error: 'Missing invoice PDF.' }, 400);

  // 3) Hand off to Brevo. From = the verified account email; Reply-To too so
  // replies reach the business inbox.
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const payload = {
    sender: { email: senderEmail, name: fromName || senderEmail },
    to: [{ email: to }],
    replyTo: { email: senderEmail, name: fromName || senderEmail },
    subject,
    textContent: body || ' ',
    htmlContent: '<div style="font-family:sans-serif;white-space:pre-wrap">' + (esc(body) || '&nbsp;') + '</div>',
    attachment: [{ content: pdfBase64, name: filename }]
  };
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('brevo send failed', r.status, detail);
    return json({ error: `Email service error (${r.status}). ${detail.slice(0, 300)}` }, 502);
  }
  return json({ ok: true });
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
