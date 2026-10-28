# Security Policies

Internal security policy documents for Case Johnston Computer Repair, LLC (the Bookkeeper
application). These support the Plaid security-diligence remediation attestations.

## Documents

- [Information Security Policy (ISP)](information-security-policy.md)
- [Access Control Policy (incl. Zero Trust)](access-control-policy.md)
- [Vulnerability Management Policy](vulnerability-management-policy.md)
- [Plaid requirements map & security pass](plaid-requirements.md) — what Plaid asks for, where
  each answer lives, the code checks behind them, and the open gaps. Re-run every quarter.

The Privacy Policy and Data Retention & Disposal Policy live at the project root
(`privacy.html`, `data-retention-policy.html`) because they are published to end users.

## Attestation coverage

| Plaid attestation | Covered by |
|---|---|
| Zero trust access architecture | Access Control Policy §3 |
| Defined & documented access control policy | Access Control Policy |
| Periodic access reviews and audits | Access Control Policy §7 |
| Automated de-provisioning for terminated/transferred employees | Access Control Policy §6 |
| Monitors EOL software + updates policy | Vulnerability Management Policy §5 |
| Performs vulnerability scanning | Vulnerability Management Policy §3 (GitHub CodeQL/Dependabot/Secret Protection) |
| Patches vulnerabilities within a defined SLA | Vulnerability Management Policy §4 |
| Information Security Policy (ISP) | Information Security Policy |
| MFA before Plaid Link is surfaced / client 2FA | Access Control Policy §3 (server-enforced since v517) |
| Data deletion & retention policy | `data-retention-policy.html` (corrected 2026-10-28) |

The full Plaid security-questionnaire mapping — including the questions these documents do
**not** cover yet — is in [plaid-requirements.md](plaid-requirements.md).

Reviewed at least annually. Owner: Case Johnston — casejohnstoncomputerrepair@hotmail.com
