# CLAUDE.md — Bookkeeper

Guidance for Claude Code working in this repo. Read this before editing.

Bookkeeper is a free, **single-file** accounting web app for a solo computer-repair
business (Case Johnston Computer Repair, LLC). It runs as an installable **iPhone PWA**
— think "lightweight QuickBooks": invoices, customers, expenses, accounts, mileage,
payments, recurring items, receipts, reports, jobs/calendar, and push reminders.

Current version: **125** (see `version.json`).

---

## The one rule that breaks everything if ignored

**Every shippable change bumps the number in `version.json` AND ships `index.html`
+ `version.json` together.** `version.json` is how already-open apps detect updates
(`checkForUpdate()` polls it on launch and every 2 min; it compares to localStorage
`bk-installed-version` and prompts a reload). Forget the bump → users never get the
new `index.html`.

Pure docs/worker-config changes (no client-visible behavior change) don't need a
version bump.

---

## Stack & constraints

- **Frontend:** ONE file — `index.html`. All HTML, CSS, JS inline. No build step,
  no framework, no bundler. A `<style>` block near the top, then HTML (pages +
  modals), then ONE big `<script>` at the bottom (~3000 lines total).
- **Backend:** Supabase (hosted Postgres + Auth + Storage, Row Level Security on).
- **Hosting:** ONE Cloudflare Worker named `bookkeeper` (`wrangler.toml`).
  Serves `index.html`, `sw.js`, `manifest.json`, `version.json`, and the icons
  as static assets via the `[assets]` binding; also runs a cron-triggered push
  reminder loop (`scheduled` handler) and a `/run?key=MANUAL_KEY` test endpoint.
  Auto-deploys on push to `main` via Cloudflare Workers Builds.
- **Service worker:** `sw.js` (root) registered by the client; handles `push`
  events (shows a generic notification) and `notificationclick` (focuses / opens
  the app).
- **Client:** standalone PWA on iPhone (Add to Home Screen → full screen).

Loaded from CDN at runtime (NOT bundled): `@supabase/supabase-js v2`, `jspdf 2.5.1`,
`html2canvas 1.4.1`. Fonts (Google): Plus Jakarta Sans (UI), JetBrains Mono
(numbers/labels), DM Serif Display (wordmark).

Supabase project URL + anon key are hard-coded in `index.html` (search `supabase.co`
/ `createClient`). RLS policies limit rows to `auth.uid() = user_id` (and
`id = auth.uid()` for `profiles`).

Worker secrets (Cloudflare dashboard → Workers & Pages → `bookkeeper` → Settings
→ Variables and Secrets):

| Name | Type | Used for |
|---|---|---|
| `SUPABASE_URL` | plaintext (in wrangler.toml) | push cron Supabase REST calls |
| `SUPABASE_SERVICE_KEY` | secret | push cron Supabase REST calls (bypasses RLS) |
| `VAPID_PUBLIC_KEY` | plaintext (in wrangler.toml) | Web Push signing |
| `VAPID_PRIVATE_KEY` | secret | Web Push signing |
| `VAPID_SUBJECT` | plaintext (in wrangler.toml) | Web Push contact `mailto:` |
| `MANUAL_KEY` | secret | gates the `/run` test endpoint |

Cron schedule (in `wrangler.toml`): `* * * * *` (every minute) — keeps reminder
latency under ~60 seconds.

---

## Validating changes (no build, sandbox is offline)

CDN domains, Supabase, and the Cloudflare Worker are **blocked** in the sandbox, so
the full app can't run here. Validate JS syntax/CSS balance via Node:

```bash
node -e "const h=require('fs').readFileSync('index.html','utf8'); \
  const s=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).reduce((a,b)=>a.length>b.length?a:b,''); \
  require('fs').writeFileSync('/tmp/app.js',s)"
node --check /tmp/app.js
```

There are multiple `</style>` tags — the **first** (~line 540) closes the main
style block; the others are inside JS report/print HTML templates. Target the
right one.

---

## Architecture & the core pattern

- Global **`cache`** object holds all data: `cache.customers`, `.invoices`,
  `.expenses`, `.accounts`, `.trips`, `.recurring`, `.jobs`. (`vendors` was
  removed — do not reintroduce it.) `loadAllData()` fills it on login via a
  `safe()` wrapper that catches errors → empty arrays (so the app keeps working
  before a new SQL migration is run). **`profile`** holds the user's settings row.
