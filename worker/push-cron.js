// Bookkeeper push reminder worker — Cloudflare Worker.
// Cron fires every 5 minutes; for each active job with a reminder set, checks
// whether "now" is inside the reminder's fire window (job time minus N minutes,
// plus a 30 min grace). If so, sends a Web Push to the user and marks the job
// reminded so it doesn't fire again.
//
// Required env vars (Worker → Settings → Variables and Secrets):
//   SUPABASE_URL          (plain text)  https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY  (secret)      service_role key
//   VAPID_PUBLIC_KEY      (secret)      65-byte uncompressed P-256 point, base64url
//   VAPID_PRIVATE_KEY     (secret)      32-byte private scalar, base64url
//   VAPID_SUBJECT         (plain text)  mailto:you@example.com
//   MANUAL_KEY            (secret)      any random string; lets you trigger a run via GET /run?key=...
//
// Cron comes from wrangler.toml.

const TZ = 'America/Denver';
const FIRE_WINDOW_MS = 30 * 60 * 1000; // tolerate up to 30 min late

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/run' && url.searchParams.get('key') === env.MANUAL_KEY) {
      const summary = await runReminders(env);
      return new Response(JSON.stringify(summary, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    // Geocoding proxy — bypasses Google's "no browser keys" policy on the
    // Geocoding API by calling it server-side. Reads the user's Routes/Geocoding
    // key from their profile via Supabase service role.
    if (url.pathname === '/geocode') return geocodeProxy(url, env);
    // Everything else → static assets (index.html, sw.js, manifest.json, icons, version.json)
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Bookkeeper. Static assets binding missing.', { status: 500 });
  }
};

