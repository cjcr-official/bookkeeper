// Bookkeeper push cron — Cloudflare Worker.
// Once a day, looks at every user with a push subscription saved, checks
// whether they have invoices / recurring items / jobs due in the next 2 days,
// and sends a "you have items due — open the app" Web Push.
//
// Deployment: see worker/README.md.
//
// Required env vars (Worker → Settings → Variables and Secrets):
//   SUPABASE_URL          (plain text)   https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY  (secret)       service_role key from Supabase API settings
//   VAPID_PUBLIC_KEY      (secret)       65-byte uncompressed P-256 point, base64url
//   VAPID_PRIVATE_KEY     (secret)       32-byte private scalar, base64url
//   VAPID_SUBJECT         (plain text)   mailto:you@example.com
//   MANUAL_KEY            (secret)       any random string; lets you trigger a run via GET /run?key=...
//
// Cron trigger (Worker → Triggers): "0 14 * * *"  = 14:00 UTC daily (08:00 MDT / 07:00 MST).
// Adjust the cron expression for your timezone.

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyPush(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/whoami') {
      // TEMP DEBUG — remove after diagnosing the MANUAL_KEY mismatch
      const sent = url.searchParams.get('key') || '';
      const stored = env.MANUAL_KEY || '';
      const hash = async (s) => {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
        return Array.from(new Uint8Array(buf)).slice(0, 6).map(b => b.toString(16).padStart(2,'0')).join('');
      };
      return new Response(JSON.stringify({
        storedKeyLength: stored.length,
        storedKeyHash6: await hash(stored),
        sentKeyLength: sent.length,
        sentKeyHash6: await hash(sent),
        match: stored === sent,
        supabaseUrlSet: !!env.SUPABASE_URL,
        supabaseServiceKeySet: !!env.SUPABASE_SERVICE_KEY,
        vapidPublicKeySet: !!env.VAPID_PUBLIC_KEY,
        vapidPrivateKeySet: !!env.VAPID_PRIVATE_KEY,
        vapidSubject: env.VAPID_SUBJECT
      }, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/run' && url.searchParams.get('key') === env.MANUAL_KEY) {
      const summary = await runDailyPush(env);
      return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Bookkeeper push cron. Set MANUAL_KEY and GET /run?key=... to trigger a test run.');
  }
};

async function runDailyPush(env) {
  const profiles = await supaGet(env, 'profiles?push_subscription=not.is.null&select=id,push_subscription');
  if (!profiles.length) return { sent: 0, skipped: 0 };
  const todayStr = new Date().toISOString().slice(0,10);
  const horizon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0,10); // today + 2 days
  let sent = 0, skipped = 0, cleared = 0;

  for (const p of profiles) {
    const sub = p.push_subscription;
    if (!sub || !sub.endpoint) continue;

    const [invoices, recurring, jobs] = await Promise.all([
      supaGet(env, `invoices?user_id=eq.${p.id}&status=neq.draft&status=neq.paid&due=lte.${horizon}&select=id,total,amount_paid`),
      supaGet(env, `recurring?user_id=eq.${p.id}&active=eq.true&next_date=lte.${horizon}&select=id`),
      supaGet(env, `jobs?user_id=eq.${p.id}&done=eq.false&date=lte.${horizon}&select=id`)
    ]);
    const unpaidInv = invoices.filter(i => (parseFloat(i.total||0) - parseFloat(i.amount_paid||0)) > 0);
    const total = unpaidInv.length + recurring.length + jobs.length;
    if (total === 0) { skipped++; continue; }

    try {
      await sendWebPush(sub, env);
      sent++;
    } catch (e) {
      const msg = String(e && e.message || e);
      console.error('push failed for', p.id, msg);
      if (/\b(404|410)\b/.test(msg)) {
        // subscription gone — clear it so we stop trying
        await supaPatch(env, `profiles?id=eq.${p.id}`, { push_subscription: null });
        cleared++;
      }
    }
  }
  return { sent, skipped, cleared, today: todayStr };
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
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(body)
  });
}

async function sendWebPush(sub, env) {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJwt(audience, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '3600',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    }
  });
  if (!r.ok) throw new Error(`push status ${r.status} ${await r.text().catch(()=>'')}`);
}

// VAPID ES256 JWT signed with Web Crypto. Public key bytes are unpacked to
// supply x,y for a JWK import so we don't need PKCS#8 wrapping.
async function makeVapidJwt(audience, subject, pubB64, privB64) {
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = { aud: audience, exp: Math.floor(Date.now()/1000) + 12 * 3600, sub: subject };
  const b64url = s => btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));

  const pub = urlB64ToBytes(pubB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be the 65-byte uncompressed P-256 point in base64url');
  }
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: privB64,
    x: bytesToUrlB64(pub.slice(1, 33)),
    y: bytesToUrlB64(pub.slice(33, 65))
  };
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
