# Credit Line Feature — Design Spec

## Overview

Vendors (Claudia, Alex, Jose) can request credit loads without paying upfront, drawing from a per-vendor credit line with a USD cap. They replenish their credit line by allocating toward it when submitting paid invoices. No QuickBooks involvement for credit line draws.

## Vendors & Caps

| Vendor | Cap | Currently Used | Available |
|--------|-----|----------------|-----------|
| Claudia Cardenas | $10,000 | $6,000 | $4,000 |
| Alex Noz | $10,000 | $0 | $10,000 |
| Jose Gracia | $5,000 | $5,000 | $0 |

## Database Schema

### CreditLine Model

```
CreditLine
  id          Int       @id @default(autoincrement())
  vendorId    Int       @unique
  vendor      Vendor    @relation
  capAmount   Decimal   // Max credit line in USD
  usedAmount  Decimal   // Running total of outstanding balance
  createdAt   DateTime
  updatedAt   DateTime
```

### CreditLineTransaction Model

```
CreditLineTransaction
  id              Int       @id @default(autoincrement())
  creditLineId    Int
  creditLine      CreditLine @relation
  invoiceId       Int
  invoice         Invoice   @relation
  type            String    // "DRAW" or "REPAYMENT"
  amount          Decimal   // USD amount
  balanceBefore   Decimal   // Snapshot before transaction
  balanceAfter    Decimal   // Snapshot after transaction
  createdAt       DateTime
```

### Invoice Changes

- New method value: `"Credit Line"` for draw requests
- Credit line draw invoices skip PENDING/payment states — go straight to loading

### Seed Data

- Claudia: cap $10,000, used $6,000
- Alex: cap $10,000, used $0
- Jose: cap $5,000, used $5,000

## Vendor Form — Request Credit Line Tab

### Header

- Displays credit line status: "Credit Line: $4,000 of $10,000 available"
- Visual progress bar showing utilization
- If maxed out: form disabled, message "Credit line fully used — $0 of $5,000 available"

### Form Fields

- **Dollar amount input** — free-form, capped at remaining balance
- **Account allocation grid** — same as Invoice tab, vendor spreads dollars across their accounts (777, IC, etc.)
- **Credits auto-calculated** per account at their rate
- **No payment method selector** — no fees, no wire receipts

### Submit Flow

1. Vendor fills amount + allocations
2. Clicks "Request Credit Line"
3. **Confirmation screen** — shows breakdown: amount per account, credits per account, remaining balance after request
4. Vendor confirms
5. Invoice created (method: "Credit Line", no QB)
6. Auto-loads immediately
7. Telegram notification sent to admin
8. Success message shown

## Vendor Form — Invoice Tab Credit Line Allocation

### What Changes

- New row in the allocation grid labeled **"Credit Line Repayment"**
- Appears alongside 777/IC accounts
- Vendor enters a dollar amount to repay toward their credit line
- Shows current balance inline (e.g., "$6,000 / $10,000 used")
- No credits calculation for this row (it's a payment, not a load)

### Backend Behavior

- When invoice is paid (QB webhook fires), allocations to "Credit Line" create a `REPAYMENT` transaction
- `usedAmount` is reduced by the repayment amount
- Other allocations in the same invoice load to accounts normally

### Example

Claudia submits $5K ACH invoice:
- $1,500 to MM123456 (777) — loads credits
- $1,500 to Andrea1979 (IC) — loads credits
- $2,000 to Credit Line Repayment — reduces used from $6K to $4K

## Validation — Three Layers

### 1. Frontend

- Amount input capped at remaining balance
- Submit button disabled if allocations exceed remaining balance
- Allocation grid totals validated

### 2. Backend API

- Before creating invoice: verifies `capAmount - usedAmount >= requestedAmount`
- Rejects with clear error if insufficient balance

### 3. Before Loading

- Loader re-checks credit line balance before executing
- Prevents race condition if two requests come in simultaneously

## Admin Dashboard — Credit Lines Panel

### Overview Table

- All vendors at a glance: name, cap, used, available, utilization % bar
- Color coding: green = plenty available, yellow = >50% used, red = >80% used or maxed

### Transaction History

- Filterable table of all credit line activity (draws + repayments)
- Columns: date, vendor, type (DRAW/REPAYMENT), amount, balance after, linked invoice ID
- Filter by vendor, type, date range

### Per-Vendor Drill-Down

- Click vendor to see full credit line history
- Current balance, all transactions, linked invoices

## Telegram Notifications

### Credit Line Draw (auto-load triggered)

```
Credit Line Request
Vendor: Alex Noz
Amount: $3,000
Accounts: TEAM1115 (777) — 8,571 credits
Balance: $3,000 / $10,000 used
```

### Combined Invoice with Credit Line Repayment

```
Invoice #45 Loaded
Vendor: Claudia Cardenas
Method: ACH (1%) — $5,000
- MM123456 (777) — 4,286 credits ($1,500)
- Andrea1979 (IC) — 10,000 credits ($1,500)
- Credit Line Repayment — $2,000
  Balance: $4,000 / $10,000 used
```

## What This Feature Does NOT Include

- No interest or fees on credit line draws
- No automatic credit line cap changes
- No vendor self-service cap adjustments
- No QB integration for credit line draws
