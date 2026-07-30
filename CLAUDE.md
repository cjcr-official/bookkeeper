# CLAUDE.md — Bookkeeper

Guidance for Claude Code working in this repo. Read this before editing.

Bookkeeper is a free, **single-file** accounting web app for a solo computer-repair
business (Case Johnston Computer Repair, LLC). It runs as an installable **iPhone PWA**
— think "lightweight QuickBooks": invoices, customers, expenses, accounts, mileage,
payments, recurring items, receipts, reports, jobs/calendar, and push reminders.

Current version: **424** (see `version.json` — that file is the source of truth).

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

## Workflow: ship automatically (owner's standing instruction)

The owner wants every completed change **merged to `main` automatically** — no
"should I merge?" prompt, ever. When work is done and verified: push the feature
branch, open a PR, and merge it to `main` (which auto-deploys via Cloudflare
Workers Builds). Then report what was merged.

**Always merge.** This is unconditional — reaffirmed by the owner directly.
There is no "but this one felt risky" exception: if a change is risky, say so
plainly in the report *after* merging, and offer the revert. Don't hold the
merge waiting for an answer, and don't ask again in a later session.

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
| `ANTHROPIC_API_KEY` | secret | no longer used (PDF statement parsing was removed); safe to drop |
| `PLAID_CLIENT_ID` | secret | Plaid bank sync (`/plaid/*` endpoints) — optional |
| `PLAID_SECRET` | secret | Plaid bank sync — the secret for the chosen `PLAID_ENV` |
| `PLAID_ENV` | plaintext (in wrangler.toml) | `sandbox` (default) or `production` |

**Bank reconciliation (Plaid only):** reconciliation happens **inline** on the
Statements (Accounts) page — no modal, no PDF upload (the PDF/pdf.js/
`/reconcile-extract`/Claude flow was removed; Plaid is the single source). The
client pulls a month's transactions from the bank, matches them against recorded
expenses + invoice payments + owner activity + gift cards + loan payments
(recorded `loans.payments`, money out; fp `l:<loanId>:<payId>`) + paid budget
bills (each `bill_paid[YYYY-MM]` occurrence at its due day for the FULL bill
amount, money out; fp `b:<billId>:<YYYY-MM>`) (amount ±$0.01, date
window), and shows matched / in-records-only / on-statement-only buckets. It writes
a per-month audit result: `profiles.audited_months` (jsonb, keyed
`{accountId: {"YYYY-MM": {passed, at}}}`) — a month "passes" when nothing is
unmatched. The page shows a 12-month grid of ✅/⚠️/· marks with ‹ › year arrows;
**tap a month to pull & reconcile it**, or use **"Check the last 12 months"**
(`plaidCheckYear`) — one ranged Plaid pull, bucketed by month, every month run
through `reconcileMatch` and stamped into the audit grid, ending on a summary of
the months that need attention (tap a chip to open one). All per-month state
persists in `profiles.plaid_recon` (there's no PDF sidecar): `manual_matches`,
`unmatch_t/r`, **`txn_edits`** (splits + amount fixes, re-applied deterministically
on every pull by `applyTxnEdits` inside `buildPlaidStmt` so match indices stay
valid), and **`skip_fps`** (records the user set aside as "not on this statement" for
that month).

**Account separation is ONE explicit source: the "Paid from" tag (`recon_bank`).**
A record clears through the account the USER said it clears through — set on a manual
match (`matchSelected` writes the tag, multi-bank only), a "Paid from" pick, or a
form's Bank field. `reconcileMatch` excludes a record from a statement ONLY when it's
tagged to a DIFFERENT bank (`recBankFor(fp) !== stmt.bankKey`), collected in the
returned `assignedAway` map so the finder shows "Paid from &lt;bank&gt;" with a Change
action. Untagged records still auto-match ANY bank (the default), so single-bank users
and untouched records are unaffected. **Auto-matches are NEVER persisted as
cross-account authority** — they re-derive fresh on every pull. This is deliberate: an
auto-match is only an amount ±$0.01 + date coincidence, and the retired `matched_fps`
system (which persisted those guesses and withheld them from other accounts, plus a
background `seedOtherBanksMatched` that reconciled every other bank to seed them) is
exactly what made business months stop balancing. **Do not reintroduce a persisted
auto-match / cross-account-inference map.** The tradeoff — a genuine cross-account
amount collision needs one manual match (which then tags the record) — is the
predictable behavior the owner asked for. `migrateReconTags()` (run once from
`loadAllData`) converts existing `manual_matches` into tags so old data keeps its
separation; weak `matched_fps` are intentionally dropped, not baked in. The matcher is
covered by `test/reconcile.test.mjs` (`node test/reconcile.test.mjs`) — extend it when
you touch `reconcileMatch`.

Cash records are NOT excluded from matching — this business deposits cash income,
so a cash-paid invoice hits the bank as a deposit and reconciles like everything
else (several cash payments deposited together match via the combo pass). A
record that genuinely never hits the bank is set aside per month via the eye-off
button (`skip_fps`).
The **"Find any record"** search (`searchOtherRecs` over
`_recState.searchPool`) covers EVERY record with its status — matched here,
matched in another month (button opens that month), set aside (cash/user, with
Restore), in this month's list, or unmatched in another month (actionable
checkbox row) — and, before typing, auto-surfaces unmatched records dated within
±18 days of the month, so "an expense is missing" always has a visible answer.
Two anti-false-alarm rules: (1) the CURRENT month stamps pass/fail like any
other month, so its grid dot shows discrepancies on load — `refreshLiveAudit`
quietly re-checks it against the bank whenever the Statements page opens
(session cache reused; failures silent) — but its on-screen status pill reads
"In progress" rather than "Needs review", since mid-month unmatched records are
usually just bank lag;
(2) an out-of-period record isn't called a stray if its own month accounts for
it — `monthAccountedFps(m)` recomputes the adjacent months' reconciles from the
session cache (fallback: their stamped audit) and such records render as
"accounted for on the <Mon> statement" instead of unmatched. Each
unmatched bank line has a labeled ⋯ menu (`openTxnMenu`) that records the line
into the books and explicit-pairs it via `manual_matches`: Add as expense
(pre-fills the expense modal; `_recPairTxn` makes `saveExpense` pair it), Payment
on an invoice (picker over `balanceDue > 0`, exact-balance match first), income
without an invoice (creates a paid invoice dated the deposit day), owner
draw/contribution, gift-card split, prior-year income/refund, **Loan payment**
(`loanPayFromTxn` → pick a loan; records a `loans.payments` row and pairs it),
**Bill payment** (`billPayFromTxn` → pick one of the statement month's unpaid
budget bills; flips `bill_paid` and pairs it),
**Reimbursement of an expense** (v474, deposits only: `reimburseFromTxn` → pick the
expense being paid back, exact-amount candidates first → `applyReimburseFromTxn`
writes a NEGATIVE expense in that expense's own category and pairs it, so the cost
nets to zero and nothing lands in revenue — same vehicle as the prior-year refund),
plus split/rejoin/fix-amount. **Anything logged from reconciliation is attributed to
the account being reconciled (v475)** — `activeReconBank()` (open statement's
`bankKey`, else `_selBank`) feeds both halves: `_recDefaultBank` pre-selects the
Expense form's "Bank account" field (`addExpenseFromTxn` sets it, then re-renders the
picker and calls `onExpBankChange()` so the account's own categories load;
`openExpenseModal` clears it so a normal open never inherits it), and `tagFromRecon(fp,
exact)` writes the same tag for the form-less actions. It never overrides a tag the
user already set, and passes `exact` for loan payments / bill months so one occurrence
can't retag its whole parent. (The Loan/Bill charge actions only appear when the user
has loans / budget bills.) **Two ways to book a customer reimbursement, never both
for the same cost:** the invoice route (bill it, link the expense via `invoice_id` +
`reimbursed`, so `invoiceRevenue` nets it out) OR the deposit route above (a negative
expense). `reimburseFromTxn` deliberately does NOT set the original's `reimbursed`
flag — that flag already removes the cost from net profit, so doing both would deduct
it twice. Matching itself never silently alters records — only the
⋯ actions the user picks write anything. The combo passes (one line ↔ several
records) cap their candidate pool at the 30 nearest-by-date so a big ledger can't
freeze the page.

