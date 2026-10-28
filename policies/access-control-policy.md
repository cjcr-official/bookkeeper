# Access Control Policy (including Zero Trust Architecture)

**Organization:** Case Johnston Computer Repair, LLC ("the Company")
**Application:** Bookkeeper
**Owner:** Case Johnston, Owner
**Effective date:** July 10, 2026
**Review cadence:** At least annually and at each access review.

---

## 1. Purpose

This policy defines how access to Bookkeeper's production systems and sensitive data is
granted, authenticated, restricted, reviewed, and revoked. It documents the Company's
**zero-trust access architecture** and supports the related Plaid attestations.

## 2. Scope

Covers access to all production assets: the Supabase project (database, auth, storage), the
Cloudflare Worker and dashboard, the GitHub repository, the Plaid dashboard, and the data
these systems hold. The Company has no employees; the owner is the only person with access.

## 3. Zero-trust access architecture

The Company applies zero-trust principles. No user, device, or request is trusted based on
its network location; trust is established per request through explicit verification.

- **No implicit network trust.** There is no trusted internal network. Every component is
  reached only through internet-facing, authenticated APIs over TLS. Access depends on
  identity and authorization, never on network position.
- **Per-request authentication and authorization.** Postgres **Row Level Security** evaluates
  the caller's identity (`auth.uid()`) on **every database query**; a request without a valid
  token receives no data. The Cloudflare Worker independently verifies the caller's bearer
  token on every privileged request before acting.
- **Least privilege.** Each user can access only their own rows (`auth.uid() = user_id`). The
  browser is limited to the "authenticated" role; the privileged service key is held
  server-side only and is never exposed to clients. Bank access tokens live in a table with
  Row Level Security enabled and no client-readable policy — only the Worker's service key can
  read them.
- **Explicit, strong verification — enforced on the server.** Bank data requires a password
  **plus** a time-based one-time passcode (TOTP) entered **in the current session**. The Worker
  reads the session's assurance level (`aal`) after verifying the token and refuses Plaid Link,
  token exchange, transaction pulls and bank refreshes to any session below `aal2` — so a stolen
  password alone, or a "remembered" device that skipped the code at sign-in, cannot reach bank
  data. A user without a verified TOTP factor cannot use bank sync at all. Disconnecting a bank
  is deliberately *not* gated: removing access is never harder than granting it.
- **Device verification before Plaid Link.** In addition, the app requires a platform
  passkey / biometric check (Face ID / fingerprint via WebAuthn, user verification required)
  before Plaid Link opens. This is a device-level check performed in the browser; the
  server-enforced factor is the TOTP requirement above.
- **Assume breach.** Secrets are never shipped to the browser; all data is encrypted in transit
  and at rest; sessions expire and are re-verified.

**Applicability note:** device-posture checks and continuous session re-evaluation beyond
token expiry are not implemented, as they are not applicable to a single-operator, serverless
application with no managed endpoints or corporate network.

## 4. Authentication requirements

- All accounts (Supabase, Cloudflare, GitHub, Plaid) require a strong, unique password and
  multi-factor authentication; phishing-resistant methods (passkeys/biometrics) are used where
  supported.
- End users of the application authenticate via Supabase Auth over HTTPS, with optional
  account-level MFA and an on-device passcode / Face ID app lock. **MFA is mandatory for bank
  sync** and is enforced by the Worker (see §3).
- Self-service registration is closed: accounts are created only through the Worker's
  invite-gated `/signup`, and Supabase's public sign-up is disabled in the dashboard.

## 5. Authorization model (role-based access control)

- **End user (authenticated role):** may read and write only their own records, enforced by
  Row Level Security.
- **Service (non-human):** the Cloudflare Worker uses a service key / OAuth-style bearer tokens
  and TLS to act on the backend; used only for operations that must bypass client restrictions
  (e.g., managing bank tokens).
- **Administrator (owner):** full administrative access to the provider dashboards, protected
  by MFA.

## 6. Provisioning and de-provisioning

- The Company has **no employees or contractors**, so there is no workforce access to grant or
  revoke. Administrative access consists solely of the owner's accounts.
- **If this changes** (a contractor or employee is ever engaged): access will be granted on a
  least-privilege, time-limited basis, and **removed immediately upon termination or role
  change** by disabling/removing the individual's accounts and rotating any shared secrets.
- **End-user de-provisioning is automated in-product:** a user can permanently delete their
  account and all associated data at any time (Settings › Account › Delete account), which
  revokes bank tokens and removes the login; the owner can also action deletion on request.

## 7. Periodic access reviews

The owner performs an access review **at least quarterly** (next due within three months of
the last row below), confirming for each system (Supabase, Cloudflare, GitHub, Plaid):
(a) only authorized accounts have access, (b) MFA is enabled, and (c) no stale credentials or
unused tokens remain. Linked bank connections are reviewed and any no-longer-needed connections
are disconnected. Each review is recorded below.

**Checklist for each review** (the Plaid-specific items are mapped in
[`plaid-requirements.md`](plaid-requirements.md)):

1. **Supabase** — dashboard members; Auth → Users lists only expected accounts; "Allow new users
   to sign up" is **off**; every app user with a linked bank has a verified TOTP factor.
2. **Cloudflare** — account members; Worker secrets list matches CLAUDE.md (drop unused ones,
   e.g. `ANTHROPIC_API_KEY`); `SIGNUP_CODE` is **unset** unless an invite is in progress.
3. **GitHub** — collaborators and deploy keys; CodeQL, Dependabot and secret-scanning alerts
   open/closed within the Vulnerability Management SLAs.
4. **Plaid** — team members and their MFA; API keys (rotate the secret if anyone else ever saw
   it); production Items in the dashboard match the banks shown in the app — remove any orphan.
5. **Code** — re-run the Plaid security pass in `plaid-requirements.md` §B against the current
   Worker and `node test/plaid.test.mjs`.

| Review date | Systems reviewed | Findings / actions |
|---|---|---|
| 2026-07-10 | Supabase, Cloudflare, GitHub, Plaid | Initial review — sole owner access confirmed; MFA enabled; no stale access. |
| 2026-10-28 | Plaid integration (code + policies); Supabase, Cloudflare, GitHub, Plaid dashboards **pending owner confirmation** | Q4 review (was due 2026-10-10). **Code pass — 4 findings, all fixed in v517:** (1) 2FA before bank access was enforced only in the browser — the Worker now requires an `aal2` session for Link, exchange, transaction pulls and refresh; (2) disconnect and account deletion deleted the stored token even when Plaid's revoke failed, leaving an unrevokable live connection — the token is now kept and the user told to retry; (3) a failed token save after linking left a live Item at Plaid with no token — the Item is now revoked; (4) the privacy, retention and information-security policies said no Plaid transaction data is stored — corrected to list the reconciliation references that are. Tests: `test/plaid.test.mjs`. **Open items:** see `plaid-requirements.md` §C. **Dashboard checks (checklist items 1–4): to be confirmed by the owner — not yet verified this quarter.** |

## 8. Secrets management

Application secrets (service keys, Plaid credentials, VAPID keys) are stored only as managed
platform secrets (Cloudflare Worker secrets) and are never committed to source control.
GitHub Secret Protection and push protection are enabled to detect and block accidental
secret commits. Secrets are rotated on suspicion of compromise.

## 9. Review

This policy is reviewed at least annually and at each quarterly access review.
