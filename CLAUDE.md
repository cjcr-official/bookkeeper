# CLAUDE.md — Bookkeeper

Guidance for Claude Code working in this repo. Read this before editing.

Bookkeeper is a free, **single-file** accounting web app for a solo computer-repair
business (Case Johnston Computer Repair, LLC). It runs as an installable **iPhone PWA**
— think "lightweight QuickBooks": invoices, customers, expenses, accounts, mileage,
payments, recurring items, receipts, reports, jobs/calendar, and push reminders.

Current version: **509** (see `version.json` — that file is the source of truth).

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
  the app). Its `fetch` handler is **network-first with a cache fallback** (v483,
  cache `bk-shell-v1`, navigations only): an online launch always fetches fresh
  `index.html` — so the `version.json` update prompt is unaffected and nobody can get
  pinned to a cached build — and the stored copy is reached only when the network
  genuinely fails, which turns a dropped signal into a working screen instead of the
  browser's error page. Only a real 200 is stored, so an outage can't go sticky, and
  `doUpdate()` already deletes every cache but `bk-flags`. **This is the app shell
  offline, NOT the data** — rows live in Supabase and still need a connection.
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
bills (each `bill_paid[YYYY-MM]` occurrence at its due day, money out, for the
amount RECORDED on that flag — see the `bill_paid` note below — falling back to
the bill's planned amount only for legacy `true` flags; fp
`b:<billId>:<YYYY-MM>`) + recorded paychecks (v479 —
each `paycheck_amounts[YYYY-MM-DD]` entry, money IN, at its payday; fp
`pc:<YYYY-MM-DD>`) (amount ±$0.01, date
window), and shows matched / in-records-only / on-statement-only buckets. Budget-tab
records (bills, paychecks) are opt-in candidates in exactly the same way — only
occurrences the user actually marked paid / entered an amount for — and they never
touch P&L: a bill isn't a business expense and a paycheck isn't revenue, they only
have to reconcile against the bank. NOTE this cuts both ways: a recorded paycheck
that does NOT clear the account being reconciled will surface as unmatched "in your
books" (set it aside with the eye-off, or "Paid from"-tag it to the bank it really
lands in). It writes
a per-month audit result: `profiles.audited_months` (jsonb, keyed
`{accountId: {"YYYY-MM": {passed, at}}}`) — a month "passes" when nothing is
unmatched. The page shows a 12-month grid of ✅/⚠️/· marks with ‹ › year arrows
(`renderAuditBlock` keeps the year the user is BROWSING when it's re-drawn with no
month — the passive callers are `refreshLiveAudit` finishing, `renderPlaidBlock` and
`plaidSelectBank`, and defaulting those to the current year yanked the grid off 2025 a
second after the owner pressed ‹, v492);
**tap a month to pull & reconcile it**, or use **"Check the last 12 months"**
(`plaidCheckYear`) — one ranged Plaid pull, bucketed by month, every month run
through `reconcileMatch` and stamped into the audit grid, ending on a summary of
the months that need attention (tap a chip to open one). All per-month state
persists in `profiles.plaid_recon` (there's no PDF sidecar): `manual_matches`,
`unmatch_t/r` (both sides of an Unlink — `unmatchByIdx` parks them for MANUAL pairs
too, not just auto ones: dropping the `manual_matches` entry alone let the auto passes
re-form the pair on the same render, since anything recorded FROM a bank line matches
it by construction, so Unlink looked broken. Pass 0 still consumes blocked items, so
an explicit re-Match is the escape hatch), **`txn_edits`** (splits + amount fixes, re-applied deterministically
on every pull by `applyTxnEdits` inside `buildPlaidStmt` so match indices stay
valid), and **`skip_fps`** (records the user set aside as "not on this statement" for
that month).

**A bank line is referenced by CONTENT, never by position (v488).** `manual_matches`
and `unmatch_t` used to store bare indices into a month that is re-fetched live on
every pull. One transaction settling late inserts itself into the (date, description,
amount) sort order and shifts every index after it — silently re-pointing an explicit
pairing at a *different* transaction, which can flip a month's verdict with no error
anywhere. They now also carry `tKeys` / `unmatch_tk`: `txnKey(t)` =
`date|description|amount`, stamped in `savePlaidRecon` (the single place every writer
funnels through, so the ~12 call sites keep working in live indices) and re-resolved in
`buildPlaidStmt` by `makeTxnRefResolver`. The resolver **consumes** keys, so two
byte-identical lines stay distinct; it falls back date+amount → unique amount within 3
days (banks rewrite the merchant name when a charge settles); and a keyed reference
that resolves to nothing is **dropped, not guessed** — the record simply returns to the
auto-match pool. Rows saved before keys existed have no key and still use their index.
If you add a new field holding bank-line positions, key it the same way.

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

**Cross-month settlement (v488) — a record clears when the BANK says it did.**
A record dated near a month boundary routinely settles on the next month's
statement: the date on the record is when the purchase happened, the bank line is
when it posted. A July 30th expense that cleared August 1st made July report it as
"in your books · not on the bank" and FAIL, while August matched it and passed. The
only escape was to unlink and re-match by hand — which writes a `manual_matches`
entry, and *that* (via `gManual`) is what finally told July the record was spoken
for. Auto-matches now close the same loop, in **two phases**:

- **Phase 1** is `reconcileMatch` — unchanged, per-month, knows nothing of its
  neighbours.
- **Phase 2** is `applyClearedElsewhere(comp, clearedElsewhereMap(neighbourComps))`:
  an in-period record a neighbouring month MATCHED at the bank moves out of
  `inRecordsOnly` into `comp.clearedElsewhere` (`{...rec, clearedIn:'YYYY-MM'}`) and
  `passed` is recomputed. It renders as a "Cleared on a neighbouring statement"
  reference section with a button to open that month, and as a green
  `Cleared · <Mon>` chip in the finder.

Three constraints, all load-bearing:
1. **Phase 2 runs AFTER matching, never as a filter on the candidate pool.**
   Withholding a record up front would let BOTH months drop it — each seeing the
   other's match — and both would fail. Post-matching forgiveness is *monotone*: it
   can only turn a failure into a pass, so it can never invent a discrepancy. An
   unexplained bank line still fails the month.
2. **Only real matches forgive, not set-asides.** "Not on August's statement" is no
   evidence a record cleared in July. (`accountedFpsOf`, which includes set-asides,
   is for the finder's *display* only — `clearedElsewhereMap` reads `matchedFps`.)
3. **Nothing is persisted.** It re-derives from the session's pulls on every render,
   exactly like the auto-matches it reads. This is NOT the retired `matched_fps`
   map — see the paragraph above; don't turn it into one.

**Double-claim arbitration (v504) — the same neighbours, the dangerous direction.**
Phase 2 above only ever *forgives*, so it could not catch the mirror-image failure:
because an auto-match is never persisted, August's pass knows nothing about what July
matched, while the ±18-day window makes every record dated in the last stretch of July
a live candidate for August. Give August a $150 charge with no record of its own and it
paired it with the $150 expense **July had already cleared** — one record explaining two
different bank lines, *both months reporting PASSED*, and a genuinely unrecorded
transaction absorbed with no mark anywhere. That is the one outcome this screen exists
to prevent; a missed item has to be loud. (Reported from the field: an August deposit
matched to book items July had already matched.)

`resolveDoubleClaims(comp, nbComps)` is phase 2's other half, running BEFORE
`applyClearedElsewhere`: when two months' AUTO matches claim the same record, exactly
one keeps it and the loser's bank line goes back to `onBankOnly`. Ownership
(`claimBeats`): an explicit pairing beats an auto one; else the closer record-date ↔
bank-date wins; ties go to the month whose period the record is dated in, then to the
earlier month key. Four constraints:
1. **Deterministic and symmetric** — both months compute the same winner from the same
   phase-1 results, so they can never both drop it. That mutual-withholding trap is why
   this can't be a filter on the candidate pool (same reason phase 2 can't be).
2. **Monotone the safe way** — it can only ever surface an unexplained bank line, never
   hide one. Worst case is an amber month that deserved amber.
3. **A combo loses whole** — the sum stops holding the moment one leg belongs to
   another month.
4. **Nothing persisted.** Re-derives from the session's pulls every render, exactly
   like the auto-matches it reads. Do NOT turn it into a stored map (see `matched_fps`).
It needs `matchedInfo` (fp → `{d, manual, inP}`) off `reconcileMatch`, records what it
revoked in `comp.claimedElsewhere` so the freed line can say *why* it reappeared rather
than looking like the matcher changed its mind, and is wired into all three month
reconcilers: `renderReconcile` (open month + each neighbour stamp), `refreshLiveAudit`,
`plaidCheckYear`. `test/reconcile.test.mjs` pins it, including that an uncontested
cross-month settlement is untouched and that three contending months still leave exactly
one owner in any processing order.

Neighbours are only knowable if they're in the session cache, so `plaidPull` now
fetches month−1…month+1 in **one** ranged call (`pullMonthSpan`, bucketed by month,
pending bucketed by its own date) — the same round trip as asking for one month —
and `plaidCheckYear` extends its span one month either side of the 12 it reports.
Opening a month also **re-stamps its neighbours' audit marks** (`nbStamps` →
`recordAudit`'s `extraStamps`), so pulling August heals July's amber dot instead of
leaving the owner to chase it. `setAuditResult` refuses future months and
`compHasContent` keeps the re-stamp from painting marks on empty months nobody asked
about.

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
Three anti-false-alarm rules: (1) the CURRENT month stamps pass/fail like any
other month, so its grid dot shows discrepancies on load — `refreshLiveAudit`
quietly re-checks it (and LAST month) whenever the Statements page opens,
re-pulling when the session copy is over 10 minutes old; failures are
silent. It pulls **three** months and stamps **two** (v489): a month's verdict
depends on BOTH its neighbours, so judging last month with only the current one in
hand was a weaker test than opening it — a record dated the 1st that the bank
posted on the 31st before stayed unforgiven and the grid painted an amber dot that
turned green the instant the owner tapped the month. Month−2 is context only and is
never stamped, or the same gap just moves down one and the regress never ends.
Still one ranged call. Its on-screen status pill reads
"In progress" rather than "Needs review", since mid-month unmatched records are
usually just bank lag;
(2) an out-of-period record isn't called a stray if its own month accounts for
it — `monthReconcile(m, bank)` recomputes an adjacent month from the session
cache and `accountedFpsOf` reads what it matched OR set aside (fallback: that
month's stamped audit); such records render as
"accounted for on the <Mon> statement" instead of unmatched;
(3) **cross-month settlement (v488)** — see below. Each
unmatched bank line has a labeled ⋯ menu (`openTxnMenu`) that records the line
into the books and explicit-pairs it via `manual_matches`. **Every action follows the
section it files into (v483)** — expense/reimbursement/prior-year-refund need
`expenses`, invoice-payment/income/prior-year-payment need `invoicing`, bill and
paycheck need `budget`, loan payment needs `loan` (and at least one saved loan);
owner draw/contribution and the gift-card split have no module of their own and
always show. The "From a previous year" group header only renders when at least one
of its two actions does. The actions: Add as expense
(pre-fills the expense modal; `_recPairTxn` makes `saveExpense` pair it), Payment
on an invoice (picker over `balanceDue > 0`, exact-balance match first), income
without an invoice (creates a paid invoice dated the deposit day), owner
draw/contribution, gift-card split, prior-year income/refund, **Loan payment**
(`loanPayFromTxn` → pick a loan; records a `loans.payments` row and pairs it),
**Bill payment** (`billPayFromTxn` → pick one of the statement month's unpaid
budget bills; flips `bill_paid` and pairs it — plus **"New bill from this charge"**
(v478): `newBillFromTxn` renders a small inline form in the same menu shell,
prefilled from the line (`cleanBankDesc` name, abs amount, its own date) with a
"Repeats every month" toggle defaulting OFF (one-time, matching the Budget tab's
default — an unwanted recurring bill would silently alter every future month's
budget AND add a reconcile candidate per month). `createBillFromTxn` writes the same
row shape as `saveBill` and hands off to `applyBillPayFromTxn`, so it's identical to
picking an existing bill from there on. The action is gated on the budget MODULE
being enabled, not on `getBills().length` — otherwise a user with no bills yet can
never create their first one from here),
**Paycheck** (v479, deposits only: `paycheckFromTxn` → pick which of the statement
month's paydays this deposit is → `applyPaycheckFromTxn` writes
`paycheck_amounts[payday]` and pairs it). **Two paychecks on ONE payday (v481):**
`paycheck_amounts` holds a SINGLE amount per payday (the Budget page and report both
read one scalar), so a household with two earners paid the same day can't store them
separately — recording the second would overwrite the first. The picker lists **every**
unmatched same-day deposit INCLUDING the tapped one (pre-ticked; others unticked, since
a same-day deposit could be a customer payment and folding that into "what I was paid"
would be wrong). Listing the tapped line as its own row is deliberate — with only the
OTHER deposit boxed, the sheet read as one checkbox for two paychecks. It shows a live
combined total (`pcTotal`, mirrored onto each payday button so the figure about to be
saved is visible), spells out `now $X — this replaces it` on a payday that already has
an amount, and records the SUM for that payday paired to every ticked line
(`manual_matches` is N↔1). The combined total also auto-matches those
lines on later pulls via Pass 4, so the pairing survives losing the manual match.
`applyPaycheckFromTxn`'s success toast referenced an `extras` variable that never
existed (v489 fix): the paycheck saved and the sheet closed, then the
ReferenceError killed the rest of the handler — so the `renderReconcile` on the
last line never ran and the deposit sat in "on the bank · not in your books" with
the month's mark unmoved until the next pull. **Nothing after the write is
optional**; a throw between saving and re-rendering reads to the owner as "it
didn't work" for a record that is, in fact, already in the books. If
per-earner amounts are ever needed, that's a `paycheck_amounts` schema change plus the
Budget page/report — don't fake it with extra date keys, they'd be invisible there.
The picker offers **projected paydays**, never a free date, because the Budget page
and its report look amounts up by exactly that key — an amount stored under any other
date would be invisible there. But it asks **`paydaysOnStatement(y,m)`, not
`paydaysForMonth` (v501)**, and the difference is load-bearing: on a fixed-day
schedule a payday landing on a weekend MOVES (default "pay the Friday before"), so
the payday a budget month plans against is routinely dated in the month next door —
with a monthly schedule on the 1st, August 2026's paycheck is a **July 31st**
deposit. Reconciling July offered "Jul 1" and nothing else: every option was wrong,
so the honest move was to record nothing, and the deposit stayed unexplained with
July's mark amber for good. `paydaysOnStatement` keeps the month's own list (a payday
can also post a day or two late, which is the same shift seen from the other side)
and ADDS any neighbouring month's payday whose date lands inside this month. Weekly /
biweekly schedules are unaffected — their paydays are already dated in the month that
lists them. `paydaysForMonth` stays keyed to the BUDGET month, because that's where
the card and the amount key live; don't collapse the two. `test/budget.test.mjs`
pins both. With no `pay_schedule` set it doesn't dead-end: it offers
`openPayScheduleModal()` inline (that function is self-contained and `renderBudget()`
no-ops off-page, so both are safe to call from reconciliation),
**Reimbursement of an expense** (v474, deposits only: `reimburseFromTxn` → pick the
expense being paid back, exact-amount candidates first → `applyReimburseFromTxn`
writes a NEGATIVE expense in that expense's own category and pairs it, so the cost
nets to zero and nothing lands in revenue — same vehicle as the prior-year refund),
plus split/rejoin/fix-amount. **Anything logged from reconciliation is attributed to
the account being reconciled (v475)** — `activeReconBank()` (open statement's
`bankKey`, else `_selBank`) feeds both halves: `renderReconBankPicker`'s
**`opts.defaultBank`** pre-selects the Expense form's "Bank account" field
(`addExpenseFromTxn` passes it and calls `onExpBankChange()` so the account's own
categories load), and `tagFromRecon(fp, exact)` writes the same tag for the form-less
actions. **`defaultBank` is an argument, never a global (v491).** It used to be
`_recDefaultBank`, which only `openExpenseModal` cleared — so a single "Add as
expense" left it armed for the rest of the session and the next NEW invoice / loan /
bill silently pre-tagged itself to whatever account the Statements page had open. With
two banks that's a wrong "Paid from" written without the user touching the field: the
record stops matching the bank it really cleared, and that bank's month fails on an
unexplained line. A per-form default has to be passed per call, or every other form
inherits it. It never overrides a tag the
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
reloads and the Owner Activity card below pops up, then back down (v461 fix).
**Same rule, same reason, for `acctId` (v493):** `renderAuditBlock(null, …)` falls back
to the legacy `'_'` bucket, which `migratePlaidKeys` deletes — so the grid draws from an
empty map and every month reads as a hollow "not checked yet" dot. `renderAccountsPage`
was passing null, which flashed a wiped audit history on every Statements open and every
rotation until `/plaid/status` answered. Every caller holding a bank passes `_selBank`;
only the genuinely bankless branches (Plaid not configured, no bank linked) may pass
null, and `test/reconcile.test.mjs` pins that split. `/plaid/transactions`
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
picker, gate it on `reconBankChoices()` and let this path fill it in; never assume the
Statements page ran first.** Setting the tag up front here is equivalent to setting it
from a manual match later — both write `recon_bank`, the single attribution source.

**They also follow the Statements section (v483).** `reconBankChoices()` is
`knownPlaidBanks()` minus a `isModuleHidden('statements')` gate, and it's the single
rule behind all of them — the five per-record pickers (expense, invoice, loan, loan
payment, bill) via `renderReconBankPicker`, the bulk-edit "Paid from" row, and (v492)
the **Expenses tab's Account switcher**, which had been reading `knownPlaidBanks()`
directly and so went on filtering the list by an attribution nothing else was still
showing. That row is JS-managed, so it carries no `data-module` attribute for
`applyModuleVisibility` — or the static markup checks — to catch; `getFilteredExpenses`
reads its value through the same rule too, so the filter can't outlive the section even
for one render. **Anything that surfaces the tag reads `reconBankChoices()`, never
`knownPlaidBanks()`** — `test/modules.test.mjs` now asserts that. The
tag exists only to steer reconciliation, so with Statements off it's dead weight on
every form. `renderReconBankPicker` also CLEARS the select in that case, so
`currentExpBank()` reads empty and the Expense form falls back to the global category
list instead of a per-account one.

**But an undrawn picker must never WRITE (v491).** Clearing the select makes
`sel.value` read `''`, which is exactly what "— Any account —" reads as, so
`applyReconBankPicker` — called unconditionally by all five save paths — cleared the
record's existing tag on any unrelated edit. Switch Statements off, fix a typo on a
tagged expense, and its account attribution is gone; switch Statements back on and it
auto-matches every bank again. This is the account-separation regression reached from
the other side, and it broke the Sections rule that **a hidden field keeps its value**.
The guard is `if (!sel.options.length) return;`: a drawn picker always carries at least
the "Any account" row, so an empty option list is the faithful test for "never shown to
the user" — and it covers the other way in too (saving before `ensurePlaidBanks()`
lands on a fresh launch). Gating on `knownPlaidBanks()` did NOT cover either case: the
banks are still known, it's the field that isn't there. `test/modules.test.mjs` pins
it.

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

Fifteen test suites run the SHIPPED code (they extract functions out of `index.html` by
brace-matching and eval them with stubbed globals — no copy-paste, no build step):

```bash
node test/reconcile.test.mjs   # the bank-statement matcher
node test/modules.test.mjs     # Sections (show/hide) + the cross-section form rules
node test/money.test.mjs       # balanceDue / effectiveStatus / invoiceRevenue
node test/ask.test.mjs         # askText() — every dismiss route must settle its promise
node test/touch.test.mjs       # viewport zoom + the 16px minimum on touch inputs
node test/retention.test.mjs   # account deletion actually deletes every table
node test/reminders.test.mjs   # the Worker's Denver wall-clock → UTC reminder math
node test/recurring.test.mjs   # unattended auto-posting: no silent skips, no duplicates
node test/forms.test.mjs       # a save must not blank a select value it didn't recognise
node test/dates.test.mjs       # "what day is it" — local calendar dates, never UTC
node test/home.test.mjs        # Home's refresh contract + its fold controls
node test/loan.test.mjs        # the amortization engine, against closed-form annuities
node test/budget.test.mjs      # paydays, bill months, and what a paid bill actually cost
node test/time.test.mjs        # Time Clock: a punch belongs to its LOCAL day
node test/a11y.test.mjs        # tappable divs stay operable through every redraw
```

`retention.test.mjs` and `reminders.test.mjs` are the two that read the **Worker**. `deleteAccount()`
wipes the user's rows from a hard-coded table list, and nothing tied that list to the
rest of the app — so it fell behind as features were added. `time_entries` (Time
Clock) and `loans` (balances + payment history) were both missing: deleting the
account removed the login, so those rows became unreachable through RLS but were
never actually deleted, and `data-retention-policy.html` publicly promises the
opposite. The test pins the list against the client's own `cache` literal — which
names every user-owned table — so **adding a table to `cache` and forgetting
`deleteAccount` now fails the build**. It also pins the FK delete order and that
`deleteUserStorage` pages past the storage list API's 1000-object cap (a single call
left every receipt after the first 1000 sitting in the private bucket).
**There is exactly ONE `cache` literal (v501).** `doLogout` used to rebuild the object
from a second copy of the table list, and that copy fell a table behind the real one —
it never got `loans`, so a signed-out session carried `cache.loans === undefined`
until the next login refilled it. It clears by key now
(`Object.keys(cache).forEach(...)`), and the test rejects any new literal there:
the `cache` declaration stays the single source the retention check reads.

