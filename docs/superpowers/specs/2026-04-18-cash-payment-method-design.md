# Cash Payment Method — Design

**Date:** 2026-04-18
**Status:** Draft

## Problem

Alex Noz and Claudia Cardenas occasionally pay in cash — typically toward credit-line repayment, sometimes combined with a fresh load. Today there's no "Cash" method on their vendor forms, so these payments get captured as wrong-method invoices (e.g. Credit/Debit), which then need manual QB voiding and DB surgery (see Alex 2026-04-18 incident: invoices 5964/5965 voided + manual $8k repayment txn).

## Goal

A first-class `Cash` payment method that:
- Creates no QB invoice (cash is off-book there)
- Charges no fee
- Defaults to `PENDING` status until admin confirms cash received
- On admin confirmation, moves to `PAID` and triggers autoload (same shape as Wire)
- Only available on Alex and Claudia's forms

## Non-goals

- Cash support for other vendors (YAGNI — 2 vendors today)
- Admin UI to toggle which vendors allow cash (YAGNI — allowlist in code)
- Fixing the unrelated delete-route drift bug (tracked separately)

## Design

### Frontend: `frontend/src/pages/VendorForm.jsx`

**Method config additions:**

```js
const FEE_RATES = {
  'Credit/Debit': 0.03,
  ACH: 0.01,
  Wire: 0,
  Cash: 0,
};

const METHOD_CONFIG = {
  'Credit/Debit': { min: 1000, max: 4500, step: 250 },
  ACH: { min: 1000, max: 9000, step: 250 },
  Wire: { min: 1000, max: 20000 },
  Cash: { min: 1000, max: 20000, step: 250 },
};

const CASH_ALLOWED_SLUGS = ['alex', 'claudia'];
```

**Dropdown gating:** the method `<select>` filters options based on `vendorSlug`. If slug is not in `CASH_ALLOWED_SLUGS`, the Cash option is omitted entirely.

**Cash UI behavior:**
- Same allocation rows as other methods (supports load + credit-line repayment combo)
- No "Total w/ Fee" line (total = base)
- No wire-receipt upload
- Small helper text under dropdown: *"No QB invoice. Pay cash in person, then admin will mark paid to trigger the load."*
- Submit button label: `Submit Cash Request` (mirrors `Submit Wire Request`)

### Backend: `backend/src/routes/forms.js`

**Accept Cash in POST /submit:**
- Add `method === 'Cash'` branch. `methodLabel = 'Cash'`. Fee forced to `0`.
- `isOffline = method === 'Wire' || method === 'Cash'`. Use this for: status = `PENDING`, skip QB invoice creation.
- Server-side allowlist: if `method === 'Cash'` and `vendor.slug ∉ CASH_ALLOWED_SLUGS`, return 403. Defense-in-depth (frontend dropdown is an editable client).
- Telegram: at submit, fire the same admin-only message path that Wire uses today (reuse `sendWireSubmitted` or factor into a shared `sendOfflineSubmitted`). No vendor notify at submit. Vendor notify fires on admin confirm (see below).

### Backend: `backend/src/routes/admin.js`

**New endpoint:** `POST /invoices/:id/confirm-cash`
- Mirror of `/confirm-wire` (admin.js ~line 95).
- Guards: invoice must exist, `method === 'Cash'`, `status === 'PENDING'`.
- Action: set `status = 'PAID'`, `paidAt = now()`. Respond 200 immediately.
- Background: `autoloader.processInvoice(id)` — same as Wire.
- On processInvoice success the existing Telegram "Payment Received" vendor notification fires (already branches on `allocations.length` for repayment vs load wording — still correct for Cash).

### Frontend: Admin Pipeline column `PENDING`

- Add `Mark Cash Received` button on Cash PENDING invoice cards. Wire invoice cards already have a `Confirm Wire` button — parallel UX.
- Visual badge on Cash cards: `CASH` chip (similar pattern to `WIRE` chip if one exists).

## Data model

No migration. `Invoice.method` is already a free-form string. New literal value `'Cash'` joins `'Credit/Debit (3%)'`, `'ACH (1%)'`, `'Wire'`, `'Credit Line'`, `'Correction'`.

## Flow diagram

```
vendor form submit (Alex/Claudia, method=Cash)
    → POST /forms/submit
    → validateInvoice (fee=0 enforced)
    → vendor.slug ∈ allowlist? else 403
    → create Invoice (status=PENDING, qbInvoiceId=null)
    → create allocations
    → store credit_line_repayment setting if any
    → Telegram admin: "Cash request: <vendor> $<base>"
    → respond 200 to form

[vendor pays cash in person]

admin clicks "Mark Cash Received" in pipeline
    → POST /admin/invoices/:id/confirm-cash
    → status PENDING → PAID, paidAt = now
    → respond 200
    → background: autoloader.processInvoice(id)
        → performs loads for each allocation
        → applies credit_line_repayment if setting exists
        → on success: Telegram vendor "Payment Received..."
        → Invoice.status → LOADED
```

## Error handling

- Cash submit by non-allowlisted vendor → 403 with message `Cash not enabled for this vendor`
- Admin confirms Cash but status ≠ PENDING → 400 with message `Invoice not in PENDING status`
- Admin confirms non-Cash invoice via `/confirm-cash` → 400 `Not a cash invoice`
- Autoload failure after Cash confirm → same retry/FAILED path as any other invoice. Admin can `Mark Loaded Manually`.

## Testing

- **Unit:** `validateInvoice` accepts `method='Cash'` with `fee=0`, rejects with `fee>0`.
- **Integration (vendor submit):** POSTing a Cash invoice as a non-allowlisted vendor returns 403; as Alex returns 200 and persists invoice with status=PENDING, qbInvoiceId=null.
- **Integration (confirm-cash):** PENDING Cash invoice → 200, status flips to PAID, paidAt set. Non-Cash invoice returns 400.
- **Smoke (dev):** create Cash invoice for Alex with $100 allocation, confirm-cash, verify autoload kicks (will fail in dev without a live Play777 account — check status flow only).
- **Manual prod:** once deployed, run a $1 Cash test on Claudia to verify end-to-end.

## Out of scope / follow-ups

- **Delete-route drift fix:** `admin.js:239` cascade-deletes `creditLineTransaction` rows without reversing `usedAmount`. Needs a reverse-then-delete flow. Applies to any deleted Credit Line or repayment invoice — tracked separately.
- Admin UI for toggling `allowsCash` per vendor. Add when 3rd vendor requests.