**Plaid bank sync:** the reconcile card (`#rec-plaid`) sits directly on the
page. "Connect a bank" lazy-loads Plaid Link
(`cdn.plaid.com`), and the Worker mints a link token (`/plaid/link-token`),
exchanges the returned `public_token` for a long-lived `access_token`
(`/plaid/exchange`), and stores it **server-side only** in the `plaid_items` table
(RLS on, no authenticated policy → only the Worker's service key can read it; the
browser never sees the token). "Pull & reconcile" for a chosen month calls
`/plaid/transactions`, which fetches that month's **cleared** (non-pending)
transactions and maps them into the exact same `stmt` shape the PDF flow produces —
**with the sign flipped** (Plaid uses +money-out / −money-in; the app's ledger
convention is −out / +in). Pending transactions are returned separately
(`pending`, same mapped shape) and rendered as a display-only "Pending at the
bank" section (`stmt.pending`) — never matched, never part of the pass, since
banks can still change a pending line's amount/description before it settles. That `stmt` flows through `renderReconcile` unchanged, so
matching, buckets, and the audit grid all just work. Plaid statements aren't saved
as sidecars (Plaid is the live source, no PDF to archive) and carry `opening/closing
balance = null` (Plaid gives no per-month opening/closing), so the balance check is
"unknown" — a month still passes when nothing is unmatched. `PLAID_ENV=sandbox` uses
Plaid's fake test banks (free, works immediately with the client credentials); switch
to `production` once Plaid approves the account. `/plaid/disconnect` removes the item
at Plaid and drops the stored token (one bank when passed `{item_id}`, else all).
`/plaid/refresh` repairs a link **in place** (item_id preserved, so no lost
history): it checks item health and, when the login is still good, calls Plaid
`/transactions/refresh` to force a fresh bank sync (fixes stale data / a settled
transaction stuck "pending"); if the item needs a fresh sign-in it returns
`needs_reauth` so the client opens update-mode Link. The **Reconnect** button runs
this first (silent refresh) and only opens Plaid Link when `needs_reauth` — so
"Reconnect" fixes both stale-data and login-required breakage without a
disconnect/re-add.

