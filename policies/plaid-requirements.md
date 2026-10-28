# Plaid Requirements Map & Security Pass

**Organization:** Case Johnston Computer Repair, LLC · **Application:** Bookkeeper
**Last pass:** 2026-10-28 (app v517) · **Cadence:** every quarterly access review
(Access Control Policy §7, checklist item 5)

This is the working document behind the Plaid attestations: what Plaid asks for, where the
answer lives, the code checks that back it up, and what is still open. The policies in this
folder say what the Company does; this file is how to check it's still true.

> **About the research.** Plaid's own pages (plaid.com/docs, the Launch Center) could not be
> fetched from the environment this pass ran in, so the question list below comes from a public
> copy of the Plaid Security Questionnaire (v6) plus Plaid's published docs as quoted in search
> results. **The authoritative list is the one in your Plaid Dashboard** (Launch Center →
> security questionnaire / attestations). Check it against this file each quarter and add any
> question that is new.

---

## A. What Plaid asks for

### A1. Security questionnaire (v6 controls)

Status: ✅ covered and evidenced · ⚠️ partly / answer carefully · ❌ not covered by a written
policy yet (answer honestly; "not applicable, sole operator" is a legitimate answer where true).

| # | Control (Plaid id) | Status | Where the answer lives / honest answer |
|---|---|---|---|
| 1 | Hosting (`inf_sec_hosting`) | ✅ | Cloud: Cloudflare Workers + Supabase. ISP §8. |
| 2 | Documented ISP + operating program (`inf_sec_governance`) | ✅ | Information Security Policy. |
| 3 | Endpoint discovery / monitoring (`inf_sec_endpoint_visibility`) | ❌ | No self-managed network; the only endpoint is the owner's device. Not written down — add to ISP if Plaid asks. |
| 4 | Vulnerability scanning + patch SLA (`inf_sec_vulnerability_management`) | ⚠️ | Vulnerability Management Policy §3–4. CodeQL/Dependabot are configured in GitHub **settings**, not in this repo (there is no `.github/` folder) — confirm they're on (§C8). |
| 5 | Anti-malware on all machines (`inf_sec_malicious_code`) | ❌ | Not in any policy. Owner device: OS built-in protection + automatic updates (Vuln. Mgmt §6). Add a line to the ISP. |
| 6 | BYOD (`inf_sec_personal_devices`) | ❌ | Not in any policy. Sole operator; the owner's device is the work device. |
| 7 | Access request / grant / review / revoke (`inf_sec_access_governance`) | ✅ | Access Control Policy §6–7. |
| 8 | Strong auth (2FA) on production assets (`inf_sec_access_authentication`) | ✅ | Access Control Policy §4 — all provider dashboards on MFA. Confirm each quarter (§7 checklist). |
| 9 | Defined build/release process (`inf_sec_change_governance`) | ✅ | Branch → PR → merge to `main` → Cloudflare Workers Builds auto-deploy (CLAUDE.md). |
| 10 | Testing before deploy (`inf_sec_change_testing`) | ⚠️ | 17 test suites under `test/` plus syntax checks, run before each merge. Not enforced by CI (no workflow in repo). |
| 11 | Code review/approval before deploy (`inf_sec_change_code_reviews`) | ⚠️ | Every change goes through a PR, but merges are automatic with no second human reviewer (sole operator). Say so. |
| 12 | TLS 1.2+ (`inf_sec_encrypt_in_transit`) | ✅ | ISP §6; HSTS + `upgrade-insecure-requests` set by the Worker. |
| 13 | Plaid data encrypted at rest (`inf_sec_encrypt_at_rest`) | ✅ | Supabase encrypts at rest (AES-256). Access tokens are not additionally app-encrypted (§C3). |
| 14 | Audit trails / logs (`inf_sec_audit_trail`) | ⚠️ | Cloudflare Worker logs, Supabase logs, GitHub audit log. No retained application audit trail of bank actions. |
| 15 | Real-time monitoring & alerting (`inf_sec_monitoring_alerting`) | ⚠️ | GitHub security alerts + provider notifications only. No alerting on Worker errors. |
| 16 | Incident management (`inf_sec_incident_management`) | ✅ | ISP §10. |
| 17 | Network segmentation (`inf_sec_network_segmentation`) | ⚠️ | No network to segment (serverless). Zero-trust per-request auth instead: Access Control §3. |
| 18 | Security awareness training (`inf_sec_awareness_training`) | ❌ | Not in any policy. No employees. |
| 19 | Vendor intake & monitoring (`inf_sec_vendor_management`) | ❌ | Vendors are Cloudflare, Supabase, Plaid, GitHub, PolicyEngine (tax estimate — receives profit figures only, no bank data). Not written down. |
| 20 | Independent audit / pen test (`inf_sec_independent_testing`) | ❌ | None. Answer "No". |
| 21 | Background checks (`inf_sec_hr_screening`) | ❌ | No employees or contractors — N/A. |
| 22 | Consumer consent (`privacy_consumer_consent`) | ✅ | The user starts every bank link; Plaid Link shows its own consent pane; `privacy.html` explains it and links Plaid's End User Privacy Policy. |
| 23 | Deletion & retention policy (`privacy_data_minimization`) | ✅ | `data-retention-policy.html` — **corrected 2026-10-28** (it said no Plaid transaction data is stored; reconciliation references are). |
| 24 | Do you sell consumer data? (`privacy_data_usage`) | ✅ | No. `privacy.html`. |
| 25 | 2FA on the client app (`client_2fa`) | ⚠️ | TOTP. **Mandatory and server-enforced for bank data** (since v517). Optional for plain app sign-in, and that part is enforced only in the browser (§C1). |