`modules.test.mjs` also statically checks the markup: every `data-module` /
`data-module-all` / `isModuleHidden('…')` id must exist in `MODULES`, and every module
page must have a `#page-<id>` element and a `NAV_ORDER` entry. A typo in any of those
silently does nothing at runtime, which is exactly what code review misses.

---

## Two data-safety rules (v484) — both failed SILENTLY before

**1. Never `.select()` a whole table without paging.** Supabase/PostgREST caps a
response at **1000 rows** by default and returns the truncated set with **no error**.
Because the ledgers are ordered newest-first, what silently disappeared was the oldest
history — so the P&L, the expense summary and reconciliation would quietly stop seeing
records that are still sitting in the database. `loadAllData()` now pages every table
through `paged(build)` in `PAGE_ROWS` blocks until a short page comes back. Two things
that matter if you touch it: `build` must be a **factory** (each page needs a fresh
query builder), and every paged query ends with a unique tiebreaker (`.order('id')`) —
without one, rows sharing a date reshuffle between pages, which duplicates some and
drops others.

**2. Never write a collection-shaped jsonb column from the in-memory `profile`.**
`bill_paid`, `paycheck_amounts`, `budget_bills`, `recon_bank`, `expense_categories`,
`account_categories`, `bank_labels` and — since v488 — `plaid_recon` and
`audited_months` are collections that a phone and a laptop add to
independently. The old pattern cloned the `profile` fetched **at login**, changed one
entry, and wrote the whole column back — so a tab left open since morning would
overwrite everything the other device had done since, with no error (a perfectly valid
write built on a stale base, which is why nobody noticed).