**Per-bank nicknames (v460+):** Plaid only gives the institution name, so two
accounts at the same bank (or a generic "Your bank") are indistinguishable.
`profiles.bank_labels` (jsonb `{item_id: nickname}`) lets the user name each account;
`bankDisplayName(bank|item_id)` returns nickname → institution → "Your bank" and is
used everywhere a bank is shown (the Statements bank list, the "Paid from" picker,
the finder's "Paid from &lt;bank&gt;" chip, the restore-history confirm). A pencil on
each bank row calls `renameBank()` (a `prompt()`, matching the app's other inline
edits); when a nickname overrides the real name the row shows the institution as a
sub-line so both stay visible. Works before the migration (`bankLabels()` → `{}`).

**Multi-bank (v275+):** a user can link several banks. `/plaid/status` returns a
`banks: [{item_id, institution}]` array. `/plaid/link-token` takes an optional
`{item_id}` to mint an **update-mode** token (re-auth a bank in place, no duplicate).
The non-sensitive bank names are mirrored (comma-joined) to
`profiles.plaid_institution` for legacy UI, but `banks` is the source of truth.

**Per-bank reconciliation (v276+):** the Statements card is a **clickable list of
banks** — tapping one sets `_selBank` (the selected `item_id`), and the audit grid +
"Check all 12 months" + month taps all act on THAT bank only. `plaidSelectBank()`
must redraw the new bank's audit grid **synchronously** (`renderAuditBlock` reads the
in-memory `audited_months`, no network) before kicking off the async
`renderPlaidBlock()` — otherwise the month grid blanks out while `/plaid/status`
reloads and the Owner Activity card below pops up, then back down (v461 fix). `/plaid/transactions`
takes an optional `{item_id}` and pulls just that one bank (omit it → legacy
merge-all). Everything downstream is namespaced per bank: the session pull cache
(`_plaidCache[item_id][month]` via `bankCache()`), the audit grid (`audited_months`
keyed by `item_id`, threaded as the reconcile `acctId`/`stmt.bankKey`), and the
manual-match sidecar (`plaid_recon[item_id][month]` via `reconBucket()`). **Matching
itself stays unfiltered** — `reconcileMatch(stmt, null)` — because a record can be
paid from any bank; only the audit/persistence keys are per-bank. `migratePlaidKeys()`
does a one-time move of legacy single-bank data (audit key `'_'`, bare-month
`plaid_recon` keys) under the primary bank's `item_id` so history survives. Cross-bank
double-claims are prevented by the explicit "Paid from" tag (`recon_bank`): a record
tagged to another bank is excluded (see the account-separation note above).

**"Paid from" per-bank record tagging (v459+, multi-bank only):** the SOLE
cross-account filter on otherwise-unfiltered matching (it replaced the retired
`matched_fps` inference — see the account-separation note above). A user with 2+ banks
can tag a record to the specific bank it
clears through, stored as a flat `profiles.recon_bank` map `{fp: item_id}`
(`reconBankMap()`/`setReconBank()`). In `reconcileMatch`, a record tagged to a bank
OTHER than `stmt.bankKey` is marked used up front (dropped from this bank's lists +
auto-match pool) and collected in the returned `assignedAway` map; the finder renders
those as "Paid from &lt;bank&gt;" with a Change action. An UNTAGGED record still
matches any bank (the default), so single-bank users and untouched records are
unaffected — the feature is inert until something is tagged. The UI is gated on
`_plaidBanks.length > 1`: unmatched "in your books" rows get a **Paid from** button
(`openBankAssignMenu` → `assignRecBank`, reusing the `modal-txn-menu` shell) offering
each bank + "Any bank". The map key folds recurring records to their parent
(`reconBankKey()`: `l:<loanId>` / `b:<billId>` drop the payment/month suffix), so one
tag on a loan or bill covers all its occurrences; one-off records key by full fp.
**Exact (per-occurrence) overrides (v470+):** `recBankFor(fp)` checks the FULL fp
first and only then the folded parent, and `setReconBank(fp, itemId, exact)` writes
the full fp when `exact` is true. That's what lets ONE loan payment clear a different
account than the loan's usual one — without exact-first, tagging a single payment
would silently retag every payment on that loan. `renderReconBankPicker`/
`applyReconBankPicker` take `{exact, anyLabel}` for this (the Loan tab uses it; a
blank pick means "inherit the parent", which is why the blank option is labelled
"Same as the loan"). Non-loan records are unaffected — their exact and folded keys
are identical. The
app works before the column migration (`reconBankMap()` → `{}`).

The SAME tag is also settable up front from the forms (v464): the **Expense** and
**Invoice** editors have a "Bank account" `<select>` (`exp-recon-bank` /
`inv-recon-bank`, via `renderReconBankPicker`/`applyReconBankPicker`,
fp `e:<id>` / `p:<id>`) so a record can be attributed as it's created, not only from
the reconcile screen. New records apply the tag after insert (once they have an id).

**Making the pickers actually appear (v471).** They render whenever **≥1** bank is
known (was 2+, which hid them for single-bank users). More importantly,
`knownPlaidBanks()` alone is NOT enough: it reads `_plaidBanks` (only populated by
the Statements page) falling back to the `bk-plaid-banks` localStorage cache — and
iOS clears an installed PWA's local storage, the same reason `expense_categories`
lives on the profile. So on a fresh launch every picker saw zero banks and silently
hid itself. `ensurePlaidBanks()` fixes it: a memoized `/plaid/status` fetch that
populates `_plaidBanks` + the cache, called fire-and-forget from `loadAllData()` so
every tab has the list, and again from `renderReconBankPicker` itself (which re-draws
when the list lands) so a modal opened mid-flight still gets its field. It never
throws — no bank sync configured is a normal state. **If you add another "Paid from"
picker, gate it on `knownPlaidBanks()` and let this path fill it in; never assume the
Statements page ran first.** Setting the tag up front here is equivalent to setting it
from a manual match later — both write `recon_bank`, the single attribution source.

