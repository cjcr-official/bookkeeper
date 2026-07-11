# Information Security Policy (ISP)

**Organization:** Case Johnston Computer Repair, LLC ("the Company")
**Application:** Bookkeeper
**Owner:** Case Johnston, Owner
**Effective date:** July 10, 2026
**Review cadence:** At least annually, and after any material change to how the application stores or processes data.

---

## 1. Purpose

This Information Security Policy defines how the Company protects the confidentiality,
integrity, and availability of the data handled by the Bookkeeper application, including
personal and financial information and any data obtained through the Plaid API. It is the
top-level policy; the **Access Control Policy** and **Vulnerability Management Policy**
provide supporting detail.

## 2. Scope

This policy applies to all systems, data, and services used to operate Bookkeeper:

- The single-page web application (`index.html`) delivered as an installable PWA.
- The backend data platform (Supabase: hosted Postgres, Auth, and Storage).
- The hosting/compute layer (a single Cloudflare Worker).
- The source-code repository (GitHub).
- The bank-data provider integration (Plaid).
- The owner's work device used to develop and administer the above.

The Company is a sole proprietorship with no employees; the owner is responsible for
implementing and enforcing this policy.

## 3. Roles and responsibilities

The owner is solely responsible for information security, including administering access,
applying updates, monitoring alerts, responding to incidents, and reviewing this policy.
Security contact: **casejohnstoncomputerrepair@hotmail.com**.

## 4. Data classification

- **Sensitive:** consumer financial data, bank account access tokens, authentication
  credentials, and application secrets.
- **Confidential:** user-entered business records (invoices, customers, expenses, etc.).
- **Public:** the privacy policy, marketing/app description.

Bank transaction data retrieved from Plaid is **not stored** (pulled live for reconciliation);
the only Plaid-derived item retained is the access token, held server-side only.

## 5. Access control

Access is governed by the Company's **Access Control Policy**, which implements a
zero-trust posture: no implicit trust by network location, per-request authentication and
authorization (Postgres Row Level Security on every query), least-privilege roles, and
multi-factor / passkey authentication. See that policy for detail.

## 6. Data protection

- **In transit:** all traffic uses TLS 1.2 or higher (HTTPS).
- **At rest:** all stored data is encrypted at rest by the Supabase platform.
- **Isolation:** Row Level Security restricts every record to its owning user
  (`auth.uid() = user_id`).
- **Secrets:** bank access tokens and application secrets are stored server-side only
  (Cloudflare Worker secrets / a service-key-only table) and are never exposed to the browser.

## 7. Vulnerability and patch management

Managed under the Company's **Vulnerability Management Policy**: automated code scanning
(GitHub CodeQL), dependency and secret scanning (Dependabot, GitHub Secret Protection),
defined remediation SLAs, and end-of-life (EOL) software monitoring. Server and OS patching
is handled by the managed providers (Cloudflare, Supabase); the owner's device is kept on
automatic security updates.

## 8. Infrastructure security

The application runs on managed, serverless infrastructure. The Company operates no
self-managed servers. Provider-level security (physical security, network security, host
patching, backups) is the responsibility of Cloudflare and Supabase under their respective
security programs.

## 9. Logging and monitoring

Application and platform logs are available through the Cloudflare and Supabase dashboards
and GitHub's security alerts. The owner reviews security alerts (Dependabot, code scanning,
secret scanning) as they are raised.

## 10. Incident response

On discovering a suspected security incident, the owner will: (1) contain the issue (e.g.,
rotate affected credentials/secrets, revoke Plaid tokens, disable affected access);
(2) assess scope and impact; (3) remediate the root cause; (4) notify affected users and any
required parties (including Plaid) where applicable; and (5) record the incident and any
follow-up actions.

## 11. Data retention and disposal

Governed by the Company's **Data Retention and Disposal Policy**. Users can delete individual
records, disconnect a bank, or permanently delete their entire account and all data from
within the application.

## 12. Policy review

This policy and its supporting policies are reviewed at least annually and updated as needed.
The owner records the date of each review.

| Review date | Reviewed by | Notes |
|---|---|---|
| 2026-07-10 | Case Johnston | Initial version. |