Use **`updateProfileJson(col, apply, empty)`**: it re-reads the column immediately
before writing and applies the change as a **delta** to that fresh value. `apply(current)`
must be pure and must touch **only** the entries it owns — then a concurrent edit to any
other key survives. For the two ordered arrays the user edits wholesale
(`budget_bills`, `expense_categories`) pass the edit through **`mergeListEdit(base, next,
fresh, key)`**, a 3-way merge that honours local deletes and keeps entries only the
server knows about. Neither is atomic — PostgREST gives us no transaction — but the
conflict window drops from "as long as this tab has been open" to one round trip.

The two reconciliation columns were the last holdouts (v488): `savePlaidRecon`,
`resetMonthMatches`, `recordAudit`/`persistAuditStamps`, `migratePlaidKeys` and
`persistOrphanMerge` all write a **delta** now — one month, or one re-key applied
inside `apply(current)` — so reconciling March on the phone can't roll back the months
the laptop checked since login. `deleteLoan` was the one that got missed (fixed v499):
it cleaned up the deleted loan's `recon_bank` tags by cloning the in-memory map and
upserting the whole column, so deleting a loan on a tab left open since morning
silently reverted every "Paid from" tag the other device had set. Its delta now
recomputes the doomed keys **inside** `apply(current)`, which also catches per-payment
tags this device has never seen. `migrateReconTags` was the last one (fixed v501): it
ran at EVERY login and wrote the whole `recon_bank` map whenever a manual match implied
a tag the map didn't have yet, so a "Paid from" tag set on the other device in the
seconds since this one fetched the profile was rolled back — silently, and at the one
moment a second device is most likely to be in use. `manualMatchTagMap` was already
pure and only ADDS tags, so it drops straight into `apply(fresh)`. **Every writer of a
collection column goes through `updateProfileJson` — grep for
`.upsert({ id: currentUser.id` before adding another.**