- Every entity follows: **`render<Thing>()`** draws the list → **`open<Thing>Modal()`**
  opens the add/edit form → **`save<Thing>()`** upserts to Supabase AND updates
  `cache` in place → **`delete<Thing>()`** removes from both. Re-render after writes.
- `showPage(page, el)` switches pages, sets the title, populates `#topbar-actions`,
  and calls `updateTopbarLogo()`. `currentPage` tracks the active page.
- `rerenderCurrentView()` is called on resize/orientationchange so mobile/desktop
  layouts swap correctly.

### The usual task — add a field to an entity
1. Add the `<input>`/`<select>` to that entity's modal HTML.
2. Set its `.value` in `open<Thing>Modal()` (with a sane default for the "new" branch).
3. Include it in the row object in `save<Thing>()`.
4. If it's a new DB column, give the user the `alter table ... add column if not
   exists ...` to run in the Supabase SQL Editor (they run migrations manually).
   The app must keep working **before** the SQL runs (see `safe()`).
5. Bump `version.json`. Ship both files.

---

## Database

Tables: `profiles, customers, invoices, expenses, accounts, trips, recurring, jobs`.

Columns added beyond the base schema (run in Supabase SQL Editor if a save errors
with "could not find the X column in the schema cache"):

```sql
-- profiles: company, address, email, phone, currency, base_address, logo,
--   push_subscription. (tax + terms columns exist but their Settings fields
--   were removed; tax is saved as 0. logo = downscaled PNG data URL, NOT
--   Storage. routes_api_key column also exists, dating from when mileage used
--   Google APIs — no longer read; safe to drop.)
alter table profiles add column if not exists base_address text;
alter table profiles add column if not exists logo text;
alter table profiles add column if not exists push_subscription jsonb;

-- invoices: payments + mileage
alter table invoices add column if not exists amount_paid numeric default 0;
alter table invoices add column if not exists paid_date date;
alter table invoices add column if not exists payment_method text;
alter table invoices add column if not exists miles numeric default 0;
alter table invoices add column if not exists trips integer default 0;
alter table invoices add column if not exists total_miles numeric default 0;

-- expenses: reimbursed flag, invoice link, receipt photo
alter table expenses add column if not exists reimbursed boolean default false;
alter table expenses add column if not exists invoice_id uuid references invoices(id) on delete cascade;
alter table expenses add column if not exists receipt_path text;

-- customers: per-customer round-trip miles (user-typed; no more auto-calc)
alter table customers add column if not exists miles numeric;

-- trips (mileage log): link back to the invoice
alter table trips add column if not exists invoice_id uuid references invoices(id) on delete cascade;
alter table trips add column if not exists invoice_number text;

-- recurring invoices/expenses
create table if not exists recurring (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, kind text, label text,
  frequency text default 'monthly', next_date date,
  active boolean default true, data jsonb, created_at timestamptz default now()
);
-- + RLS policy "recurring_own" for all using (auth.uid() = user_id)

-- jobs (calendar entries with optional push reminders)
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  date date not null,
  time time,
  customer_id uuid references customers(id) on delete set null,
  notes text,
  done boolean default false,
  repeat_monthly boolean default false,
  remind_minutes integer,    -- null = no push reminder; else "N min before"
  reminded_at timestamptz,   -- set by Worker cron when a reminder fires (or window expires)
  created_at timestamptz default now()
);
alter table jobs enable row level security;
create policy "jobs_own" on jobs for all using (auth.uid() = user_id);