```sql
alter table profiles add column if not exists audited_months jsonb default '{}'::jsonb;
-- Plaid bank sync: the (non-sensitive) linked bank's name, shown in the UI.
alter table profiles add column if not exists plaid_institution text;
-- Plaid reconcile edits: Plaid statements have no saved PDF sidecar (their
-- transactions are re-pulled live), so a month's manual matches / unmatches /
-- month-override are stored here (jsonb, keyed {"YYYY-MM": {...}}) and merged back
-- into the statement on the next pull.
alter table profiles add column if not exists plaid_recon jsonb default '{}'::jsonb;
-- "Paid from" per-bank record tagging (multi-bank reconciliation). Flat map
-- {reconcile-fingerprint: item_id}: a tagged record only reconciles against that
-- bank; untagged records match any bank (the default). App works before this runs
-- (reconBankMap() falls back to {}).
alter table profiles add column if not exists recon_bank jsonb default '{}'::jsonb;
-- Per-bank nicknames so same-institution accounts are distinguishable. Flat map
-- {item_id: nickname}; bankDisplayName() falls back to institution then "Your bank".
-- App works before this runs (bankLabels() falls back to {}).
alter table profiles add column if not exists bank_labels jsonb default '{}'::jsonb;
-- Plaid access tokens live here, NOT on profiles: RLS is enabled with NO policy for
-- authenticated users, so PostgREST returns nothing to the browser — only the Worker
-- (service key) can read/write it. MULTI-BANK (v275+): the PK is item_id (unique per
-- Plaid item), so one user can have MANY rows — one per linked bank. Upsert-on-conflict
-- is keyed on item_id, so exchanging a public_token ADDS a bank (or refreshes the same
-- one on re-link); disconnect removes a single item_id (or all when none is given).
create table if not exists plaid_items (
  item_id text primary key,
  user_id uuid not null,
  access_token text not null,
  institution text,
  updated_at timestamptz default now()
);
create index if not exists plaid_items_user_id_idx on plaid_items (user_id);
alter table plaid_items enable row level security;
-- (intentionally no policy — service-key-only access)

-- MIGRATION for accounts created before v275 (single-bank plaid_items keyed on
-- user_id) → multi-bank keyed on item_id. Existing rows already carry item_id
-- (every exchange stored it), so switching the PK is safe:
--   alter table plaid_items drop constraint if exists plaid_items_pkey;
--   alter table plaid_items alter column item_id set not null;
--   alter table plaid_items add constraint plaid_items_pkey primary key (item_id);
--   create index if not exists plaid_items_user_id_idx on plaid_items (user_id);
```

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
  removed — do not reintroduce it. **`accounts` (the old chart of accounts) is
  vestigial as of v472:** its list page is long gone (`renderAccounts()` early-returns
  because nothing mounts `#accounts-table`), and the Expense form's "Account" select
  was removed — two competing "account" fields confused the owner, who wants the
  connected **Plaid bank** to be the only one. `expenses.account_id` is no longer
  written (existing values are left alone); the only live consumer is the Owner
  Activity modal. Don't add a chart-of-accounts picker back to a form — use the
  "Paid from" / bank picker.) `loadAllData()` fills it on login via a
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
-- expense_categories: user-editable spending categories (jsonb array of strings).
-- Source of truth; localStorage bk-expense-cats is now just a local cache.
alter table profiles add column if not exists expense_categories jsonb;
-- account_categories: PER-BANK-ACCOUNT category lists (multi-bank). jsonb map
-- {item_id: [categories]}. In the Expense form, picking a Bank account shows ONLY
-- that account's categories: getCategories(itemId) returns the account's own list
-- when set, else falls back to the global expense_categories. Copy-on-write — the
-- inline "Manage" panel (currentExpBank()-scoped) forks an account's list from the
-- global default on its first add/remove (saveCategories(arr, itemId)); other
-- accounts and single-bank users are untouched. App works before this runs
-- (accountCatMap() falls back to {}).
alter table profiles add column if not exists account_categories jsonb default '{}'::jsonb;
-- notify_hour: hour (America/Denver, 6–11) the recurring-due morning push fires.
alter table profiles add column if not exists notify_hour integer default 8;
-- invoice defaults (Settings → Invoice Defaults): payment window in days + a
-- user-chosen starting sequence for auto YYNN numbers. (terms already exists and
-- now also holds the default invoice notes/footer prefilled on new invoices.)
alter table profiles add column if not exists invoice_due_days integer;
alter table profiles add column if not exists invoice_start integer;
-- pay_instructions: free-text "How to pay" block (no-fee methods the user types —
-- cash/check/Zelle/etc.); printed on every invoice above the footer. No payment
-- processing, no integration, no fees — it's display-only text.
alter table profiles add column if not exists pay_instructions text;
-- time_format: how job/calendar times display app-wide — '12' (default, 12-hour
-- AM/PM) or '24' (24-hour / military). Toggled in Settings → Appearance.
alter table profiles add column if not exists time_format text default '12';
-- Per-section logo control. The business logo can be shown/hidden independently
-- per printable output, so e.g. invoices keep the logo while loan slips don't.
-- All default on (unset/null = on, so the app works before the migration runs).
--   report_logo  → P&L, Expense Summary, Budget (the financial reports). NO UI
--                  toggle any more (the Appearance row was removed) — unset/null
--                  reads as on, so these reports just print the logo. The column
--                  is still honored by reportDoc's fallback if it was ever set.
--   invoice_logo → invoice PDFs. Toggled in Settings → Sections → Invoices.
--   loan_logo    → loan payment slips & summaries. Settings → Sections → Loan.
-- reportDoc() takes a showLogo arg (falls back to report_logo when omitted, so
-- P&L/Expense/Budget are unchanged); the loan builder passes loan_logo, the
-- invoice builder gates on invoice_logo. Per-section toggles live in the Sections
-- panel: an enabled module row is tappable to expand its own settings drawer
-- (renderModuleToggles → moduleHasSettings/sectionSettingsHTML/toggleSectionLogo).
alter table profiles add column if not exists report_logo boolean default true;
alter table profiles add column if not exists invoice_logo boolean default true;
alter table profiles add column if not exists loan_logo boolean default true;