Scalar settings (`notify_hour`, `logo`, `time_format`, `hourly_rate`,
`push_subscription`, `hidden_modules`) are a different case: last-write-wins is the
correct semantics for a single value, so they still write directly.

---

## Architecture & the core pattern

- Global **`cache`** object holds all data: `cache.customers`, `.invoices`,
  `.expenses`, `.accounts`, `.trips`, `.recurring`, `.jobs`. (`vendors` was
  removed — do not reintroduce it. **`accounts` (the old chart of accounts) is
  vestigial as of v472 and its code was REMOVED in v483:** the list page had been
  gone for a while (`renderAccounts()` early-returned because nothing mounts
  `#accounts-table`, and the page renderer is `renderAccountsPage`), so the whole
  unreachable subgraph — `renderAccounts` / `openAccountModal` / `editAccount` /
  `saveAccount` / `deleteAccount` plus `#modal-account` — is deleted. The Expense
  form's "Account" select went earlier: two competing "account" fields confused the
  owner, who wants the connected **Plaid bank** to be the only one. Rows are still
  LOADED into `cache.accounts` because the Owner Activity modal names a transaction's
  account from them; nothing creates or edits one any more. `expenses.account_id` is
  no longer written (existing values are left alone). Don't add a chart-of-accounts
  picker back to a form — use the "Paid from" / bank picker.) `loadAllData()` fills it on login via a
  `safe()` wrapper that catches errors → empty arrays (so the app keeps working
  before a new SQL migration is run). **`profile`** holds the user's settings row.
- Every entity follows: **`render<Thing>()`** draws the list → **`open<Thing>Modal()`**
  opens the add/edit form → **`save<Thing>()`** upserts to Supabase AND updates
  `cache` in place → **`delete<Thing>()`** removes from both. Re-render after writes.
- `showPage(page, el)` switches pages, sets the title, populates `#topbar-actions`,
  and calls `updateTopbarLogo()`. `currentPage` tracks the active page.
- `rerenderCurrentView()` is called on resize/orientationchange so mobile/desktop
  layouts swap correctly.

### Sections — every tab can be switched off, so every section must stand alone

`MODULES` (one entry per switchable section: `invoicing`, `expenses`, `mileage`,
`time`, `jobs`, `budget`, `statements`, `loan`) maps a module id → the nav page(s) it
owns. **A module can own NO page** — `jobs` (Jobs & Calendar) lives entirely on Home,
so its `pages` is `[]`; `hiddenPagesSet()` then adds nothing and every gate is a
`data-module` attribute or an `isModuleHidden('jobs')` check. Don't invent a nav tab
just to make a section switchable.
The hidden set lives on `profiles.hidden_modules` with a `bk-hidden-modules`
localStorage mirror so the nav hides instantly on boot and keeps working before the
migration runs. `getHiddenModules()` / `hiddenPagesSet()` are **memoized** (`_hidMods`
/ `_hidPages`) and invalidated only in `setHiddenModulesLS()` — they're read on every
render pass, so re-parsing JSON each time was pure waste. The returned array is the
LIVE memo: treat it as read-only and build a new array to change it (that's why
`toggleModule` filters/concats instead of splicing).

**The rule: a section is independent, with the *option* to connect.** A section must
never *require* another section's data, and must never show a field that belongs to a
switched-off section. Two mechanisms, both already wired:

- **Markup** — tag the field with `data-module="<id>"` (hides if ANY listed id is off)
  or `data-module-all="<id> <id>"` (hides only when EVERY listed id is off, for a row
  or hint that should survive as long as one child is still usable).
  `applyModuleVisibility()` sweeps the whole document — including modal HTML — on
  boot, on login, and on every toggle, so a static field needs no JS at all. Don't tag
  an element whose `display` is already managed by JS; gate it in that code instead.
- **Generated UI** — call `isModuleHidden('<id>')` (e.g. the reconcile ⋯ menu only
  offers actions whose destination section is on; `renderReconBankPicker` hides every
  "Paid from" picker when `statements` is off, via `reconBankChoices()`).

Worked example, v483: **the trip modal used to hard-require a customer or an expense
link** (`saveTrip` bailed with "Select a client or linked expense"), which made the
Mileage section unusable whenever Invoices and Expenses were both off — and made
ordinary unlinked driving impossible to record at all. Now miles are the only
requirement, both link fields carry their own `data-module`, and the row + hint carry
`data-module-all`. Same fix applied to mileage on the invoice form, one-way miles on
the customer form, and the invoice link on the expense form. **A hidden field keeps
its value** (`open<Thing>Modal()` still populates it and `save<Thing>()` still writes
it) so switching a section off never destroys existing links.

**Hiding a section also has to silence what it generates in the background (v486).**
A tab disappearing is the easy half; the leaks were everywhere the app speaks up on
its own:

- **The bell** (`buildNotifications`) filters per source — invoices follow
  `invoicing`, events follow `jobs`, a recurring item follows the section its `kind`
  belongs to. It feeds the unread badge AND the Home Screen app-icon badge, so a leak
  here is a red dot for a tab that no longer exists, on a row that opens a hidden page.
- **`processRecurring()`** skips a kind whose section is off, so a hidden section
  can't quietly auto-post expenses or pile up draft invoices. It deliberately does NOT
  advance `next_date` for those — turning the section back on catches everything up
  exactly as it always did.
- **The Worker cron** reads the same `profiles.hidden_modules`
  (`hiddenModulesFor(env, userIds)` → `moduleOff(...)`) before sending a job or
  recurring push. Best-effort: a missing column or a failed read means "nothing
  hidden", i.e. the behavior before this existed. A skipped job reminder is left
  unstamped on purpose — the existing window-expiry branch clears the row 30 min
  later, and until then re-enabling the section still lets it land.