### A2. Attestations (Plaid Dashboard)

| Attestation | Where |
|---|---|
| Information Security Policy | Information Security Policy |
| Defined & documented access control policy | Access Control Policy |
| Zero-trust access architecture | Access Control Policy §3 |
| Role-based access control | Access Control Policy §5 |
| Periodic access reviews and audits | Access Control Policy §7 (log + checklist) |
| Automated de-provisioning | Access Control Policy §6 (no workforce; in-app account deletion) |
| Vulnerability scanning | Vulnerability Management Policy §3 |
| Patching within a defined SLA | Vulnerability Management Policy §4 |
| EOL software monitoring | Vulnerability Management Policy §5 |

### A3. Integration requirements from Plaid's docs

| Requirement | Status | Notes |
|---|---|---|
| Application profile + company profile (needed for OAuth banks) | Dashboard | Plaid says to finish these and the questionnaire early — some banks won't connect until they're approved. |
| Access tokens kept server-side only | ✅ | `plaid_items`, service-key only; no response ever carries a token (§B1). |
| `client_user_id` is a stable, non-PII id | ✅ | The Supabase user UUID. |
| Link loaded from Plaid's CDN | ✅ | `cdn.plaid.com/link/v2/stable/link-initialize.js` — Plaid requires its hosted copy, so it can't be version-pinned or SRI'd; the CSP allows exactly that host. |
| Items removed (`/item/remove`) when the user disconnects or deletes their account | ✅ | Fixed v517 to only forget the token after Plaid confirms (§B5). |
| Handle `ITEM_LOGIN_REQUIRED` via update-mode Link | ✅ | `/plaid/refresh` → `needs_reauth` → update-mode Link, same `item_id`. |
| Prefer `/transactions/sync` for new integrations | ⚠️ | We use `/transactions/get` for date-range pulls. Still supported; Plaid recommends sync for new builds. Not a security issue (§C5). |
| Webhooks | n/a | None configured, so there's no unauthenticated inbound endpoint to verify. Trade-off: a revoked or expiring connection is discovered on the next pull, not pushed. |

---

## B. Code security pass — what to check each quarter

Run `node test/plaid.test.mjs` first; it drives the real Worker router for B4–B5.

