# Bookkeeper Worker

One Cloudflare Worker (`bookkeeper`, per `wrangler.toml`) that does two jobs:

1. **Serves the app** — `index.html`, `sw.js`, `manifest.json`, `version.json`,
   and icons are bundled as static assets via the `[assets]` binding.
2. **Fires push reminders** — a cron trigger runs every minute, checks for
   jobs whose `remind_minutes` window is open, and sends a Web Push to the
   user's subscribed device. The notification text comes from `sw.js`
   (payload-less push — no per-recipient encryption needed).

Deploy happens automatically via Cloudflare Workers Builds whenever you push
to `main` on GitHub.

---

## One-time setup

### 1. SQL migrations (Supabase → SQL Editor)

```sql
alter table profiles add column if not exists push_subscription jsonb;
alter table jobs     add column if not exists remind_minutes integer;
alter table jobs     add column if not exists reminded_at    timestamptz;
alter table jobs     add column if not exists repeat_monthly boolean default false;
```

(Plus everything else in `CLAUDE.md` → Database if starting from scratch.)

### 2. Generate VAPID keys

Open `vapid-keygen.html` in any browser (double-click the file). Click
**Generate**. You'll get a public key (safe to publish) and a private key
(secret). Rotating later requires re-subscribing every device, so save both.

### 3. Update `wrangler.toml`

The public key + subject already live as plaintext vars in `wrangler.toml`:

```toml
[vars]
SUPABASE_URL = "https://fnfikvnxhylpuecshtix.supabase.co"
VAPID_PUBLIC_KEY = "BERMR7TzR5rf0fQt_BcTOyOwiHIujwdr_S5dbutJhl1o_FyntPXRe7vuhx1xeACf5TqjgQLtPRpdFxfxRI0Wsfg"
VAPID_SUBJECT = "mailto:casejohnstoncomputerrepair@hotmail.com"
```

If you rotated the keypair, replace `VAPID_PUBLIC_KEY` here.

### 4. Connect Cloudflare Workers Builds to the GitHub repo

Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to Git**.
Select the `cjcr-official/bookkeeper` repo. Project name: `bookkeeper`. Build
command empty; deploy command `npx wrangler deploy`. Click Deploy. Cloudflare
reads `wrangler.toml` (worker name `bookkeeper`, assets binding, cron) and
sets everything up.

### 5. Add the secrets

Worker → **Settings → Variables and Secrets** → Add:

| Name                   | Type      | Value |
|------------------------|-----------|-------|
| `SUPABASE_SERVICE_KEY` | **Secret**| service_role key from Supabase → Project Settings → API |
| `VAPID_PRIVATE_KEY`    | **Secret**| the private key from step 2 |
| `MANUAL_KEY`           | **Secret**| any random string (gates `/run?key=...`) |

⚠️ The `service_role` key bypasses RLS — treat it like a password.

### 6. iPhone — install and subscribe

- Open the Worker's URL (e.g. `https://bookkeeper.<your-subdomain>.workers.dev/`)
  in Safari → Share → **Add to Home Screen**.
- Open the app from the Home Screen icon (not Safari).
- **Settings → Notifications → Enable on this device.** Accept the iOS prompt.
  The debug pane logs each step; "Saved ✓ — you are subscribed" means it took.

### 7. Test the push

In any browser:

```
https://bookkeeper.<your-subdomain>.workers.dev/run?key=<MANUAL_KEY>
```

Returns JSON like `{"checked":N,"fired":N,"missed":N,"failed":N}`. Create a
test job with reminder = "At time of job" and a date+time a couple minutes
out; hit `/run` again after the trigger; the phone should buzz.

---

## How the push code works

- **Cron:** `* * * * *` (every minute), in `wrangler.toml`.
- **Per fire:** query `jobs?done=eq.false&remind_minutes=not.is.null&reminded_at=is.null`.
  For each job, compute `triggerAt = jobLocalDateTime - remind_minutes` in
  `America/Denver`. If `now >= triggerAt` AND `now < triggerAt + 30 min`,
  send a detailed Web Push (`POST` to the subscription endpoint with a
  VAPID-signed `Authorization` header and an RFC 8291 encrypted body naming the
  item) and stamp `reminded_at = now()`.
- If the window has blown past (now > triggerAt + 30 min), stamp
  `reminded_at = triggerAt` anyway so the row stops matching the query.
- If the push returns 404 / 410, the subscription is dead; clear it from the
  profile.

## Notes

- iOS 16.4+ required; Bookkeeper must be installed to Home Screen.
- Detailed push — the body is RFC 8291 (aes128gcm) encrypted with the
  subscription's `p256dh`/`auth` keys so the notification names the item.
  `sendWebPush` falls back to a payload-less push if encryption fails or the
  push service rejects the encrypted body, so a reminder always lands.
- VAPID JWT is signed with Web Crypto using the keypair imported as a JWK
  (no PKCS#8 wrapping needed — see `makeVapidJwt` in `push-cron.js`).
- The Worker no longer calls any Google APIs. Mileage is user-typed; the
  customer modal's Maps button opens `https://www.google.com/maps/search/?api=1&query=...`
  in a new tab (iOS deep-links to the Maps app via universal link).