- **Home's shared surfaces** — the Upcoming card and the month calendar draw from
  several sections at once (events, invoice due dates, recurring runs, budget bills,
  loan payments), so they carry `data-module-all` and only vanish when every source
  is off. **Each card lists exactly what it actually draws from**: the calendar gets
  `jobs invoicing expenses budget loan`, Upcoming gets the same MINUS `budget`
  (`renderUpcoming` has no budget-bill rows, so tagging it with `budget` would leave
  a permanently-empty card on Home for someone running Budget on its own). The "new
  event" buttons inside them carry `data-module="jobs"` on their own. With Jobs off
  the calendar stays as a read-only view (a second tap on a day no longer opens the
  event sheet).
- **A topbar action can write into another section** — the Mileage tab's **Rebuild**
  overwrites mileage on every INVOICE and recreates their trips, so it's built
  conditionally in `showPage`'s `actions` map and drops out with `invoicing`. Log Trip
  stays; Mileage stands alone. Check the `actions` map when you add a bulk action.
- **Switched off should also cost nothing.** Two per-render network calls were
  firing for hidden UI: `ensurePlaidBanks()` (fire-and-forget from `loadAllData`,
  feeding "Paid from" pickers that `reconBankChoices()` already hides) now returns
  early when `statements` is off — **before** the `_plaidBanksPromise` memo, so
  switching Statements back on mid-session can still fetch for real — and
  `renderTaxCard()` skips `ensureLiveTax()` (a POST to `/tax-estimate` → PolicyEngine)
  when `invoicing` is off, since the Tax card is the only way into that modal.
- **Settings → Notifications follows everything that can push** — recurring items
  (`invoicing`/`expenses`) and events (`jobs`), so the nav button and panel carry
  `data-module-all="invoicing expenses jobs"`. Inside it, the morning-reminder-time
  row is recurring-only (`data-module-all="invoicing expenses"`) and the help text
  splits into a recurring half and an events half.
- **Settings panels that configure one section follow it** — Invoice Defaults
  (`invoicing`) and Expense Categories (`expenses`), both the nav button and the
  panel. On desktop the panel column is `.active`-driven, so `applyModuleVisibility`
  clearing the inline style hands it straight back to that CSS; if the *active* panel
  is the one that just went off, it falls back to Appearance (which can never hide).
- **Leaving Home with nothing to draw** read as a broken app, so `#dash-all-off`
  explains it and links to Settings → Sections. Its display is JS-managed from
  `applyModuleVisibility` — that's why it has no `data-module` tag. **The trigger is
  `HOME_MODULES`, not "every module is hidden" (v498):** `time` and `statements` own
  a tab and draw NOTHING on Home, so running only the Time Clock left the page blank
  with the explanation still suppressed — the exact failure the card exists to
  prevent. `HOME_MODULES` is the six ids used inside `#page-dashboard`, and
  `test/modules.test.mjs` pins it against the markup: **put a new section on Home and
  you must add its id there**, or its blank state goes unexplained. `paintHomeEmptyCard`
  also switches the copy — telling someone running the Time Clock that "every section
  is switched off" is plainly false, so it names what they have on and where it lives.

`test/modules.test.mjs` pins all of this, including a static check that every module
id used in markup or `isModuleHidden()` actually exists, and a functional harness that
runs the shipped `buildNotifications()` over each hidden set.

