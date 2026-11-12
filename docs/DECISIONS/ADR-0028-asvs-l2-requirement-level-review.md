# ADR-0028 — Requirement-level ASVS 5.0 L2 self-assessment as code, and the gaps it closed

Status: Accepted (v0.6.6). Owning module: security. Gate S-06 (code-level part).

**Context.** The ASVS document was a chapter-level summary (17 rows). Gate S-06 asks for the
applicable OWASP ASVS 5.0.0 Level 2 controls; a chapter summary cannot show which of the 253
L1+L2 requirements are met, by what evidence, and it drifted from the code between versions.

**Decision — assessment as code.**

- `docs/security/asvs/asvs-5.0.0-l1-l2.json`: requirement ids, levels and chapter/section names
  taken from the official 5.0.0 CSV (sha256 recorded). Requirement texts are not copied (CC BY-SA
  4.0); readers use the standard.
- `docs/security/asvs/assessment.json`: one entry per id with status `I+T`, `I`, `P`, `O`, `ENV`
  (deployment control, cannot be verified without the target environment) or `N/A`, evidence
  paths and a note.
- `scripts/asvs-report.mjs` validates (every id once, known status, evidence exists, `I+T` cites
  a test file, notes present) and renders `docs/security/ASVS_L2_ASSESSMENT.md`
  (`pnpm asvs:render`, `pnpm asvs:check`). `tests/security/asvs-assessment.test.ts` runs the check
  and proves it fails on bad input, so the assessment cannot silently rot.

**Decision — gaps found and closed in v0.6.6.**

| ASVS 5.0                  | Gap                                                          | Change                                                                                                                               |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| V7.4.5                    | admins could not end a user's or all sessions (only via SQL) | `POST /api/admin/users/{id}/sessions/revoke`, `POST /api/admin/sessions/revoke-all` (admin.security + step-up, audited, caller kept) |
| V7.5.2                    | ending other own sessions needed no fresh factor             | step-up `account.sessions.revoke` (ending the current session = logout, unchanged)                                                   |
| V6.2.4                    | common list had ~200 entries, few of policy length           | top 5000 policy-length passwords (SecLists, MIT) as SHA-256 prefixes, generator script                                               |
| V6.1.2/V6.2.11            | no documented context-word list; display name unused         | documented list + company code/name + display name; rejected when < 8 characters remain after removing them                          |
| V6.5.2                    | 80-bit recovery codes stored as unsalted SHA-256             | new codes 120 bits (6 × 4 base32); legacy codes accepted until used/regenerated                                                      |
| V3.5.3                    | Fetch-Metadata check only on writes                          | `Sec-Fetch-Site: cross-site` refused on every API request                                                                            |
| V14.3.1                   | logout did not clear browser data                            | `Clear-Site-Data: "cache", "storage"`                                                                                                |
| V11.1.1/2, V7.1.2, V6.1.3 | missing documents                                            | crypto inventory + key lifecycle, concurrent-session policy, authentication pathways table                                           |
| V7.3.x, V12.3.2, V13.4.4  | untested controls                                            | tests for idle/absolute expiry, production `DB_SSL=verify-full` interlock, TRACE not routed                                          |

**Not closed (honest residue).** V6.4.4 identity proofing on MFA loss is procedural (P);
V12.3.1/V13.2.4 depend partly on deployment (P); V16.3.3 input-validation failures and per-IP
429s are only in the application log (P); 13 `ENV` items need the target environment; the whole
document is a self-assessment until an independent assessor verifies it (SEC-OPEN-002).

**Alternatives.** Keeping the chapter summary (no traceability); storing requirement texts (licence
share-alike obligations, larger diff noise); a spreadsheet (not reviewable in pull requests, no
CI check).

**Maintenance.** Any change to authentication, sessions, headers, crypto or logging updates the
matching entries in `assessment.json` in the same commit, then `pnpm asvs:render`. When OWASP
publishes 5.0.x/5.1, regenerate the canonical id file from the new CSV; the test lists ids that
are new or gone.