-- Storage: private bucket "receipts" + RLS policies scoped to
-- (storage.foldername(name))[1] = auth.uid()::text  (select/insert/delete)
```

Note: Supabase caches the schema; after an ALTER, saves may keep failing for ~a
minute until the cache refreshes.

---

## Features (current intent)

- **Dashboard:** 4 stat cards (Total Revenue, Total Expenses, Net Profit,
  Outstanding) + Upcoming card (next 30 days of jobs / unpaid invoices /
  recurring runs) + collapsible Calendar (month-grid view) + 6-month
  Income-vs-Expenses bar chart + Recent Invoices/Expenses + collapsible
  Reports.
- **Jobs / Calendar:** add jobs (title + date + optional time + optional
  customer link + optional `remind_minutes` push reminder). The Calendar card
  on the dashboard shows a month grid with color-coded chips (violet=job,
  amber=invoice due, cyan=recurring). Tap a day to select; tap again (or the
  + button) to add a job pre-filled with that date. "Repeats monthly" checkbox
  auto-generates 11 future copies on save (dedup by date+title+customer_id);
  un-checking offers to delete the series.
- **Push reminders:** per-job, fires at `remind_minutes` before the job's
  wall-clock time in America/Denver. Worker cron runs every minute; query
  predicate `done=false AND remind_minutes IS NOT NULL AND reminded_at IS NULL`;
  for each match, computes `triggerAt = jobUtc - remind_minutes*60_000`; if
  `now >= triggerAt` and `now < triggerAt + 30 min`, sends a payload-less Web
  Push and stamps `reminded_at`. If `now > triggerAt + 30 min` (window blown),
  stamps `reminded_at = triggerAt` so the row stops matching the predicate.
  `sw.js` shows a generic "Bookkeeper · upcoming job — tap to open"
  notification because we don't ship encrypted payloads (RFC 8291 is
  heavyweight). User enables via Settings → Notifications → Enable on this
  device; chatty debug pane surfaces each step's outcome.
- **Invoices:** status tabs (All/Draft/Sent/Paid/Overdue) + search; pro PDF/print
  modeled on the business Word template; numbers auto-generate **YYNN** (2-digit
  year + sequence, editable). Share builds a real PDF via an off-screen 780px
  clone + native share sheet; Print uses a hidden iframe + native dialog.
- **Payments:** `amount_paid`/`paid_date`/`payment_method`; partial payments;
  `balanceDue(inv)` and `effectiveStatus(inv)` (fully-paid → paid; past-due →
  overdue). Outstanding = sum of balances (excl. drafts). PDF shows Paid/Balance
  Due when partly paid.
- **Recurring (invoices/expenses):** `recurring` table; `processRecurring()` runs
  on boot, catches up missed periods, generates invoices as DRAFTS and auto-posts
  expenses. Keep monthly billing day ≤ 28 (JS month rollover).
- **Expenses:** user-editable categories (localStorage `bk-expense-cats`);
  "Reimbursed by customer" flag excludes from net profit / P&L / chart (green
  Reimbursed badge); "Link to Invoice"; receipt photo upload to private
  `receipts` bucket (signed URLs; paperclip indicator; removed on delete).
- **Invoice ↔ expense linking (both ways):** customer-expense rows on an invoice
  are saved as reimbursed expenses linked by `invoice_id`, appear as invoice line
  rows, and add to the invoice total. `invoiceRevenue(inv)` = `inv.total` minus
  linked reimbursed expenses (pass-throughs don't count as income; Outstanding
  still shows the full amount owed). Deleting a linked expense recomputes invoice
  totals.
- **Mileage:** per-customer round-trip miles is **user-typed**. The customer
  modal has a **Maps** button that opens the address in the Google Maps app
  via universal link (`https://www.google.com/maps/search/?api=1&query=...`).
  User reads the distance, types it back. Per-invoice mileage: Trips Made
  (default 0) × customer round-trip miles → Total Miles; saving syncs a linked
  trip in the Mileage log. **Auto-calculation was removed** — earlier versions
  tried Google Routes API, Distance Matrix API, Places API, US Census Geocoder
  + OSRM, all gave numbers that drifted from the Maps app, and Google does not
  expose the consumer Maps routing engine to developers. Don't reintroduce the
  auto-calc.
- **Settings → Business Logo:** stored as a downscaled PNG data URL on
  `profiles.logo` (NOT Storage — data URLs render in the html2canvas PDF
  without tainting and sync across devices). Saves immediately on pick. Shows
  in the desktop sidebar (replaces the Bookkeeper book icon), invoice header,
  and report header. Also rewrites `<link rel="icon">` and
  `<link rel="apple-touch-icon">` so it's the favicon + Home Screen icon
  (already-installed PWAs need remove + re-add — iOS caches Home Screen icons).
- **Reports:** Profit & Loss and Expense Summary, same invoice-style PDF + print
  pipeline.

---

## Styling / UX rules to preserve

- **Income is ALWAYS green, expenses red** (charts, amounts, badges). Non-negotiable.
- **Modern revamp design system (v90+):** violet gradient accent (`--accent` →
  `--accent2`), frosted-glass top bar / bottom nav / modal / toast (`--glass` +
  `backdrop-filter`), soft deep cards (`--radius-lg`, `--shadow`), pill
  buttons/badges (`--radius-pill`) with tactile `:active` scale, tinted
  radial-gradient body canvas, tabular figures app-wide
  (`font-variant-numeric: tabular-nums`). The "MODERN REVAMP" CSS block sits
  just before the **first** `</style>`. Mono uppercase micro-labels + tabular
  numerals are the signature.