### The usual task — add a field to an entity
1. Add the `<input>`/`<select>` to that entity's modal HTML.
2. Set its `.value` in `open<Thing>Modal()` (with a sane default for the "new" branch).
3. Include it in the row object in `save<Thing>()`.
4. If it's a new DB column, give the user the `alter table ... add column if not
   exists ...` to run in the Supabase SQL Editor (they run migrations manually).
   The app must keep working **before** the SQL runs (see `safe()`).
5. If the field belongs to another section, gate it (see Sections above).
6. Bump `version.json`. Ship both files.

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
-- hidden_modules: which Sections (tabs) the user switched OFF, as a jsonb array of
-- MODULES ids e.g. '["loan","budget"]'. This column was in use since the Sections
-- feature shipped but went undocumented until v483 — worth actually running, because
-- without it the choice lives only in localStorage, and iOS clears an installed PWA's
-- local storage, so the hidden tabs silently come back. The app works before this
-- runs (the localStorage mirror carries it on-device, and a missing-column error on
-- upsert is swallowed on purpose).
alter table profiles add column if not exists hidden_modules jsonb default '[]'::jsonb;
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
-- PAYING IT OFF (v500): `remaining` is the balance as of the LAST PAYMENT, and paying
-- exactly that figure later can NEVER clear the loan — the payment settles the month's
-- interest first, so what's left is B - (B - B*r) = B*r, precisely one month's interest,
-- every time. (Reported from the field: a $58,502.48 balance paid a month later left
-- $195.01 owing at 4%.) So the Remaining Balance card is labelled "as of <date>", a
-- "Pay off today" row quotes balance + accrued interest, and the payment sheet has a
-- "Pay off in full" button that RE-QUOTES as the date field changes — one fixed number
-- would recreate the same trap. loanAccruedSince() must charge interest exactly the way
-- loanActual() does (whole months, rate in effect, keyed off the last DATED payment),
-- because the figure it quotes is the figure the user then records: if they drifted by a
-- cent the button would leave a residue, i.e. the same bug with a button on it.
-- test/loan.test.mjs pins that recording the quote zeroes the balance on every date.
-- The engine (computeLoan / loanActual / loanForwardSchedule / loanRateOn) is PURE
-- and is the only compound arithmetic in the app — every figure the tab shows comes
-- out of it, and a wrong one doesn't throw, it just misstates what is owed.
-- `test/loan.test.mjs` checks it against closed-form annuities rather than against
-- itself: the payment, per-row interest/principal splits, 0% and ARM cases, and the
-- load-bearing claim that an on-time payer's forward projection reproduces the
-- original remaining schedule exactly. Extend it when you touch the math.
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
--   bill_paid         {"YYYY-MM": {billId: <amount paid>}} — per-month paid flags (a
--                     bill recurs monthly, so "paid" is per occurrence). Green check +
--                     strikethrough on the row; also marks the calendar chip done.
--                     THE VALUE IS THE AMOUNT, and it must stay TRUTHY (v503): a $0 or
--                     unknown amount stores `true`, which is also what every row saved
--                     before v503 holds. It used to ALWAYS be `true`, so the only
--                     figure reconciliation could offer for a paid occurrence was the
--                     bill's CURRENT planned amount — wrong twice, silently. A variable
--                     bill (electric, water, gas) is planned at $118.42 and charged at
--                     $143.10, so it could never match the line it is; and editing a
--                     recurring bill's amount RETROACTIVELY restated every occurrence
--                     ever paid, so months that had already reconciled and stamped ✅
--                     flipped to ⚠️ on their next pull with nothing to point at.
--                     `toggleBillPaid(id,y,m,amount)` freezes the real figure:
--                     `applyBillPayFromTxn` passes the BANK LINE's amount (the one path
--                     that knows for certain), the Budget row passes the bill's amount
--                     as planned right now, and `billRow` shows "paid $X" when the two
--                     differ. Readers go through `billPaidAmount(id,y,m)` /
--                     `billPaidFlagAmount(flag)` (→ null for a legacy `true`);
--                     `isBillPaid` stays a plain truthiness check. Deleting a bill runs
--                     `forgetBillTraces(id)`, which drops its flags AND its `recon_bank`
--                     tags (folded `b:<id>` plus every `b:<id>:<YYYY-MM>` override) as
--                     DELTAS — the same orphan/clobber pair `deleteLoan` was fixed for
--                     in v499. `test/budget.test.mjs` + `test/reconcile.test.mjs` pin
--                     all of it.
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
  **The collapsible widgets are drawn LAZILY (v496)** — each one (cash flow,
  category donut, Upcoming) is a full pass over the ledgers, they all
  default to *collapsed*, and a collapsed card's body is `display:none`, so every
  `renderDashboard()` was building all of them whether or not anyone could see them.
  (A fourth, the "Spend This Month" red heat calendar, was **removed in v509** at the
  owner's request — it duplicated Spending by Category on the same page and made an
  already-long Home longer. `renderSpendMonth`, the `.sc-*` / `.spend-*` CSS and the
  desktop grid's `spend` area went with it; don't add a second month grid back to
  Home.) `renderDashboard`
  now calls `applyDashCollapsed()` **first** and then `renderDashCard(id)` per card,
  which no-ops on a folded one; `toggleDashCard()` draws a card the moment it's
  unfolded. **Order is load-bearing** — draw before the saved fold state is applied
  and an expanded card comes back empty, silently. The Calendar is NOT part of this
  (it's opened by inline `display`, not the `.collapsed` class); it's refreshed by
  `renderDashboard` whenever `calendarOpen()`, since no write path redraws it and a
  paid invoice used to leave a stale chip on its old due date.
  **Home answers for what it changes (v497).** It's the only page that edits its own
  data in place — a job saved or deleted from the calendar re-draws two cards and
  returns — so anything else fed by that data has to be refreshed by hand.
  `refreshHomeAfterJobWrite()` is the single place: Upcoming, the calendar (only
  while open), and **`refreshNotifBadge()`** — the bell counts missed/today events
  out of `cache.jobs` and mirrors that count onto the Home Screen app icon, so
  ticking tonight's job done used to leave a red dot on both until the user changed
  pages. Route any new Home-local write through it. (`showDataLoadError`'s Retry had
  the same shape of bug from the other end: it re-rendered the Dashboard whatever
  page you were on, so retrying from Invoices reloaded the data and left the empty
  list sitting there. It calls `rerenderCurrentView()` now.) `test/home.test.mjs`
  pins this.
- **Jobs / Calendar:** its own switchable section (`jobs`, no nav tab — see
  Sections). Add jobs (title + date + optional time + optional
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
  Skipped entirely (unstamped) when the user has the `jobs` section switched off.
  **`wallToUtc` samples the zone offset TWICE** — once at the wall time read as UTC,
  then again at the instant that first pass produced. One pass is right all year
  except where the two samples straddle a DST change, which put the whole 2:00–8:30am
  band on both switch days a full hour out (early in November, late in March). Don't
  "simplify" it back. `test/reminders.test.mjs` walks every half hour on both days.
  Those stamps are also the ONLY dedupe: `supaPatch` used to swallow a failed write
  entirely, so a dropped stamp re-sent the same reminder every minute with nothing in
  the logs. It checks the status and returns success now.
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
  editor (default on), and skipped when the section that owns the item's `kind`
  (`invoicing` / `expenses`) is switched off.
- **Notification center (in-app, v318+):** a bell in the top bar
  (`#notif-bell`) with a red unread-count badge (`#notif-badge`). Notifications
  are **derived client-side from `cache`** (no DB table) by `buildNotifications()`:
  overdue/due-soon invoices, jobs today or missed, recurring items coming due
  (`NOTIF_SOON_DAYS = 3` horizon) — **each source gated on its own section**
  (v486). Each has a **stable id**; seen ids live in
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
  **Per-item dates (v506):** the printed DATE column is per row, not per invoice —
  a job spanning several days should print the day each item happened. Each line
  in `invoices.lines` carries an optional `date`, and each customer-expense row
  does too. **Blank means "follow the invoice date"** (`l.date || inv.date`), which
  is what makes this a no-migration, no-behavior-change addition: every line ever
  saved has no `date` and prints exactly as it did. Don't "helpfully" default a new
  line to today or to the invoice date — a filled-in date stops following when the
  user changes the invoice's own date, which is the wrong default for the common
  case. Same rule on load: `openInvoiceModal` shows a linked expense's date as
  blank when it equals `inv.date`, so it keeps following. A customer-expense row's
  date is a REAL ledger date (`syncInvoiceExpenses` writes `item.date || inv.date`
  onto the expense row); a line item's date is display-only — revenue is recognised
  per invoice (`invoiceRevenue`), never per line. `invoiceFromTime` fills each
  line's date from `timeDay(t)` instead of appending the day to the description.
  **The closing thank-you prints ONCE (v507):** the invoice footer always ends with
  "THANK YOU FOR YOUR BUSINESS!", and Settings → Invoice Defaults suggested that same
  sentence as the default notes (prefilled onto every new invoice) — so the courtesy
  landed on the page twice, once under the total and once at the bottom.
  `isJustThanks(notes)` gates the notes block: notes that are ENTIRELY a thank-you are
  skipped, notes that say anything else (terms, a due date, a thank-you *with*
  something after it) print in full. Suppress the notes, never the footer — the footer
  is the designed closer and it's what a note-less invoice ends on. `money.test.mjs`
  pins both directions, since too loose a match would swallow real payment terms.
  **The form is folded, not flat (v508).** The invoice editor asked for everything at
  once — status, payment, a bank picker, three mileage boxes, customer expenses and
  notes — for what is nearly always "pick a customer, type a line, Save". The top of
  the form is now just the invoice header (customer + number + both dates, two-across
  on a phone via `.form-row.tight`/`.tight.lead`) and the line items; **Status &
  payment** (status lives WITH the payment that sets it), **Customer expenses**,
  **Mileage** and **Notes** are `.form-fold` sections. Three rules make folding safe,
  and all three are pinned by `test/forms.test.mjs`:
  1. **Nothing is unmounted.** A fold body is `display:none`, so every field keeps its
     value and `saveInvoice()` reads exactly what it always did — the same "a hidden
     field keeps its value" rule the Sections work follows.
  2. **A collapsed fold states its contents.** `updateInvFolds()` writes a live summary
     into each header (`Paid · $300.00 Check`, `2 items · $75.00`, `2 trips · 48.00 mi`),
     so folding hides controls, never facts. It is called from EVERY path that can move
     one of those figures — the payment fields' own handlers, `calcInvMiles`,
     `renderInvExpenses`, `markInvoicePaidFull` — because a stale summary would tell the
     owner an invoice is unpaid while it holds a payment.
  3. **A fold that holds something opens itself** when the invoice loads
     (`openInvoiceModal`), so editing a paid invoice still shows the payment. Notes are
     the exception: `profile.terms` prefills every invoice, so only notes the user
     actually changed count as content.
  Customer expenses sit ABOVE the totals — everything that makes the number is on the
  same side of it — and `openInvoiceModal` now calls `renderInvExpenses()`, which
  nothing did before: the block was drawn only by add/remove, so reopening an invoice
  with billed parts showed an empty list while the total above counted rows the owner
  couldn't see.
- **Payments:** `amount_paid`/`paid_date`/`payment_method`; partial payments;
  `balanceDue(inv)` and `effectiveStatus(inv)` (fully-paid → paid; past-due →
  overdue). Outstanding = sum of balances (excl. drafts). PDF shows Paid/Balance
  Due when partly paid.
- **Recurring (invoices/expenses):** `recurring` table; `processRecurring()` runs
  on boot, catches up missed periods, generates invoices as DRAFTS and auto-posts
  expenses. Keep monthly billing day ≤ 28 (JS month rollover).
  **This is the only path that writes financial records with nobody watching, so
  three rules hold it together (v494, `test/recurring.test.mjs`):** (1) `genOneRecurring`
  **throws** on a failed insert — it used to swallow the error and return normally
  while the caller advanced `next_date` anyway, which skipped that occurrence
  *permanently* and still counted it in the success toast; (2) `processRecurring`
  catches **per item** and stamps `next_date` with whatever DID generate, so a
  half-finished catch-up resumes instead of re-posting duplicates; (3) nothing may
  escape — all three login paths `await processRecurring()` immediately before hiding
  the loading screen with no catch of their own, so an escaping rejection strands the
  user on the spinner. A failure toasts as an error; it is never silent.
