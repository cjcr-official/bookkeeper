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
- **Explicit, strong verification.** Authentication requires a password plus multi-factor
  authentication (time-based one-time passcode) and a platform passkey / biometric (Face ID /
  Touch ID via WebAuthn) is required before linking a bank. MFA must be enabled before a bank
  can be connected.
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
  account-level MFA and an on-device passcode / Face ID app lock.

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

The owner performs an access review **at least quarterly**, confirming for each system
(Supabase, Cloudflare, GitHub, Plaid): (a) only authorized accounts have access, (b) MFA is
enabled, and (c) no stale credentials or unused tokens remain. Linked bank connections are
reviewed and any no-longer-needed connections are disconnected. Each review is recorded below.

| Review date | Systems reviewed | Findings / actions |
|---|---|---|
| 2026-07-10 | Supabase, Cloudflare, GitHub, Plaid | Initial review — sole owner access confirmed; MFA enabled; no stale access. |

## 8. Secrets management

Application secrets (service keys, Plaid credentials, VAPID keys) are stored only as managed
platform secrets (Cloudflare Worker secrets) and are never committed to source control.
GitHub Secret Protection and push protection are enabled to detect and block accidental
secret commits. Secrets are rotated on suspicion of compromise.

## 9. Review

This policy is reviewed at least annually and at each quarterly access review.
