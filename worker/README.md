# Bookkeeper Push Cron — Cloudflare Worker

Sends one daily Web Push notification per user who has invoices, recurring
items, or jobs due within the next 2 days. Free tier: well under Cloudflare's
free Worker quota and Mailchannels-style cost is zero.

## One-time setup

### 1. Generate a VAPID keypair

Open `vapid-keygen.html` in any browser (just double-click the file). Click
**Generate**. You'll get a public key (safe to publish) and a private key
(secret). Save both somewhere you won't lose them — they're not regenerable
without re-subscribing every device.

### 2. Add the push column to Supabase

In Supabase → SQL Editor, run:

```sql
alter table profiles add column if not exists push_subscription jsonb;
```

### 3. Paste the public key into `index.html`

Find the line near the top of the `<script>`:

```js
const VAPID_PUBLIC_KEY = '';
```

Paste the **public** key between the quotes. Commit + push so it goes live.

### 4. Create the Cloudflare Worker

In the Cloudflare dashboard → **Workers & Pages** → **Create** → **Worker**.
Name it `bookkeeper-push`. Open the editor and replace the default code with
the contents of `push-cron.js`. Click **Save and Deploy**.

### 5. Set the Worker variables and secrets

In the Worker's **Settings → Variables and Secrets**, add:

| Name                   | Type      | Value |
|------------------------|-----------|-------|
| `SUPABASE_URL`         | Plaintext | `https://fnfikvnxhylpuecshtix.supabase.co` |
| `SUPABASE_SERVICE_KEY` | **Secret**| service_role key from Supabase → Project Settings → API |
| `VAPID_PUBLIC_KEY`     | **Secret**| the public key from step 1 |
| `VAPID_PRIVATE_KEY`    | **Secret**| the private key from step 1 |
| `VAPID_SUBJECT`        | Plaintext | `mailto:casejohnstoncomputerrepair@hotmail.com` |
| `MANUAL_KEY`           | **Secret**| any random string (used to test by visiting `/run?key=...`) |

⚠️ The `service_role` key bypasses RLS — treat it like a password.

### 6. Add the cron trigger

In the Worker's **Settings → Triggers → Cron Triggers**, add:

```
0 14 * * *
```

That's 14:00 UTC daily = **08:00 MDT / 07:00 MST**. Tweak for your timezone:
[crontab.guru](https://crontab.guru/).

### 7. Subscribe your iPhone

- Make sure you've installed Bookkeeper to the Home Screen (Safari → Share → Add to Home Screen). Already-installed? Force-refresh once after the v99 deploy.
- Open the app from the Home Screen.
- **Settings → Daily Reminder Push → Enable on this device.** Accept the iOS permission prompt.
- That's it. You should see "Enabled on this device".

### 8. Test it

In your browser, visit:

```
https://bookkeeper-push.<your-subdomain>.workers.dev/run?key=<MANUAL_KEY>
```

You'll get a JSON summary (`sent`, `skipped`, `cleared`). If you have anything
due in the next 2 days, you should see the notification land on the phone
within a few seconds.

## Notes

- **iOS 16.4+ required**, and Bookkeeper must be installed to the Home Screen (not just open in Safari). The Settings status will say why if it can't enable.
- The push is payload-less — the notification text is hardcoded in `sw.js`. This keeps the Worker simple (no per-recipient payload encryption).
- Expired subscriptions (HTTP 404/410) are cleared automatically.
- The Worker is idempotent: re-running the same day won't send duplicate pushes unless you have new due items.