- **No double card layering on list pages.** Wrappers are
  `class="card list-card"`; on mobile `.list-card` is flattened (transparent,
  no border/shadow) so each row is its own card. Row cards get the shadow via
  `.list-card table tr, .cust-card`. If you add a header/filter needing a card
  background, keep it in a real `.card` and render rows OUTSIDE it.
- **Top bar action buttons must wrap their label in `<span>`** — the mobile
  rule `#topbar-actions .btn span{display:none}` collapses them to icon-only
  so the gear + theme toggle don't get pushed off-screen.
- **Lists re-render on rotation/breakpoint change** (`rerenderCurrentView` on
  resize/orientationchange) so landscape uses the desktop table and portrait
  uses cards. Reuse this when adding a list page.
- Dashboard recent tables are 3 columns on purpose (amounts must fit); don't
  add a 4th. Tables can't take reliable padding on mobile — wrap in a padded div.
- Toasts/install hint sit above the bottom nav via
  `calc(62px + env(safe-area-inset-bottom,0px) + ...)` — never a flat bottom
  offset.
- Keep Settings/help captions (small, `var(--text3)`) accurate when behavior
  changes.

---

## PDF / print

- Two builders share a pattern: `buildInvoicePDF` and `buildReportPDF`. Both
  render an **off-screen 780px-wide clone** (so tables keep columns instead of
  mobile-stacking), then html2canvas → jsPDF, letter size, multi-page.
- `print*` functions render into a hidden iframe + native print dialog;
  `*Fallback` open the PDF blob if printing is blocked.
- The global mobile table-stacking rule is scoped to `.page table`, with
  overrides so invoice/report print areas keep real columns. Reuse this scoping
  for new printables.

---

## Gotchas learned the hard way

- **localStorage** works in the real PWA but is blocked in sandbox/preview —
  anything using it (theme `bk-theme`, categories `bk-expense-cats`,
  `bk-installed-version`, `bk-hide-install-hint`) won't persist in preview,
  only on the deployed app.
- **Temporal-dead-zone:** a function called early must not reference a
  top-level `const`/`let` declared later. Inline small constant lists in the
  function or declare before use.
- **Re-render-on-keystroke kills the keyboard:** per-input handlers must update
  values in place (e.g. `calcLine` edits the amount cell by id + recomputes
  totals) — never re-render the whole list on input, or mobile keyboards
  dismiss after each digit.
- **Write back DB ids immediately after insert** (e.g. `item.id = r.data.id`).
  Newly-saved rows that keep a temp id silently break later cleanup-by-id.
- **Light + dark must both be checked** after any color/token change — the
  accent and surfaces differ per theme.
- **Push notifications need iOS 16.4+ AND Add-to-Home-Screen installation.**
  In-Safari-tab subscribe attempts silently fail. The Settings → Notifications
  → Enable button has a debug pane that surfaces each step's outcome.
- **Don't reintroduce the mileage auto-calc.** We exhausted Google Routes API,
  Distance Matrix API, Places API, US Census Geocoder + OSRM; none match the
  consumer Maps app. The Maps button (universal link to maps.google.com search)
  is the resolved design.

---

## Deploy & install

- Push to GitHub `main`; Cloudflare Workers Builds auto-deploys the
  `bookkeeper` Worker (per `wrangler.toml`). The Worker serves `index.html`
  + assets via the `[assets]` binding and runs the cron-triggered push
  reminder loop.
- `.assetsignore` keeps `wrangler.toml`, `worker/` source, `.git/`, and `*.md`
  docs out of the asset bundle.
- iPhone: open the URL in Safari → Share → Add to Home Screen → launch from
  the icon.
- App icon: `icon.png` (512) + `icon-180.png` (180, Apple touch), referenced
  by `manifest.json` and the `apple-touch-icon` tag. iOS caches the icon at
  install time; changing it requires remove + re-add to the Home Screen.
- **VAPID keys:** generated once via `worker/vapid-keygen.html` (open the
  file locally). Public key lives as a plaintext var in `wrangler.toml`;
  private key is a Worker secret. Rotating requires re-subscribing every
  device.

---

## Business details (live in `profiles`, editable in Settings — not hard-coded)

```
Company:  Case Johnston Computer Repair, LLC
Address:  111 W McGowan St, Plains, MT 59859
Phone:    (406) 249-1466
Email:    casejohnstoncomputerrepair@hotmail.com
```

Montana has no state sales tax — tax is saved as 0 and tax rows are hidden on
invoices.