| # | Check | 2026-10-28 result |
|---|---|---|
| B1 | No response body carries `access_token`; `/plaid/status` returns only `item_id` + institution | ✅ |
| B2 | `plaid_items` has RLS **on** and **no** policies (Supabase → Table editor) | Owner to confirm in the dashboard — can't be read from the repo |
| B3 | Every `/plaid/*` route authenticates the caller with GoTrue, and every item lookup is filtered to that user's own rows; the service-key DELETE is itself scoped by `user_id` | ✅ |
| B4 | Bank-data routes (Link token, exchange, transactions, refresh) require an `aal2` session | ❌ → ✅ **fixed v517**. Only the browser checked for 2FA; a password-only token reached all of them. |
| B5 | A token is never deleted unless Plaid confirmed the revoke; a token that can't be stored is revoked | ❌ → ✅ **fixed v517**. Disconnect and account deletion dropped the token even when `/item/remove` failed; a failed save after exchange left a live Item behind. |
| B6 | No secret or token in logs — only Plaid's error object (code, message, request id) | ✅ |
| B7 | Plaid credentials only as Worker secrets; none in the repo | ✅ (pattern scan of the repo found none) |
| B8 | Transport: HSTS, CSP `connect-src` limited to self / Supabase / `*.plaid.com` | ✅ |
| B9 | Data minimization: `products: ['transactions']` only; `days_requested: 730` (needed for 12-month checks + neighbours); accounts trimmed to name / mask / subtype | ✅ |
| B10 | Input validation: dates must be `YYYY-MM-DD`; `item_id` only ever matched against the caller's own items | ✅ |
| B11 | No CORS headers + bearer-token auth (no cookies), so no cross-site reads or CSRF | ✅ |
| B12 | Unknown `PLAID_ENV` falls back to **sandbox**, never production | ✅ |
| B13 | Policies describe the Plaid data actually stored | ❌ → ✅ **fixed 2026-10-28** (ISP §4, privacy policy, retention policy). |

---

## C. Open items — owner decisions, not yet done

1. **App sign-in 2FA is enforced only in the browser.** RLS checks `auth.uid()` but not
   `aal`, so a password-only session can still read the user's *books* (not bank data — that's
   now server-gated) straight from Supabase. The fix is Supabase's documented restrictive-policy
   pattern (require `aal2` for users who have a verified factor) on every table. It would also
   end "remember this device", which leaves sessions at `aal1` — that's why it's a decision,
   not a quiet fix.
2. **The passkey gate before Plaid Link runs only in the browser** (the WebAuthn challenge is
   made and checked on the device). Policies now call it a device check. Server-verified
   WebAuthn would make it a real second factor.
3. **Access tokens are encrypted at rest by Supabase, not by the app.** A leaked token is
   useless without `PLAID_CLIENT_ID` + `PLAID_SECRET`, which live only in Cloudflare. Optional
   hardening: AES-GCM the token in the Worker with a key held as another Worker secret.
4. **No rate limit on `/plaid/*`.** Low risk (invite-only), but `/transactions/refresh` is a
   billed call.
5. **`/transactions/get` → `/transactions/sync`** — Plaid's recommendation for new builds.
   Functional change, not security.
6. **Provider dashboard checks for the 2026-10-28 review** (Access Control §7 checklist 1–4)
   still need the owner's confirmation.
7. **Questionnaire controls with no written policy:** #3, #5, #6, #18, #19 (A1). A short
   "Endpoint, vendor and personnel security" section in the ISP would cover them truthfully.
8. **Confirm CodeQL, Dependabot and secret scanning are on** under GitHub → Settings → Code
   security. Nothing in the repo shows it, and the Vulnerability Management Policy relies on it.
9. **Reconciliation references outlive a disconnected bank** so history can be restored after a
   reconnect. That's now disclosed; if Plaid wants them purged on disconnect, that's a small
   change.

---

## Sources

- Plaid Security Questionnaire (v6), public copy: <https://gist.github.com/coolaj86/0c17836066362d812006314ffc36ef13>
- Plaid — Launch in Production checklist (replaced by the Dashboard's Launch Center): <https://plaid.com/docs/launch-checklist/>
- Plaid — Link OAuth guide (security questionnaire, application & company profile): <https://plaid.com/docs/link/oauth/>
- Plaid — Transactions API (`/transactions/sync` recommended for new builds): <https://plaid.com/docs/api/products/transactions/>
- Plaid — Trial plan / production access: <https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan>
- Another developer's Plaid attestation list (access reviews): <https://github.com/mattssawyer/money-buckets/issues/101>
