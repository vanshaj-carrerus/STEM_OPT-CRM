# STEM OPT & CPT Compliance CRM

Internal CRM for managing F-1 **CPT / OPT / STEM OPT** candidates: profiles, immigration milestones, 12-month reviews,
document vault, reminders & escalation, Gusto payroll tracking, emergency payroll queue, Ria / wire payment ledger,
roles, audit log and reports.

> This is an **operational tracker**, not a legal eligibility engine or payroll processor. Immigration deadlines and
> workflows must be confirmed with each student's DSO / qualified immigration counsel. Payroll completion is **never**
> treated as proof of work authorization.

Stack: Next.js 16 (App Router) · React 19 · Tailwind 4 · TypeScript · MongoDB (Mongoose) · Node worker (node-cron).

## Quick start

```bash
npm install
cp .env.example .env.local        # then fill in values (see below)
npm run seed                      # creates the first Super Admin (no fake candidates are ever seeded)
npm run dev                       # http://localhost:3000
npm run worker                    # in a second terminal: daily reminders / escalation job
```

### Required configuration (`.env.local`)

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB **replica set** connection string (Atlas recommended; transactions need a replica set) |
| `MONGODB_DB` | Database name (default `stem_opt_crm`) |
| `APP_SECRET` | 32+ random chars. Derives encryption/HMAC keys. **Never change after data exists** (it would make encrypted fields unreadable) — back it up securely |
| `EMAIL_USER`, `EMAIL_PASS` (alias `EMAIL_PASSWORD`) | Gmail address + a Google **app password** (16 letters from https://myaccount.google.com/apppasswords — not the normal password; 2-Step Verification must be on). Sends login codes and reminders. If empty, development prints emails to the server console; production refuses to send. `MAIL_MODE=console` forces console mode in development |
| `DOCS_DIR` | Encrypted document storage folder (swap `StorageAdapter` for S3 in production) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | First Super Admin (forced to change password at first sign-in) |
| `GUSTO_WEBHOOK_SECRET`, `RIA_WEBHOOK_SECRET`, `CRON_SECRET` | Optional — only when those integrations/schedulers are enabled |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

### Email check
`npm run email:check` logs in to Gmail and tells you exactly what is wrong if it cannot (nothing is sent). `npm run email:check -- --send-to=you@example.com` also sends one test message. `npm run email:live-otp` sends one real sign-in code through the actual OTP code path to the sender's own mailbox.

### Sign-in flow
Email + password → 6-digit code emailed to the user (10 min, 5 attempts) → session (12 h absolute / 30 min idle).
Accounts lock for 15 minutes after 5 failed passwords; all attempts are rate-limited and audit-logged.

## Security model
- **RBAC + record-level scope** (`src/lib/rbac`): roles per the spec — Super Admin, Compliance Manager/Associate (assigned candidates only),
  Payroll Preparer/Approver, Finance Operator/Approver, Auditor. Sensitive fields (SEVIS ID, EAD #, DOB, EIN, E-Verify ID, payroll amounts,
  payment destination) need separate permissions, are stored AES-256-GCM encrypted with a masked display value, and every reveal is audit-logged.
- **Separation of duties** (`src/lib/sod.ts`): preparer ≠ approver (payroll), requester ≠ approver and dual approval for high-risk payments.
- **Audit log** is append-only (model hooks reject updates/deletes) — see Admin → Audit log.
- **Documents** are encrypted at rest, scanned on upload, and downloaded only through short-lived signed, permission-checked, audited links.
- **Webhooks**: HMAC signature + replay window + unique event ids so duplicate callbacks can never create duplicate records.
- Security headers are set in `next.config.ts`; sessions are httpOnly, `SameSite=Lax`, hashed at rest.

## Integrations (controlled manual workflow first)
- **Gusto**: system of record for payroll. The CRM mirrors state through manual entry / CSV import behind a `GustoAdapter`.
  Gusto's App Integrations API is limited to approved partners (employers are directed to its CLI/MCP) — confirm your account's route in Admin → Settings.
- **Ria**: automation stays **disabled** until Ria approves the business use case in writing *and* API access exists (two checkboxes in Admin → Settings).
  Until then payments are tracked with provider references and reconciled manually.
- **Bank wires**: operator initiates in the bank's approved channel; the CRM records the reference, approvals, evidence and reconciliation.

## Project layout
```
src/lib/rbac, auth, audit, crypto, storage   foundation (security)
src/lib/compliance, reminders, payroll, payments, sod.ts   pure rule engines (unit-tested)
src/lib/candidates, documents, tasks, immigration, import   services
src/app/(auth)   login / OTP / password reset
src/app/(app)    dashboard, candidates, calendar, documents, payroll, emergency-payroll, payments, reports, admin
src/modules/*/candidate-tab.tsx   candidate-detail tabs per module
worker/          background reminder & escalation job
scripts/         seed, dev helpers
tests/           vitest (logic) · tests/db (needs MongoDB: RUN_DB_TESTS=1 npm test)
```
Theme: all colors/radii/typography are CSS variables in `src/app/globals.css` — edit that one file to rebrand.

## Auth & database tooling
`npm run test:db` (DB-backed tests incl. 64 auth + 71 candidate-management tests, scratch database only) · `npm run candidates:smoke` (real-server test of the candidate pages, forms, export and per-role views with synthetic data) · `npm run auth:smoke` (real HTTP end-to-end sign-in / OTP / lockout / reset / session test on a throw-away server + scratch database) · `npm run db:verify` · `npm run db:indexes` · `npm run db:cleanup-scratch`.

## Commands
`npm run dev` · `npm run build` · `npm test` · `RUN_DB_TESTS=1 npm test` · `npm run typecheck` · `npm run worker` · `npm run seed`

## Before production
1. Use MongoDB Atlas (or another replica set) with backups and a **tested restore**; restrict network access.
2. Configure the Gmail sender (`EMAIL_USER`/`EMAIL_PASS`), HTTPS, a secrets manager for `APP_SECRET` and provider secrets; deploy dev/staging/prod separately.
3. Swap local document storage for private object storage with server-side encryption + a real malware scanner (`setScanner`).
4. Import the real roster only after the department supplies and validates its master roster.
5. Have DSO/immigration counsel review the milestone templates and escalation wording; agree retention schedule (Admin → Settings) and incident-response process.
6. Run an access-review and security test pass (RBAC matrix, restricted-field access, webhook replay/duplicates).