-- App lock is fully on-device (no DB): localStorage bk-lock-pin (SHA-256 hash),
-- bk-lock-len, bk-lock-cred (WebAuthn platform credential id for Face ID unlock).

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

-- customers: per-customer ONE-WAY miles (user-typed; invoices ×2 for round trip)
alter table customers add column if not exists miles numeric;

-- trips (mileage log): link back to the invoice or an expense
alter table trips add column if not exists invoice_id uuid references invoices(id) on delete cascade;
alter table trips add column if not exists invoice_number text;
alter table trips add column if not exists expense_id uuid references expenses(id) on delete set null;

-- recurring invoices/expenses
create table if not exists recurring (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, kind text, label text,
  frequency text default 'monthly', next_date date,
  active boolean default true, data jsonb, created_at timestamptz default now()
);
-- + RLS policy "recurring_own" for all using (auth.uid() = user_id)
-- recurring push reminders (one morning ping on the due date):
alter table recurring add column if not exists notify boolean default true;
alter table recurring add column if not exists reminded_date date;  -- last occurrence (next_date) we pushed for

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

-- owner_transactions: equity moves between business and personal (NOT P&L).
-- Contributions = money in (you covered a purchase from personal); draws = money
-- out (you paid yourself). Sign is derived from `kind`; amount is stored positive.
create table if not exists owner_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  date date not null,
  kind text not null,                                -- 'contribution' | 'draw'
  amount numeric not null,                           -- stored positive; sign from kind
  account_id uuid references accounts(id) on delete set null,
  note text,
  created_at timestamptz default now()
);
alter table owner_transactions enable row level security;
create policy "owner_tx_own" on owner_transactions for all using (auth.uid() = user_id);

-- store_credits: gift card / merchant credit gained from a partial return where
-- the bank wasn't credited. Reconciles against the original bank charge so the
-- books don't overstate expenses. Amount stored positive (the credit gained).
create table if not exists store_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  date date not null,
  merchant text not null,
  amount numeric not null,
  note text,
  created_at timestamptz default now()
);
alter table store_credits enable row level security;
create policy "store_credits_own" on store_credits for all using (auth.uid() = user_id);

-- time_entries: standalone punch clock (Time Clock section). A row is one punch —
-- clock_in set on Clock In, clock_out set on Clock Out (null = currently clocked in,
-- shown live in the punch card). Duration is DERIVED (clock_out − clock_in), never
-- stored, so it stays correct across phone sleep/reload. rate = the hourly rate for
-- billing (defaults from profiles.hourly_rate at punch time; editable per entry).
-- Selected entries can be billed onto a new invoice (one line each: hours × rate).
create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  clock_in timestamptz not null,
  clock_out timestamptz,
  label text,
  rate numeric,
  created_at timestamptz default now()
);
alter table time_entries enable row level security;
create policy "time_entries_own" on time_entries for all using (auth.uid() = user_id);
-- default hourly rate for the Time Clock (set on the Time page; prefills new punches)
alter table profiles add column if not exists hourly_rate numeric;

-- loans: the Loan tab's saved loans (calculator + payment tracker). Each row is one
-- loan; rate_steps holds adjustable-rate changes [{month,date,rate}] and payments the
-- recorded actual payments [{id,date,amount,note}] (jsonb, rewritten wholesale on
-- save, same pattern as budget_bills). computeLoan() amortizes it; loanActual()
-- applies the recorded payments to derive the true remaining balance. Loan payment
-- due dates also surface on the Dashboard calendar + Upcoming card.
create table if not exists loans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  amount numeric,
  rate numeric,
  term_num numeric,
  term_unit text default 'years',        -- 'years' | 'months'
  extra numeric default 0,               -- optional extra principal per month
  start_date date,                       -- first payment date (anchors the schedule + calendar)
  rate_steps jsonb default '[]'::jsonb,  -- [{month,date,rate}] ARM rate changes
  payments jsonb default '[]'::jsonb,    -- [{id,date,amount,note}] recorded payments
  created_at timestamptz default now()
);
alter table loans enable row level security;
create policy "loans_own" on loans for all using (auth.uid() = user_id);

