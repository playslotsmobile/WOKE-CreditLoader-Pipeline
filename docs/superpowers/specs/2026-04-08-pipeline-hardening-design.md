# CreditLoader Pipeline Hardening — Design Spec

**Date:** 2026-04-08
**Status:** Approved
**Scope:** Harden the entire CreditLoader pipeline for reliability, safety, observability, and operational confidence.

---

## Problem Statement

The CreditLoader pipeline handles real money — converting vendor payments into gaming platform credits via browser automation on Play777 and IConnect. The system works but lacks the safety nets needed for production confidence:

- Browser automation failures are invisible (no screenshots, no event trail)
- Correction and chain load flows can lose credits on partial failures with no rollback or audit trail
- Server-side validation is missing — backend trusts frontend-submitted amounts
- Logging is unstructured console output — diagnosing failures requires reading raw journalctl
- Webhook processing is fire-and-forget — server crash during processing loses the payment
- AdsPower (browser automation proxy) is a single point of failure with no auto-recovery
- Zero automated tests — code changes can break production with no warning
- Deployment is manual and error-prone

**Volume:** 5-20 loads per day. Sequential processing is acceptable; reliability per-load is critical.

**Constraint:** Play777 and IConnect have no APIs. Browser automation through AdsPower is the only path.

---

## Section 1: Browser Automation Resilience

### 1.1 Screenshot on Failure

Every time a browser operation fails (load, correction, login, navigation), capture:
- Full-page screenshot saved to `/var/log/creditloader/failures/{invoiceId}-{step}-{timestamp}.png`
- Page HTML snapshot saved alongside as `.html`
- Current URL logged

Implementation: wrap all Playwright actions in a try/catch that captures diagnostics before re-throwing.

### 1.2 Robust Element Finding

Replace hardcoded CSS selectors with a fallback chain strategy. For each critical element (deposit button, modal inputs, confirm button), try multiple selectors in order:

```
Example for deposit button:
1. button:has-text("Deposit")
2. .modal-footer button.btn-primary
3. form button[type="submit"]
4. page.evaluate(() => find button by innerText)
```

If all selectors fail, capture screenshot and fail with descriptive error.

### 1.3 Session Reuse

Currently each load in a multi-account invoice launches a new AdsPower profile. Change to:
- Launch profile once per invoice processing run
- Keep browser open between loads for the same invoice
- Only close after all loads for that invoice complete (or on fatal error)
- Reduces login frequency and rate limit exposure

### 1.4 Adaptive Waits

Replace hardcoded `humanDelay()` after navigation with:
- `waitForSelector` with reasonable timeouts for critical elements
- Keep `humanDelay()` only between user-like actions (typing, clicking) for anti-detection
- Add page load readiness checks (wait for table row count > 0, not just DOM attached)

### 1.5 2FA Detection & Handling

When 2FA is triggered during login:
1. Send Telegram alert: "Play777 requires 2FA. Enter code via dashboard or VNC within 5 minutes."
2. Expose temporary endpoint `POST /api/admin/2fa-code` that accepts `{code}` 
3. Browser stays open, polling for the code every 5 seconds
4. On code received: enter it, submit, continue with the load
5. On 5-minute timeout: fail gracefully, close browser, mark load as FAILED with "2FA timeout" error
6. Log a LoadEvent for the 2FA interaction

### 1.6 AdsPower Auto-Recovery

