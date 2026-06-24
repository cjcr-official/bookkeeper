// Bookkeeper Worker.
//   /run?key=...  — push reminder cron trigger (per-job, every minute)
//   /geocode?address=... — US Census Geocoder → OSM Photon fallback
//   /route?oLat=...&oLng=...&dLat=...&dLng=... — OSRM driving distance
//   anything else → static assets (index.html, sw.js, manifest.json, version.json, icons)
//
// Required Worker secrets (push notifications only):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//   VAPID_SUBJECT, MANUAL_KEY
//
// No Google API key is required for mileage — Census + OSRM are free, no key.

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
    if (url.pathname === '/geocode') return geocodeProxy(url);
    if (url.pathname === '/route')   return routeProxy(url);
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Bookkeeper. Static assets binding missing.', { status: 500 });
  }
};

// ──────────────────────────────────────────────────────────────────────
// Geocode: address → lat/lng. US Census first (authoritative TIGER data,
// knows real rural addresses), Photon (OSM) fallback for non-US.
async function geocodeProxy(url) {
  const address = url.searchParams.get('address');
  if (!address) return jres({ error: 'Missing address' }, 400);

  try {
    const r = await fetch('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
      + '?address=' + encodeURIComponent(address)
      + '&benchmark=Public_AR_Current&format=json');
    if (r.ok) {
      const j = await r.json().catch(()=>null);
      const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
      if (m && m.coordinates) return jres({
        status: 'OK',
        results: [{
          location: { lat: m.coordinates.y, lng: m.coordinates.x },
          formatted_address: (m.matchedAddress || address) + ' (US Census)',
          source: 'census'
        }]
      });
    }
  } catch (_) {}

  try {
    const r = await fetch('https://photon.komoot.io/api?limit=1&q=' + encodeURIComponent(address));
    if (r.ok) {
      const j = await r.json().catch(()=>({}));
      const f = j.features && j.features[0];
      if (f && f.geometry) {
        const [lng, lat] = f.geometry.coordinates;
        const fa = [f.properties.name, f.properties.city, f.properties.state, f.properties.postcode, f.properties.country].filter(Boolean).join(', ') + ' (OSM)';
        return jres({ status: 'OK', results: [{ location: { lat, lng }, formatted_address: fa, source: 'osm' }] });
      }
    }
  } catch (_) {}

  return jres({ status: 'ZERO_RESULTS', error_message: 'No geocoder matched that address' }, 404);
}

// Route: lat/lng pair → driving distance in meters via the OSRM demo router.
// Matches Google Maps app distances within ~10% on short trips and uses the
// shortest road path (Google's Routes/DM APIs default to fastest-via-highways).
async function routeProxy(url) {
  const oLat = url.searchParams.get('oLat'), oLng = url.searchParams.get('oLng');
  const dLat = url.searchParams.get('dLat'), dLng = url.searchParams.get('dLng');
  if (!oLat || !oLng || !dLat || !dLng) return jres({ error: 'Missing oLat/oLng/dLat/dLng' }, 400);
  try {
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/'
      + oLng + ',' + oLat + ';' + dLng + ',' + dLat + '?overview=false');
    if (!r.ok) return jres({ error: 'OSRM HTTP ' + r.status }, 500);
    const j = await r.json().catch(()=>({}));
    const rt = j && j.routes && j.routes[0];
    if (!rt || typeof rt.distance !== 'number') return jres({ error: 'No driving route found' }, 500);
    return jres({ meters: rt.distance });
  } catch (e) {
    return jres({ error: String(e && e.message || e) }, 500);
  }
}

function jres(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });
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