-- Budget (paycheck bill planner). All on profiles (jsonb), no separate table:
--   pay_schedule  {freq:'biweekly'|'semimonthly'|'weekly'|'monthly', anchor:'YYYY-MM-DD'
--                  (weekly/biweekly reference payday), days:[d1,d2] (semimonthly),
--                  day:d (monthly), weekend:'before'|'after'|'none' (fixed-day
--                  schedules only — a payday landing on a weekend moves to the Friday
--                  before (default) / Monday after / stays put)}. paydaysForMonth()
--                  projects the actual paydays for the shown month; biweekly/weekly
--                  auto-produce an extra (3rd) paycheck in the months that have one.
--   budget_bills  [{id,name,due(1-31 day),date('YYYY-MM-DD'),recurring(bool),amount,
--                  reimbursed,notes}] — the bill list. recurring=true (or a legacy bill
--                  with no flag) repeats monthly and uses `due`; recurring=false is a
--                  ONE-TIME bill that shows only in `date`'s month (new bills default
--                  to one-time). Each bill is dropped on the LAST payday on/before its
--                  due date; a paycheck's total is YOUR share (amount − reimbursed),
--                  and `reimbursed` (the part someone pays back) also drives the net
--                  "you pay" hero + the "· $X back" note.
--   reimburse_label  generic label for the reimbursed portion (e.g. "Kids"); default
--                    "Reimbursed". Bills saved by rewriting the whole array + upsert
--                    (same pattern as expense_categories), so the app works before the
--                    migration runs (getBills() → []).
--   paycheck_amounts  {"YYYY-MM-DD": amount} — what you were ACTUALLY paid on that
--                     payday (keyed by the payday date). Drives the "$X left" after a
--                     paycheck's bills on the Budget page.
--   bill_paid         {"YYYY-MM": {billId: true}} — per-month paid flags (a bill
--                     recurs monthly, so "paid" is per occurrence). Green check +
--                     strikethrough on the row; also marks the calendar chip done.
alter table profiles add column if not exists pay_schedule jsonb;
alter table profiles add column if not exists budget_bills jsonb;
alter table profiles add column if not exists reimburse_label text;
alter table profiles add column if not exists paycheck_amounts jsonb;
alter table profiles add column if not exists bill_paid jsonb;

-- Storage: private buckets "receipts" and "statements" + RLS policies scoped to
-- (storage.foldername(name))[1] = auth.uid()::text  (select/insert/delete).
-- "statements" archives reconciled bank-statement PDFs; the reconcile modal can
-- upload a new one (saved here) or download/re-run a previously saved one
-- (sb.storage.from('statements').list/download under <uid>/).
```

Note: Supabase caches the schema; after an ALTER, saves may keep failing for ~a
minute until the cache refreshes.

---

## Features (current intent)

- **Dashboard:** 4 stat cards (Total Revenue, Total Expenses, Net Profit,
  Outstanding) + Upcoming card (next 30 days of jobs / unpaid invoices /
  recurring runs) + collapsible Calendar (month-grid view) + 6-month
  Income-vs-Expenses bar chart + collapsible Reports. (The Recent
  Invoices/Expenses cards were removed in v452 — the Invoices/Expenses tabs
  hold the full lists.)
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
  `now >= triggerAt` and `now < triggerAt + 30 min`, sends a Web Push and stamps
  `reminded_at`. If `now > triggerAt + 30 min` (window blown), stamps
  `reminded_at = triggerAt` so the row stops matching the predicate.
  **Detailed payloads (v335+):** `sendWebPush(sub, env, message)` encrypts the
  `{title, body, url, tag}` JSON per RFC 8291 (aes128gcm) using the stored
  subscription's `keys.p256dh`/`keys.auth` (from `sub.toJSON()`), so the push
  names the item (job title + time, recurring label + amount). `sw.js` renders
  `data.title`/`data.body` and uses a per-item `data.tag` so multiple reminders
  don't collapse into one. If encryption throws or the push service rejects the
  encrypted body, `sendWebPush` retries **payload-less** (same generic
  "items due today" fallback) so a reminder always lands — never a regression.
  User enables via Settings → Notifications → Enable on this device; chatty debug
  pane surfaces each step's outcome.
- **Recurring reminders:** in addition to jobs, the Worker cron sends one
  morning push (>= 8am Denver) on the day a recurring item comes due.
  `runRecurringReminders()` matches `active AND notify AND next_date <= today
  (Denver) AND reminded_date <> next_date`, sends the same (detailed) push,
  and stamps `reminded_date = next_date` to dedupe per occurrence (the client
  advancing `next_date` in `processRecurring()` re-arms the next one). Toggled
  per item by the "Push reminder on the due date" checkbox in the recurring
  editor (default on).
- **Notification center (in-app, v318+):** a bell in the top bar
  (`#notif-bell`) with a red unread-count badge (`#notif-badge`). Notifications
  are **derived client-side from `cache`** (no DB table) by `buildNotifications()`:
  overdue/due-soon invoices, jobs today or missed, recurring items coming due
  (`NOTIF_SOON_DAYS = 3` horizon). Each has a **stable id**; seen ids live in
  localStorage `bk-notif-seen`. `refreshNotifBadge()` (called from `showPage()`
  and on load) sets the badge to the unseen count **and mirrors it to the Home
  Screen app-icon badge via the Web Badging API** (`setIconBadge()` →
  `navigator.setAppBadge`/`clearAppBadge`, no-op where unsupported); the `sw.js`
  push handler also raises the icon badge (`self.navigator.setAppBadge`, count
  from `data.badge` or 1) so a reminder badges the icon while the app is closed,
  and the next open recomputes the exact count. `openNotifPane()` renders the
  `#modal-notifications` pane and marks all shown as seen (clearing the badge);
  a row tap dispatches to `editInvoice`/`editJob`/`openRecurringManager`.
  `initNotifications()` runs after `renderDashboard()` in all three login paths;
  it and the foreground/`pageshow`/SW-message listeners call
  `showNotificationsOnOpen()`, which **auto-opens the pane only after an actual
  push reminder the user hasn't been shown yet** — the `sw.js` push handler
  stamps a timestamp into the `bk-flags` Cache (`markPush()`) and pings open
  windows (`notifyClients()` → `postMessage {type:'bk-push'}`); the client reads
  it via `getLastPushTs()` and pops once when it exceeds `bk-push-seen-ts`
  (localStorage), then advances that marker. Fires once per foreground
  (`_notifFgShown`), and never over the app-lock screen or another open modal.
  (It no longer pops on every open — only when a reminder actually fired.)
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
- **Expenses:** list sorts by date (newest first). User-editable categories saved
  to `profiles.expense_categories` (synced/durable; localStorage `bk-expense-cats`
  is a local cache + fallback);
  "Reimbursed by customer" flag excludes from net profit / P&L / chart (green
  Reimbursed badge); "Link to Invoice"; receipt photo upload to private
  `receipts` bucket (signed URLs; paperclip indicator; removed on delete).
