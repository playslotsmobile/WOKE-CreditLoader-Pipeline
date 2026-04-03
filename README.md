# WokeAVR Credit Loader Pipeline

Fully automated invoice-to-credits pipeline for WokeAVR. When a vendor invoice is paid, the system automatically logs into Play777 and IConnect, finds the vendor, loads their credits, updates the database, and sends a Telegram confirmation.

**Zero manual intervention once live.**

---

## What This Replaces

| Old | New |
|---|---|
| Cognito Forms | Custom React forms (Railway) |
| Zapier automations | Node.js + Express backend (Railway) |
| Google Sheets tracking | PostgreSQL (Railway) |
| Manual credit loading | Playwright browser automation |

**Kept:** QuickBooks (via API), Telegram (via Bot API)

---

## Automated Flow

```
1. Vendor opens /form/:vendorSlug
   → Prefilled & locked fields (from QB customer data)
   → Selects payment method, enters dollar amounts per platform
   → Live credit preview as they type
   → Submits

2. Backend receives submission
   → Saves to DB (status: REQUESTED)
   → Creates QB invoice → emails vendor
   → Telegram: "DO NOT LOAD" message to vendor group

3. QuickBooks webhook fires on payment
   → Verifies payment → status: PAID
   → Triggers auto-loader jobs (Play777 + IConnect in parallel)

4. Playwright auto-loaders
   → Login → find vendor → load credits → confirm
   → Per-platform: Play777 and/or IConnect

5. Both jobs complete
   → Status: LOADED
   → Telegram: "LOADED" confirmation

6. On failure
   → Status: FAILED → Telegram alert to admin
   → Admin dashboard shows retry/override buttons
```

---

## Credit Formulas

Rates are **per-vendor** (stored in the `vendors` table):

| Platform | Formula |
|---|---|
| Play777 | `credits = dollar_amount / vendor.play777_rate` |
| IConnect | `credits = dollar_amount / vendor.iconnect_rate` |

Example: If a vendor has a Play777 rate of 0.35 (35%), then $1,000 → 2,857.14 credits.

## Fee Schedule

| Payment Method | Fee |
|---|---|
| Credit/Debit | 3% |
| ACH | 1% |
| Wire | 0% |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + Tailwind CSS |
| Backend | Node.js + Express |
| Database | PostgreSQL + Prisma ORM |
| Browser Automation | Playwright |
| Invoicing | QuickBooks API (OAuth 2.0) |
| Notifications | Telegram Bot API |
| Hosting | Railway |
| Auth (admin) | JWT |

---

## Project Structure

```
WokeAVR-CreditLoader-Pipeline/
├── backend/
│   └── src/
│       ├── index.js              ← Express entry point
│       ├── routes/
│       │   ├── forms.js          ← POST /api/submit-invoice
│       │   ├── webhooks.js       ← POST /api/qb-webhook
│       │   └── admin.js          ← Admin API routes
│       ├── services/
│       │   ├── quickbooks.js     ← QB API integration
│       │   ├── telegram.js       ← Telegram notifications
│       │   ├── autoloader.js     ← Load job orchestrator
│       │   ├── play777.js        ← Playwright: Play777
│       │   └── iconnect.js       ← Playwright: IConnect
│       ├── db/prisma/
│       │   └── schema.prisma     ← Full DB schema
│       └── middleware/
│           └── auth.js           ← JWT auth
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── VendorForm.jsx    ← /form/:vendorSlug
│       │   ├── AdminLogin.jsx    ← /admin/login
│       │   └── AdminDashboard.jsx← /admin
│       └── components/
│           ├── InvoicePipeline.jsx
│           ├── InvoiceCard.jsx
│           └── ManualOverride.jsx
└── docs/
    ├── flow-diagram.md
    ├── qb-api-setup.md
    └── vendor-list.md
```

---

## Database Schema

### vendors
| Column | Type |
|---|---|
| id | serial PK |
| slug | unique string |
| name, business_name, email | string |
| qb_customer_id | string |
| telegram_chat_id | string |
| play777_username, play777_rate | string, decimal |
| iconnect_username, iconnect_rate | string, decimal |

### invoices
| Column | Type |
|---|---|
| id | serial PK |
| vendor_id | FK → vendors |
| qb_invoice_id | string |
| method | string |
| base_amount, fee_amount, total_amount | decimal |
| play777_amount, play777_credits | decimal |
| iconnect_amount, iconnect_credits | decimal |
| status | REQUESTED / PENDING / PAID / LOADING / LOADED / FAILED |

### load_jobs
| Column | Type |
|---|---|
| id | serial PK |
| invoice_id | FK → invoices |
| platform | PLAY777 / ICONNECT |
| credits_amount | decimal |
| status | PENDING / SUCCESS / FAILED |
| attempts | int |
| error_message | string |

### admin_users
| Column | Type |
|---|---|
| id | serial PK |
| username | unique string |
| password_hash | string |

---

## Telegram Message Formats

**On submission:**
```
❌ DO NOT LOAD ❌
Invoice ID: {qb_invoice_id}
Method: {method}
Total Payment w/ Fee: ${total_amount}
Total Payment: ${base_amount}
777 Vendor {play777_username}
Amount: ${play777_amount}  Credits: {play777_credits}
```

**On loaded:**
```
✅ LOADED ✅
Invoice ID: {qb_invoice_id}
Method: {method}
Total Payment w/ Fee: ${total_amount}
Total Payment: ${base_amount}
777 Vendor {play777_username}
Amount: ${play777_amount}  Credits: {play777_credits}
```

**On failure (admin alert):**
```
🚨 LOAD FAILED 🚨
Invoice ID: {qb_invoice_id}
Platform: {PLAY777 or ICONNECT}
Vendor: {vendor_name}
Credits: {credits}
Error: {error_message}
```

---

## Admin Dashboard

Pipeline kanban with 5 columns: **REQUESTED → PENDING → PAID → LOADING → LOADED**

Each card shows vendor name, invoice ID, method, amounts, credits, timestamp, and status badge. Failed jobs get red Retry + Manual Override buttons.

---

## Environment Variables

See `.env.example` for the full list with descriptions.

---

## Pending from Anthony

1. QuickBooks API credentials (Client ID, Secret, Realm ID)
2. 16 vendor list (slugs, names, emails, QB IDs, platform usernames, Telegram chat IDs)
3. Play777 portal credentials (URL, username, password)
4. IConnect portal credentials (URL, username, password)

---

## Build Phases

| Phase | Description | Status |
|---|---|---|
| 1 | Project scaffold + DB schema + Prisma + .env | ✅ Complete |
| 2 | Vendor form UI with formulas and validation | ✅ Complete |
| 3 | Backend API: submission → DB → QB → Telegram | Pending |
| 4 | QB webhook: payment → status update → trigger loader | Pending |
| 5 | Playwright auto-loaders (Play777 + IConnect) | Blocked |
| 6 | Admin dashboard: kanban + override | Pending |
| 7 | End-to-end test with sandbox QB | Pending |
| 8 | Railway deployment + production switch | Pending |