- **Expenses:** list sorts by date (newest first).
  **A `<select>` never silently drops a stored value (v495).** Assigning
  `select.value` a string with no matching `<option>` sets `selectedIndex` to −1, so
  `.value` reads `''` — and every `save*()` reads straight from `.value`, writing that
  blank back over the record. Reconciliation books expenses with method `'bank'` and
  category `'Prior-year refund'`, and invoice payments with method `'bank'`, none of
  which are in the corresponding option lists: opening one of those to fix a typo and
  saving used to erase the field. Deleting a category older expenses still use, and
  per-account category lists (switching the Bank account field), reach the same place.
  **`selectValuePreserving(sel, value)`** appends the stored value as its own labelled
  option instead — use it for ANY select fed from a record, never a bare
  `.value =`. It's wired into `exp-category` (via `renderCategoryOptions`),
  `exp-method` and `inv-pay-method`; `test/forms.test.mjs` pins it.
  User-editable categories saved
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
  **A trip is a STANDALONE record (v483)** — `saveTrip` requires only the miles.
  The Client and Linked Expense fields are optional conveniences that each hide with
  their own section, so the trip log works with Invoices and Expenses both off, and
  plain unlinked driving (bank run, parts pickup) is recordable. An unlinked trip
  titles itself from its purpose (`tripTitle`), falling back to "Trip". Don't put the
  "must link something" requirement back.
- **Settings → Business Logo:** stored as a downscaled PNG data URL on
  `profiles.logo` (NOT Storage — data URLs render in the html2canvas PDF
  without tainting and sync across devices). Saves immediately on pick. Shows
  in the desktop sidebar (replaces the Bookkeeper book icon), invoice header,
  and report header. `applyIconLinks()` also rewrites `<link rel="icon">` so
  it's the browser tab favicon.
  **The HOME SCREEN icon is NOT the logo — it's the Bookkeeper icon, on every
  platform (v505).** Android was already that way and can't be anything else (a
  WebAPK builds its launcher icon from the MANIFEST at install time and ignores
  `apple-touch-icon`), so pointing iOS at `profiles.logo` only made the owner's two
  phones show different icons for the same app; the owner asked for the app's own
  mark on the iPhone. `apple-touch-icon` is now hard-pointed at `icon-180.png`.
  The square-icon builder that existed only to feed it (`buildAppIcon` /
  `refreshAppIcon`, which painted the logo onto an opaque 180×180 canvas) and the
  "Use as app icon" button + `forceUpdateAppIcon()` + `#modal-appicon` — a platform
  explainer whose whole job was walking an iPhone owner through the remove/re-add —
  are deleted with it. An iPhone installed before v505 keeps the old icon until it's
  removed and re-added; iOS locks the icon in at add-to-Home-Screen time. Don't
  point `apple-touch-icon` at the user's logo again.
- **Reports:** Profit & Loss, Expense Summary, Budget and Loan, same invoice-style
  PDF + print pipeline. **A scoped report needs a picker (v503).** The Budget report
  hard-coded `new Date()`, so the current month was the only month that could ever
  be printed — the wrong single choice for a forward planner twice over: printing
  NEXT month's bills is the point of the tab, and in the first days of a month you
  still want the one just closed. It now has a month `<select>` (mirroring the Loan
  report's), defaulting to whatever month `budgetCursor` is showing so opening the
  report straight after browsing prints what the user was just looking at, and
  pinning to an explicit pick after that. `budgetReportMonths(sel)` offers ±6 months
  around today and always folds `sel` in — a Budget page browsed outside that window
  would otherwise render a picker with nothing selected and silently print a
  different month than the one named in the dropdown.

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
- **The viewport must NOT block pinch-zoom — AND no touch input may be under 16px.**
  These two pull against each other and you need both; getting only the first is what
  caused the v484 stranded-zoom bug.
  `maximum-scale=1.0, user-scalable=no` was removed in v483 because it fails WCAG
  1.4.4 (Lighthouse flags it) and Android was the only platform honouring it for
  pinch — i.e. the one place it did real harm. **But the claim that "nothing
  regressed" was wrong**, and it shipped: iOS *does* still honour `maximum-scale` for
  auto-zoom-on-focus, so that tag had been quietly masking a scattering of inline
  `style="font-size:13px"` overrides on the tight rows. With the tag gone, focusing an
  invoice line item zoomed the whole page in — and iOS never zooms back out, so the
  owner was left stranded at ~2x with the layout cut off. The base
  `input,select,textarea` rule being 16px was NOT enough, because inline styles beat it.
  The fix is the font size, never the viewport: a
  `@media (pointer: coarse){input,select,textarea{font-size:16px!important}}` guard
  (just after the base rule). `!important` is required — inline styles win over
  everything else — and `pointer: coarse` keeps compact type on mouse-driven desktop
  while still covering iPad in landscape, which renders the >768px desktop layout on a
  touch screen. **Never answer a zoom complaint by re-adding maximum-scale.**
  `test/touch.test.mjs` pins both halves.
- **App-shortcut targets can point at a switched-off section.** Manifest `shortcuts`
  are baked into the WebAPK at install time and can't be varied per user, so
  `applyShortcutLink()` checks `isPageHidden(go)` and toasts which section is off
  rather than silently landing on Home.
- **Icons:** `icon-180.png` is what `<link rel="apple-touch-icon">` points at — that
  is the size iOS actually renders, and aiming the tag at the 512 `icon.png` made
  every install pull 20KB to draw 6KB of pixels. `icon-maskable.png` is the
  `purpose:maskable` entry. One UI masks
  maskable icons to the inner ~80% circle, which sliced the corners off the
  full-bleed `icon.png`. It's generated by scaling the artwork to 72% on a
  flat-background 512 canvas — regenerate the same way if the logo changes.
  A user's own logo can never become the Android launcher icon (a WebAPK builds
  it from the manifest at install time and ignores `apple-touch-icon`) — and as of
  v505 it isn't the iOS Home Screen icon either, so both phones show the same mark.
  See Settings → Business Logo above.
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
- **`doUpdate()` must not unregister the service worker.** Unregistering bought
  zero freshness (the worker is network-first, so it never withholds a new build),
  while on Android it tore down the push subscription (reminders dead until the next
  boot re-subscribed) and dropped the worker that makes the app an installed WebAPK.
  It calls `registration.update()` instead, and deletes every cache EXCEPT `bk-flags`
  — which drops the `bk-shell-v1` offline copy (correct: the update should re-fetch)
  while preserving the "a push arrived" marker, which is state, not content.
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