async function geocodeProxy(url, env) {
  const uid = url.searchParams.get('uid');
  const address = url.searchParams.get('address');
  if (!uid || !address) return new Response('{"error":"Missing uid or address"}', { status: 400, headers: { 'content-type': 'application/json' } });

  // 1) US Census Geocoder — free, no key, authoritative TIGER/Line data for
  //    US addresses. Where Google's dev Geocoding API silently mis-resolves
  //    rural addresses ("35 Deemer Creek Rd" → "35 Deemer Ridge Road"),
  //    Census returns the literal address with house-number-accurate coords.
  try {
    const cUrl = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
      + '?address=' + encodeURIComponent(address)
      + '&benchmark=Public_AR_Current&format=json';
    const cr = await fetch(cUrl);
    if (cr.ok) {
      const cj = await cr.json().catch(()=>null);
      const m = cj && cj.result && cj.result.addressMatches && cj.result.addressMatches[0];
      if (m && m.coordinates) {
        return new Response(JSON.stringify({
          status: 'OK',
          results: [{
            location: { lat: m.coordinates.y, lng: m.coordinates.x },
            formatted_address: (m.matchedAddress || address) + ' (US Census)',
            source: 'census'
          }]
        }), { headers: { 'content-type': 'application/json' } });
      }
    }
  } catch (_) { /* fall through to Google */ }

  // 2) Fall back to Google + OSM hybrid (international addresses, edge cases)
  try {
    const profs = await supaGet(env, `profiles?id=eq.${uid}&select=routes_api_key`);
    const key = profs && profs[0] && profs[0].routes_api_key;
    if (!key) return new Response('{"error":"No Google API key saved to this profile"}', { status: 400, headers: { 'content-type': 'application/json' } });
    // Hybrid resolver: Google Geocoding first (because it knows house numbers),
    // verify the returned road name actually matches what was typed, fall back
    // to OpenStreetMap (Photon) if Google fuzzy-matched to a similar-but-wrong
    // road. Google's dev Geocoding API silently drifts on rural addresses
    // ("Deemer Creek Rd" → "Deemer Ridge Road"); OSM has rural Montana roads
    // indexed literally.
    const roadName = extractRoadName(address);          // e.g. "Deemer Creek"
    const zipMatch = address.match(/\b(\d{5})(?:-\d{4})?\b/);
    const zip = zipMatch ? zipMatch[1] : '';
    const components = ['country:US'];
    if (zip) components.push('postal_code:' + zip);
    const gUrl = 'https://maps.googleapis.com/maps/api/geocode/json'
      + '?address=' + encodeURIComponent(address)
      + '&components=' + encodeURIComponent(components.join('|'))
      + '&key=' + encodeURIComponent(key);
    const gr = await fetch(gUrl);
    const gj = await gr.json().catch(()=>({}));
    if (gr.ok && gj.status === 'OK' && gj.results && gj.results[0]) {
      const hit = gj.results.find(rr => roadMatches(rr.formatted_address, roadName));
      if (hit) {
        return new Response(JSON.stringify({
          status: 'OK',
          results: [{ place_id: hit.place_id, formatted_address: hit.formatted_address, source: 'google' }]
        }), { headers: { 'content-type': 'application/json' } });
      }
    }
    // Google drifted (or empty). Try Photon (OSM) for the exact road.
    const photonUrl = 'https://photon.komoot.io/api?limit=5&q=' + encodeURIComponent(address);
    const pr = await fetch(photonUrl);
    if (pr.ok) {
      const pj = await pr.json().catch(()=>({}));
      const feat = (pj.features||[]).find(f => roadMatches((f.properties && (f.properties.name||'') + ' ' + (f.properties.city||'')) || '', roadName));
      if (feat) {
        const [lng, lat] = feat.geometry.coordinates;
        const fa = [feat.properties.name, feat.properties.city, feat.properties.state, feat.properties.postcode].filter(Boolean).join(', ') + ' (OSM)';
        return new Response(JSON.stringify({
          status: 'OK',
          results: [{ location: { lat, lng }, formatted_address: fa, source: 'osm' }]
        }), { headers: { 'content-type': 'application/json' } });
      }
    }
    // Neither matched the typed road. Return whatever Google gave (so the
    // caller can still show something), tagged so the toast can warn.
    if (gj.status === 'OK' && gj.results && gj.results[0]) {
      const fb = gj.results[0];
      return new Response(JSON.stringify({
        status: 'OK',
        results: [{ place_id: fb.place_id, formatted_address: fb.formatted_address + ' (approx — no exact match)', source: 'google-fuzzy' }]
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: gj.status || 'ZERO_RESULTS', error_message: gj.error_message || 'No match' }), { headers: { 'content-type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ status: 'ERROR', error_message: String(e && e.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}

// Pull the distinctive road name out of an address (the part between the
// leading house number and the street-type suffix). For "35 Deemer Creek Rd,
// Plains, MT 59859" → "Deemer Creek".
function extractRoadName(addr) {
  const m = String(addr||'').match(/^\s*\d+\s+(.+?)\s+(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace|Hwy|Highway|Loop|Trl|Trail|Sq|Square)\b/i);
  return m ? m[1].trim() : '';
}
function roadMatches(haystack, road) {
  if (!road) return true; // can't verify → don't reject
  return String(haystack||'').toLowerCase().includes(road.toLowerCase());
}

async function runReminders(env) {
  const jobs = await supaGet(env, 'jobs?done=eq.false&remind_minutes=not.is.null&reminded_at=is.null&select=id,user_id,title,date,time,remind_minutes');
  if (!jobs.length) return { checked: 0, fired: 0 };
  const now = Date.now();
  let fired = 0, missed = 0, failed = 0;
  // batch profile fetches
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
    if (reminderAt > now) continue;                          // not yet
    if (now > reminderAt + FIRE_WINDOW_MS) {                 // window blown — mark missed so we stop looking
      await supaPatch(env, `jobs?id=eq.${j.id}`, { reminded_at: new Date(reminderAt).toISOString() });
      missed++;
      continue;
    }
    const sub = subByUser[j.user_id];
    if (!sub || !sub.endpoint) continue;
    const body = j.title + (j.time ? ' · ' + j.time.slice(0,5) : '');
    try {
      await sendWebPush(sub, env, { title: 'Bookkeeper · upcoming job', body, url: '/' });
      await supaPatch(env, `jobs?id=eq.${j.id}`, { reminded_at: new Date().toISOString() });
      fired++;
    } catch (e) {
      const msg = String(e && e.message || e);
      console.error('reminder push failed', j.id, msg);
      failed++;
      if (/\b(404|410)\b/.test(msg)) {
        await supaPatch(env, `profiles?id=eq.${j.user_id}`, { push_subscription: null });
      }
    }
  }
  return { checked: jobs.length, fired, missed, failed };
}

// Convert a local wall-clock "YYYY-MM-DD" + "HH:MM" in TZ to a UTC ms timestamp.
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

// Payload-less Web Push (sw.js shows the static notification). The "_data" arg
// is reserved for when we add payload encryption (RFC 8291) later.
async function sendWebPush(sub, env, _data) {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJwt(audience, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { TTL: '3600', Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}` }
  });
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