If `getBrowserContext()` fails to connect to AdsPower:
1. Stop the profile via API (in case it's stuck)
2. Wait 5 seconds, retry profile start
3. If still failing: restart AdsPower systemd service
4. Wait 15 seconds for AdsPower to initialize
5. Retry profile start one final time
6. Only fail after all recovery attempts exhausted

---

## Section 2: Correction & Chain Load Safety

### 2.1 Balance Verification

Before and after each load step, verify the balance changed correctly:

**Before deduct (correction):**
- Navigate to vendor's Balance History (click vendor name → popup → Balance History tab)
- Record current balance as `balanceBefore`
- Proceed with deduct

**After deduct:**
- Check Balance History for a new transaction matching our amount and type
- If transaction not found within 60 seconds: abort, screenshot, alert admin
- Record `balanceAfter`

**After deposit (correction or regular):**
- Same verification: check target account's Balance History
- Confirm new deposit transaction appears
- Record `balanceAfter`

**For chain loads (vendor → operator):**
- After vendor deposit: verify vendor balance increased
- After operator chain deposit: verify operator balance increased
- If operator load fails: alert includes "Credits sitting in vendor account — manual operator load needed"

### 2.2 Master Balance Audit

After all loads for an invoice complete successfully:
- Navigate to History → My Balance
- Verify outgoing transactions match total credits loaded
- Log the verification result as a LoadEvent

### 2.3 LoadStep Audit Trail

New DB model to track each step of multi-step loads:

```prisma
model LoadStep {
  id             Int      @id @default(autoincrement())
  loadJobId      Int      @map("load_job_id")
  step           String   // VENDOR_DEPOSIT, OPERATOR_CHAIN, CORRECTION_DEDUCT, CORRECTION_DEPOSIT
  accountId      Int      @map("account_id")
  credits        Int
  status         String   // PENDING, SUCCESS, FAILED, VERIFIED, UNVERIFIED
  balanceBefore  Int?     @map("balance_before")
  balanceAfter   Int?     @map("balance_after")
  screenshotPath String?  @map("screenshot_path")
  error          String?
  createdAt      DateTime @default(now()) @map("created_at")

  loadJob LoadJob @relation(fields: [loadJobId], references: [id])

  @@index([loadJobId])
  @@map("load_steps")
}
```

### 2.4 Actionable Failure Alerts

When a correction or chain load partially fails, Telegram alert includes:
- Which step succeeded and which failed
- Account names and credit amounts involved
- Exact manual recovery steps needed
- Screenshot of the failure state

Example: "Correction for Cesar Rivera partially failed. Deducted 500 credits from CR1234 (verified). Deposit of 500 to DSilva777 FAILED: modal submit timeout. Manual deposit needed via Play777 dashboard. Screenshot: [link]"

---

## Section 3: Server-Side Validation

### 3.1 Credit Recalculation

On `POST /api/submit-invoice`:
- Fetch vendor account rates from DB
- Recalculate `credits = floor(dollarAmount / rate)` for each allocation
- Compare against frontend-submitted credits
- Allow rounding tolerance of +/- 1 credit
- Reject if mismatch exceeds tolerance

### 3.2 Amount Validation

- Verify `sum(allocation.dollarAmount) == baseAmount` (within $0.01 tolerance)
- Enforce $1,000 minimum for Card/ACH methods
- Reject negative amounts, zero-credit allocations
- Reject allocations with `dollarAmount > 0` but `credits == 0`

### 3.3 Account Ownership Verification

- Verify each `accountId` in allocations belongs to the vendor identified by `vendorSlug`
- Verify account `loadType` matches the submission type (correction accounts only for corrections, vendor/operator for invoices)
- Reject if any account doesn't belong to the vendor

---

## Section 4: Structured Logging & Monitoring

### 4.1 JSON Structured Logger

Replace all `console.log/error` with a logger module that outputs:

```json
{
  "timestamp": "2026-04-08T14:30:00-05:00",
  "level": "info",
  "message": "Deposit submitted",
  "context": {
    "invoiceId": 40,
    "vendorSlug": "cesar",
    "platform": "PLAY777",
    "accountUsername": "DSilva777",
    "credits": 500,
    "step": "CORRECTION_DEPOSIT"
  }
}
```

All timestamps in CDT (UTC-5). Logger writes to stdout (captured by systemd) and optionally to per-invoice log files.

### 4.2 Per-Load Log Files

Each invoice processing run creates a log file at:
`/var/log/creditloader/loads/invoice-{id}-{timestamp}.log`

Contains every step, timing, screenshots on failure. Retained for 30 days.

### 4.3 Load Event Timeline

New DB model for the step-by-step event log visible in the admin dashboard:

```prisma
model LoadEvent {
  id             Int      @id @default(autoincrement())
  loadJobId      Int      @map("load_job_id")
  step           String   // BROWSER_LAUNCHED, LOGIN_OK, NAVIGATED_VENDORS, FOUND_ROW, OPENED_MODAL, ENTERED_CREDITS, SUBMITTED, VERIFIED, etc.
  status         String   // SUCCESS, FAILED, INFO
  metadata       Json?    // arbitrary data (balances, URLs, error details)
  screenshotPath String?  @map("screenshot_path")
  createdAt      DateTime @default(now()) @map("created_at")

  loadJob LoadJob @relation(fields: [loadJobId], references: [id])

  @@index([loadJobId])
  @@map("load_events")
}
```

### 4.4 Dashboard Event Timeline View

New page in admin dashboard: click any invoice → see full event timeline.
- Chronological list of LoadEvents for all LoadJobs in that invoice
- Each event shows: timestamp (CDT), step name, status badge, metadata JSON (expandable)
- "Show Only Errors" toggle
- Screenshot thumbnails inline (click to expand)

### 4.5 Daily Health Digest

Scheduled task at 8:00 AM CDT, sends Telegram summary:
- Invoices processed in last 24h (success/fail counts)
- Any invoices stuck in LOADING or REQUESTED
- AdsPower API status
- VPS disk space
- QB token expiry status

---

## Section 5: Webhook & Payment Reliability

### 5.1 Persistent Webhook Queue

New DB model:

```prisma
model WebhookEvent {
  id          Int      @id @default(autoincrement())
  source      String   // "quickbooks"
  eventType   String   // "payment"
  payload     Json
  status      String   @default("RECEIVED") // RECEIVED, PROCESSING, PROCESSED, FAILED
  error       String?
  attempts    Int      @default(0)
  receivedAt  DateTime @default(now()) @map("received_at")
  processedAt DateTime? @map("processed_at")

  @@index([status])
  @@map("webhook_events")
}
```

Flow:
1. Webhook arrives → verify HMAC → save to `WebhookEvent` (status: RECEIVED) → respond 200 immediately
2. Background processor picks up RECEIVED events, processes them, marks PROCESSED
3. On startup, check for any RECEIVED or PROCESSING events and reprocess them
4. Max 3 attempts per event, then mark FAILED and alert admin

### 5.2 Daily QB Reconciliation

Scheduled task (runs with health digest):
- Query QB API for payments received in last 24 hours
- Compare against local processed webhooks
- If any QB payment has no matching local record: Telegram alert with payment details

### 5.3 Webhook Signature Enforcement

- If `QB_WEBHOOK_TOKEN` is not set: log a warning on startup, reject all webhook requests with 500
- No silent fallback to unverified processing

---

## Section 6: AdsPower Reliability

### 6.1 Systemd Service Hardening

Fix the service file:

```ini
[Unit]
Description=AdsPower Browser
After=xvfb.service
Requires=xvfb.service

[Service]
Environment=DISPLAY=:99
ExecStart=/usr/local/bin/adspower --no-sandbox
Restart=always
RestartSec=10
WatchdogSec=120
ExecStartPre=/bin/rm -f /tmp/.X99-lock

[Install]
WantedBy=multi-user.target
```

Symlink `/usr/local/bin/adspower → /opt/AdsPower Global/adspower_global` to handle the space in path.

### 6.2 Profile Health Check

Before each load, verify AdsPower is responsive:
```
GET /api/v1/user/list?page_size=1
```
If unreachable: run recovery sequence (Section 1.6) before attempting the load.

### 6.3 Proxy Persistence

Store proxy config in Settings table:
```
key: adspower_proxy_config
value: {"proxy_type":"http","proxy_host":"gw.dataimpulse.com","proxy_port":"823","proxy_user":"...","proxy_password":"..."}
```

On each profile start, verify the proxy config matches what's in the DB. If not, update it via the AdsPower API before launching.

### 6.4 2FA Code via Dashboard

New admin endpoint:
- `POST /api/admin/2fa-code` — accepts `{code}`, stores in memory (or Settings table with TTL)
- Browser login flow checks for pending 2FA code every 5 seconds
- Code expires after 5 minutes
- Dashboard shows a "2FA Required" banner with code input field when a load is waiting for 2FA

---

## Section 7: Testing

### 7.1 Unit Tests

Test framework: Jest (already in Node ecosystem).

Tests for:
- Credit calculation: `credits = floor(dollarAmount / rate)` for various rates
- Fee calculation: 3% card, 1% ACH, 0% wire
- Server-side validation: amount matching, minimums, account ownership
- Webhook parsing: extract payment ID, find linked invoice IDs, handle edge cases
- Retry logic: correct delays, max attempts, status transitions
- Invoice expiry: marks REQUESTED > 7 days as FAILED
- Logger: correct JSON format, CDT timestamps

### 7.2 Integration Tests

Using DRY_RUN mode and test database:
- Submit invoice → verify Invoice, InvoiceAllocation, LoadJob records created
- Submit correction → verify allocations target correction accounts only
- Webhook idempotency: send same payload twice → only one ProcessedWebhook + one status change
- Trigger load (DRY_RUN) → verify status transitions: PAID → LOADING → LOADED
- Trigger load with failures → verify retry scheduling and FAILED after 3 attempts
- LoadEvent creation → verify events logged for each step

### 7.3 Browser Smoke Test

Script: `scripts/smoke-test.sh`
- Launches AdsPower Play777 profile
- Logs in (handles 2FA if needed via prompt)
- Navigates to Vendors Overview
- Verifies table loads with > 0 rows
- Verifies vendor row can be found by operator ID
- Navigates to Balance History
- Closes browser
- Reports PASS/FAIL

Same for IConnect.

Run on demand or weekly cron. Telegram alert on failure.

---

## Section 8: Operational Improvements

### 8.1 Deploy Script

`./deploy.sh`:
```bash
#!/bin/bash
set -e
ssh root@87.99.135.197 << 'EOF'
  cd /root/WOKE-CreditLoader-Pipeline
  git pull
  cd backend
  npm install --production
  npx prisma generate --schema src/db/prisma/schema.prisma
  npx prisma migrate deploy --schema src/db/prisma/schema.prisma
  cd ../frontend
  npm install
  npm run build
  cp -r dist/* ../backend/public/
  systemctl restart creditloader
  sleep 3
  curl -sf http://localhost:3000/api/vendors/mike > /dev/null && echo "DEPLOY OK" || echo "DEPLOY FAILED"
EOF
```

### 8.2 Vendor Status Notifications

Send Telegram to vendor's chat when invoice status changes:
- PAID: "Your payment of $X has been received. Credits are being loaded."
- LOADED: "Your credits have been loaded successfully." (already exists)
- FAILED: "There was an issue loading your credits. Our team has been notified and will resolve this shortly."

### 8.3 Wire Receipt Backup

On wire receipt upload, copy file to a backup directory `/var/backups/creditloader/receipts/`. Simple rsync cron or inline copy.

### 8.4 Stale Load Detection

Background check every 2 minutes:
- If any invoice has been in LOADING status for > 10 minutes, send Telegram alert
- "Invoice #X for {vendor} has been LOADING for {minutes} minutes. Possible hung process."

---

## New Database Models Summary

```prisma
model LoadStep {
  id             Int      @id @default(autoincrement())
  loadJobId      Int      @map("load_job_id")
  step           String
  accountId      Int      @map("account_id")
  credits        Int
  status         String
  balanceBefore  Int?     @map("balance_before")
  balanceAfter   Int?     @map("balance_after")
  screenshotPath String?  @map("screenshot_path")
  error          String?
  createdAt      DateTime @default(now()) @map("created_at")

  loadJob       LoadJob       @relation(fields: [loadJobId], references: [id])
  vendorAccount VendorAccount @relation(fields: [accountId], references: [id])
  @@index([loadJobId])
  @@map("load_steps")
}

model LoadEvent {
  id             Int      @id @default(autoincrement())
  loadJobId      Int      @map("load_job_id")
  step           String
  status         String
  metadata       Json?
  screenshotPath String?  @map("screenshot_path")
  createdAt      DateTime @default(now()) @map("created_at")

  loadJob LoadJob @relation(fields: [loadJobId], references: [id])
  @@index([loadJobId])
  @@map("load_events")
}

model WebhookEvent {
  id          Int       @id @default(autoincrement())
  source      String
  eventType   String    @map("event_type")
  payload     Json
  status      String    @default("RECEIVED")
  error       String?
  attempts    Int       @default(0)
  receivedAt  DateTime  @default(now()) @map("received_at")
  processedAt DateTime? @map("processed_at")

  @@index([status])
  @@map("webhook_events")
}
```

---

## Implementation Order

1. **Logging & Events** (Section 4) — foundation for everything else
2. **Database models** — LoadStep, LoadEvent, WebhookEvent migrations
3. **Browser Resilience** (Section 1) — screenshots, adaptive waits, session reuse
4. **Server-Side Validation** (Section 3) — quick win
5. **Correction & Chain Safety** (Section 2) — balance verification, audit trail
6. **Webhook Reliability** (Section 5) — persistent queue, reconciliation
7. **AdsPower Reliability** (Section 6) — auto-recovery, 2FA via dashboard
8. **Testing** (Section 7) — unit + integration + smoke
9. **Operations** (Section 8) — deploy script, notifications, stale detection
10. **Dashboard Event Timeline** (Section 4.4) — frontend for event viewing

---

## What's NOT Changing

- Overall architecture (Express + Prisma + Playwright + AdsPower)
- Database (Railway PostgreSQL)
- Hosting (Hetzner VPS)
- Browser automation approach (required — no APIs available)
- Frontend framework (React + Vite)
- Sequential load processing (appropriate for 5-20/day volume)
