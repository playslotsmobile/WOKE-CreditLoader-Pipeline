# WokeAVR Credit Loader — Automated Flow

## End-to-End Pipeline

```
Vendor Form (/form/:vendorSlug)
        │
        ▼
  Submit Invoice
        │
        ├── Save to DB (status: REQUESTED)
        ├── Create QB Invoice → Email vendor
        └── Telegram: "DO NOT LOAD"
        │
        ▼
  QuickBooks Webhook (invoice paid)
        │
        ├── Update status → PAID
        └── Trigger auto-loader jobs
        │
        ▼
  Playwright Auto-Loader (parallel)
        │
        ├── Play777: login → find vendor → load credits → confirm
        └── IConnect: login → find vendor → load credits → confirm
        │
        ▼
  Both jobs complete
        │
        ├── Update status → LOADED
        └── Telegram: "LOADED"

  On failure:
        ├── Status → FAILED
        ├── Telegram alert to admin
        └── Admin dashboard: manual retry/override
```

## Credit Formulas

- **Play777**: `credits = dollar_amount / 0.35` (35% rate)
- **IConnect**: `credits = dollar_amount / 0.25` (25% rate)

## Fee Schedule

| Payment Method | Fee |
|---|---|
| Credit/Debit | 3% |
| ACH | 1% |
| Wire | 0% |

## Invoice Status Flow

```
REQUESTED → PENDING → PAID → LOADING → LOADED
                                  └──→ FAILED
```