- **Bulk select / edit (expenses + invoices):** the topbar **Select** button on
  either list enters select mode (`bulkStart(kind)`; `_bulkMode` + `_bulkSel`).
  `renderExpenses`/`renderInvoices` read `_bulkMode` to draw a checkbox per row
  (`bulkCheckHTML`, `data-bulk-id`) instead of the per-row action buttons; a fixed
  `#bulk-bar` tracks the count with select-all / Edit / Delete / Done. `showPage`
  drops the mode on navigation. **Edit** opens `#modal-bulk-edit`, whose fields are
  built per type (`bulkExpFieldsHTML`/`bulkInvFieldsHTML`) and each default to
  "Leave unchanged" so only set fields apply (`bulkEditApply` → one `.update().in('id',
  ids)` for column fields; `setReconBankBulk` for the "Paid from" tag in one profile
  write; invoice "Paid" is per-row since `amount_paid = each total`). **Delete**
  (`bulkDelete`) mirrors the single-delete cleanup (receipts, linked trips/expenses,
  invoice retotal) with `.in('id', ids)` and one confirm.
- **Invoice ↔ expense linking (both ways):** customer-expense rows on an invoice
  are saved as reimbursed expenses linked by `invoice_id`, appear as invoice line
  rows, and add to the invoice total. `invoiceRevenue(inv)` = `inv.total` minus
  linked reimbursed expenses (pass-throughs don't count as income; Outstanding
  still shows the full amount owed). Deleting a linked expense recomputes invoice
  totals.
- **Mileage:** per-customer **one-way** miles is **user-typed** (stored in
  `customers.miles`). The customer modal has a **Maps** button that opens the
  address in the Google Maps app via universal link
  (`https://www.google.com/maps/search/?api=1&query=...`). User reads the one-way
  distance, types it back. Per-invoice mileage: Trips Made (default 0) ×
  (customer one-way × 2) → Total Miles; saving syncs a linked trip in the Mileage
  log. (The ×2 lives in `calcInvMiles`/`propagateCustomerMiles`; `customers.miles`
  itself holds the raw one-way value.) **Auto-calculation was removed** — earlier versions
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
- **A report doc is authored at 780px but ALSO rendered inline on the dashboard**,
  where a phone is ~360px. Anything in `reportDoc`'s styles has to survive both.
  `.rrow`/`.rtotal` do it with `flex-wrap` + `margin-left:auto` + `white-space:
  nowrap` on the amount — one code path, no media/container query, so the preview
  can't drift from the PDF. Don't "fix" a narrow-screen report with a viewport
  media query: `htmlToPDF` renders its 780px clone in the SAME document while the
  viewport is still phone-width, so a viewport query would corrupt the PDF too.

---

## Android / Samsung (v420+)

The app is built and tested on an installed iPhone PWA, so Android-only
behaviors are easy to break without noticing. What exists and must keep working:

- **Back button / back gesture** (`navBackTarget` / `navSync` / the `popstate`
  handler, just above the MODAL section). Android's back affordance drives
  `window.history`; with no history of our own, one press quit the installed app
  outright. Rather than mirror every UI step into history (which desyncs the
  moment a modal closes out of order) we keep **at most ONE sentinel entry**
  (`history.state.bkGuard`) parked whenever something is open, and read live DOM
  state to decide what back means: topmost open modal → close it; a
  user-expanded More group → collapse it; else walk `_pageHistory` back a page;
  else Dashboard; else don't intervene (leaving the app is correct). `navSync()`
  is coalesced onto a `setTimeout(0)` and is called from `openModal`,
  `closeModal`, `showPage`, `setNavMore`, and once after `boot()` (a reload
  preserves `history.state`, so a stale sentinel must be reconciled).
  - `showPage(page, el, fromBack)` — a back-driven call must pass `fromBack` so
    the page being left isn't re-pushed onto `_pageHistory`.
  - `data-keep-open` overlays (invoice editor, onboarding) are NOT closed by
    back — same rule the backdrop tap and Escape already follow. Back is
    swallowed with a toast instead, so an accidental One UI edge-swipe can
    neither discard the edit nor quit the app.
  - Modals with a custom closer are listed in `MODAL_CLOSERS`; add new ones
    there or back will strand their in-flight state.
- **Install:** `beforeinstallprompt` is stashed in `_deferredInstall` and drives
  a real Install button in `#install-hint`. `evaluateInstallHint()` picks the
  copy per platform (one-tap install / Samsung Internet's "Add page to" / Chrome's
  ⋮ / iOS Share sheet). iOS has no programmatic install — don't try.