- **`innerHTML` wipes accessibility, and Home is where that showed (v497).**
  `enhanceA11y()` retrofits `role="button"` + `tabindex` onto the app's tappable
  DIVs (and the keydown handler turns Enter/Space into a click). It ran ONCE over
  the static shell, then only via `rerenderCurrentView()` — so anything redrawn by
  its own renderer kept whatever the last sweep left. Home is the worst case: all
  three login paths call `renderDashboard()` **directly**, never through
  `rerenderCurrentView()`, so the landing page's generated rows had no roles at all
  until the user navigated away and back; the same held for a lazily-expanded widget
  and for every calendar month change. `renderDashCard()` and `renderCalendar()`
  re-run it on what they just wrote.
  **A MutationObserver now does this for every renderer (v502).** Per-renderer calls
  were the fix you have to remember each time, and it was still missed everywhere
  else: typing in the invoice or expense search re-renders that list on every
  keystroke, so do a filter change, the year scope, a status tab, and every save or
  delete — all of them came back as bare `onclick` DIVs until the user left the page
  and returned. Modals that draw their own rows never got a sweep at all, which is
  why the **notification centre had never been keyboard-reachable**. The observer
  watches `document.body` for inserted elements and hands each subtree to
  `enhanceA11y`; it cannot feed itself (it watches `childList`, and `enhanceA11y`
  only sets attributes), a microtask hop batches one render into one sweep, and the
  function is idempotent so the explicit calls above just cost a no-op. **Two rules
  if you touch it:** never add `attributes: true` (that is the self-trigger), and
  keep `enhanceA11y` checking the ROOT node itself — a row inserted by
  `list.innerHTML = rows.map(...)` IS the `[onclick]` div, and a descendants-only
  scan wires the insides of every row and skips the row. `test/a11y.test.mjs` pins
  both against a fake DOM. Its nested-control guard skips an element containing a real
  control (a button inside a `role=button` hides the inner one from assistive tech);
  it used to skip headings too, which disqualified exactly one shape — the fold
  header (`<div class="card-header" onclick="toggle…"><h3>…</h3>`) — i.e. the
  collapse toggle of every widget on Home plus the loan schedule. Headings are fine
  now (the `<h3>` becomes the control's accessible name). Two Home headers DO hold
  real controls (Upcoming's "Event" button, the category card's Month/Year segment):
  there `markFoldState()` wires the **chevron** as the control instead, with
  `stopPropagation()` — without it the header's own onclick fires on the same tap and
  the card toggles twice, back to where it started. `markFoldState` also carries
  `aria-expanded`, and Calendar/Reports (which fold by inline `display`, not the
  `.collapsed` class) get theirs from `setHeaderExpanded()`.
- **A calendar date is read with `ymd()`/`today()`, NEVER `toISOString()` (v496).**
  Every date in this app is a bare `'YYYY-MM-DD'` string a human typed in Montana,
  but `today()` derived that string in UTC — so from 6pm MDT (5pm MST) until
  midnight, the app thought it was TOMORROW. Nothing errored; it just quietly
  disagreed with the wall clock for the last third of every day: an invoice due
  today rendered (and pushed) as **overdue**, tonight's job showed as a **missed
  event** in the bell, the calendar's today-ring and the **Today** button landed on
  tomorrow, and an expense logged after supper **saved with tomorrow's date**. On
  New Year's Eve it moved the *year*, against YTD totals that bucket by local year.
  `parseDate()` has always parsed at LOCAL NOON to dodge exactly this in the other
  direction — `today()` was the hole in the same wall. `ymd(d)` (now declared beside
  `today()`/`parseDate()` as a core primitive) formats a Date's LOCAL parts, and it's
  correct in both hemispheres, which is why the calendar's own cell keys use it too.
  A full timestamp (`clock_in`, audit stamps) is a different thing and still uses
  `toISOString()` — the rule is about truncating an instant to a *day*. **But
  truncating a STORED timestamp is the same bug (v501):** the Time Log's From/To
  filter did `t.clock_in.slice(0,10)`, which is that instant's UTC day, while the row
  beside it printed the LOCAL day (`fmtDayShort`). An evening punch in Montana was
  filed under tomorrow, so filtering Aug 4 → Aug 4 hid an entry the app had just drawn
  as Aug 4, and the header's hours + dollar total — and any "create invoice" selection
  made from that view — silently left it out. `timeDay(t)` = `ymd(new Date(t.clock_in))`
  is the single reader now; use it (or `ymd`) for any instant → day.
  `test/dates.test.mjs` pins the behavior under several timezones AND statically
  rejects both shapes — a new `new Date()…toISOString().slice(0,10)` and a
  `clock_in`/`created_at`/`reminded_at` sliced to a day — because either is one
  plausible-looking line away and reads fine in review. `test/time.test.mjs` covers
  the punch clock's own math (elapsed hours across DST, per-entry vs profile rate).
- **`window.prompt()` is banned — use `askText()`.** It was the entry point for real
  records (a customer name that becomes an invoice) while being unstyled, unreadable on
  a phone, showing the app-lock passcode in clear text, and blocked outright by some
  browsers in an installed PWA. `askText({title, message, label, value, type,
  inputMode, placeholder, hint, okLabel})` returns a Promise with `prompt()`'s exact
  contract: the string, or `null` when cancelled. **The promise must settle on EVERY
  dismiss route** — OK, Cancel, the X, Escape, the backdrop tap and Android back — and
  only two of those call `askCancel()`. That is why `closeModal()` itself settles when
  the id is `modal-ask`, and why `askSettle()` is idempotent. Get this wrong and the
  awaiting call site hangs forever with no error and the sheet already gone from the
  screen. `test/ask.test.mjs` pins all six routes.
- **Deleting an expense row deletes its receipt file — from every path (v502).**
  The row is the only reference to the object, so a receipt left behind is
  unreachable AND still counted against the 1GB storage allowance.
  `deleteExpense` and the expenses bulk-delete did it; the three paths that
  delete an expense as a SIDE EFFECT of an invoice — deleting the invoice,
  bulk-deleting invoices, and removing a billed row from the invoice editor
  (`syncInvoiceExpenses`) — dropped the row and orphaned the photo. All five
  call sites (including `saveExpense` replacing a photo) now go through
  **`removeReceipts(rows)`**, and `test/a11y.test.mjs` fails if a path that
  deletes an expense doesn't call it, or if anything else calls storage remove
  directly. It stays fire-and-forget: an orphaned file is waste, not data loss,
  and must never hold up the delete the user asked for.
- **Receipt photos are downscaled before upload** (`shrinkReceipt`, ~1600px JPEG q0.8,
  reusing `decodeImageForCrop` so iPhone HEIC works). A camera photo is 3–8MB, which is
  a stalled save on rural cell service and ~15× more of the 1GB storage allowance than
  a receipt needs. It returns the ORIGINAL file untouched on any failure, and keeps the
  original if the re-encode didn't actually get smaller — a slow upload always beats a
  lost receipt.
- **`invoiceRevenue(inv, idx)` takes an optional index.** Without it, it re-scans every
  expense; the dashboard's 6-month chart calls it per paid invoice per month, which was
  ~70ms of pure re-scanning per render at ~1500 invoices / 6000 expenses (worse on a
  phone). Loops build `reimbursedByInvoice()` once and pass it. Nothing is memoized on
  purpose — there is no cache to go stale after an expense is edited. `money.test.mjs`
  pins the indexed and scanning paths against each other, because if they ever diverge
  the chart and the P&L report different revenue for the same year.

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
- **A reconcile run can outlive the panel it draws into (v490).** `plaidCheckYear`
  and `plaidPull` are the slowest things in the app, so they're the ones a user
  actually navigates away from — and `#rec-result` is gone once they do. Every
  `out.innerHTML` in that flow (`plaidPull`'s catch, `plaidCheckYear`'s summary,
  `renderReconcile`) now checks `out` first. Two rules when you add another: an
  unguarded write inside a `try` throws INTO the catch and gets reported as a bank
  error — `plaidCheckYear` told the owner "couldn't pull from the bank" for a
  12-month check that had already finished and stamped every mark. And the render
  is the optional half: `renderReconcile` still calls `recordAudit` when `out` is
  null, because the month's verdict is real whether or not there's a panel left to
  show it on.
- **`bankCache()` falls back to `'_'`, like everything else keyed per bank.** The
  audit key (`stmt.bankKey || acctId || '_'`) and `reconBucket()` both fall back to
  `'_'`; the session pull cache used to return a throwaway `{}` instead, so on the
  legacy no-item_id status shape `pullMonthSpan` wrote each month into an object
  nobody could read back — every month looked empty and `plaidCheckYear` crashed on
  the missing bucket. Keep the three fallbacks identical.
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