- **Icons:** `icon-maskable.png` is the `purpose:maskable` entry. One UI masks
  maskable icons to the inner ~80% circle, which sliced the corners off the
  full-bleed `icon.png`. It's generated by scaling the artwork to 72% on a
  flat-background 512 canvas — regenerate the same way if the logo changes.
  A user's own logo can never become the Android launcher icon (a WebAPK builds
  it from the manifest at install time and ignores `apple-touch-icon`), which is
  why `forceUpdateAppIcon()` tells Android users the truth instead of the iOS
  remove/re-add dance.
- **Manifest:** `orientation:"any"` (was `portrait`) so Galaxy tablets and the
  Z Fold's unfolded screen work — the app already has a >768px desktop layout
  and `rerenderCurrentView()` on orientationchange. `shortcuts` long-press
  entries launch `./?go=<page>&new=1`, handled by `applyShortcutLink()`.
- **Platform strings:** use `isIOSDevice()` / `isAndroidDevice()` /
  `isSamsungBrowser()` and `bioLabel()` / `bioIcon()` — never hard-code "Face ID"
  or point a Galaxy owner at "iOS Settings". These UA checks pick WORDS only;
  never gate a capability on them when it can be feature-detected.
- **Push works from a plain Android tab** — only iOS needs Add-to-Home-Screen
  first, so that gate is `isIOSDevice()`-scoped.
- `overscroll-behavior` on `html`/`body`/`.main` suppresses Chrome's
  pull-to-refresh (a stray downward swipe used to reload the app mid-edit).
- `100dvh` alongside `100vh` on `.app` / `.auth-wrap` / `.loading-screen`:
  Android reports `100vh` as the LARGE viewport, so content sat under the URL bar.
- `touch-action:manipulation` is deliberately NOT applied to `input`/`textarea`
  (the logo-crop range slider needs the browser's own drag handling).
- **The update prompt has to be triggered differently than on iOS.** An iPhone
  standalone PWA is evicted from memory constantly, so the load-time
  `checkForUpdate()` runs on nearly every open. An Android PWA lives in the app
  switcher for days: Chrome freezes the page after a few minutes (killing the
  2-minute `setInterval`) and a bfcache restore doesn't guarantee a
  `visibilitychange`. So the check ALSO runs on `pageshow` (every show, not just
  `e.persisted`) and on `window` focus. If you add another update trigger, add it
  to all three — a check that only fires on load is effectively iOS-only.
- **`doUpdate()` must not unregister the service worker.** `sw.js` caches
  nothing, so unregistering bought zero freshness, while on Android it tore down
  the push subscription (reminders dead until the next boot re-subscribed) and
  dropped the worker that makes the app an installed WebAPK. It calls
  `registration.update()` instead, and preserves the `bk-flags` cache (that holds
  the "a push arrived" marker, not content).
- **Settings → About** shows running vs. latest version with a manual check —
  keep it working, it's the only way to tell a stuck install from a stale one
  without a debugger attached to the phone.
- **Printing (`printDocInIframe`) has three Android rules**, all learned from
  reports printing blank on a Galaxy while iPhone was fine:
  1. The print iframe needs **real dimensions parked off-screen** — never
     `width:0;height:0;visibility:hidden`. Chromium never lays out or paints a
     zero-size hidden frame, so the print snapshot is empty. iOS snapshots it
     anyway, which is why this stayed invisible.
  2. **Wait for `load` + `document.fonts.ready`** (bounded by a timeout) before
     calling `print()`. A blind delay races the font CDN on mobile data.
  3. **Clean up on `afterprint`, never on a timer.** `window.print()` blocks
     until dismissed on iOS/desktop but returns immediately on Android, where the
     preview renders async — removing the frame pulled the document out from
     under it.
  Also set `print-color-adjust:exact`, or Android drops the report's background
  fills and prints white-on-white.
- **html2canvas must not hard-code `scale:2`.** Chrome on Android returns a
  silently BLANK canvas past ~2^24 px (or ~8k a side) instead of throwing.
  `safeCanvasScale()` picks the largest scale inside that budget and
  `canvasLooksBlank()` steps down further if a device still gives up. Reports are
  the tallest documents in the app, so they hit this where invoices don't.

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
  (Android/Samsung Internet subscribe fine from a plain tab — don't widen that
  gate past `isIOSDevice()`.)
- **Test both phones after touching navigation, modals or the install flow.**
  An iPhone PWA has no back affordance, so an Android-breaking history bug is
  invisible on iOS. See the Android / Samsung section above.
- **`hidden` loses to any author `display:` rule.** The `hidden` attribute only
  works via the UA stylesheet's `[hidden]{display:none}`, which ANY author rule
  setting `display` beats. `.bulk-bar{display:flex}` made the bulk bar permanently
  visible on every page (v468 → fixed v469 by adding `.bulk-bar[hidden]{display:none}`).
  If a `hidden`-toggled element needs a `display` value, ship the matching
  `[hidden]` rule with it, or toggle a class instead.
- **A tap-driven list must not re-render the whole list.** Same family as the
  keystroke rule above: re-rendering on each bulk-select tap flickered and reset the
  scroll position (and re-ran `rolodexTick`). `bulkPaint(id)` toggles only the touched
  row's classes.
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
- Android/Samsung: open the URL → Install button in the bottom hint bar (or the
  browser's ⋮ / ≡ menu → Add to Home screen) → launch from the icon.
- App icon: `icon.png` (512) + `icon-192.png` (192) + `icon-180.png` (180, Apple
  touch) + `icon-maskable.png` (512, Android/One UI safe-zone), referenced by
  `manifest.json` and the `apple-touch-icon` tag. iOS caches the icon at
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
