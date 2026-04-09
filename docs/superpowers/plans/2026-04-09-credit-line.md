# Credit Line Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow vendors (Claudia, Alex, Jose) to request credit loads from a pre-approved credit line without payment, and replenish the credit line by allocating toward it in paid invoices.

**Architecture:** New `CreditLine` and `CreditLineTransaction` Prisma models. Credit line draws create invoices with method `"Credit Line"` that skip QB and auto-load immediately. Repayments happen when vendors allocate to a virtual "Credit Line" row in the invoice form. Three-layer validation (frontend, API, pre-load) prevents over-draws.

**Tech Stack:** Prisma (PostgreSQL), Express, React, node-telegram-bot-api

---

## File Structure

### New Files
- `backend/src/routes/creditLine.js` — Credit line API routes (draw, balance, transactions, admin endpoints)
- `backend/src/services/creditLineService.js` — Credit line business logic (draw, repay, balance check)

### Modified Files
- `backend/src/db/prisma/schema.prisma` — Add CreditLine + CreditLineTransaction models
- `backend/src/db/seed.js` — Seed credit line data for Claudia, Alex, Jose
- `backend/src/index.js` — Register credit line routes, include creditLine in vendor endpoint
- `backend/src/routes/forms.js` — Handle credit line repayment allocations in submit-invoice
- `backend/src/services/telegram.js` — Add credit line draw + combined repayment notifications
- `backend/src/services/validator.js` — Allow "credit_line" pseudo-allocation in invoice validation
- `backend/src/services/autoloader.js` — Check credit line balance before loading credit line invoices
- `frontend/src/pages/VendorForm.jsx` — Add "Request Credit Line" tab + "Credit Line Repayment" allocation row
- `frontend/src/pages/AdminDashboard.jsx` — Add "Credit Lines" view with overview + transaction history
- `backend/src/routes/admin.js` — Add admin credit line endpoints (overview, transactions, drill-down)

---

### Task 1: Database Schema — CreditLine + CreditLineTransaction Models

**Files:**
- Modify: `backend/src/db/prisma/schema.prisma`

- [ ] **Step 1: Add CreditLine model to schema.prisma**

Add after the `Vendor` model (after line 24):

```prisma
model CreditLine {
  id         Int      @id @default(autoincrement())
  vendorId   Int      @unique @map("vendor_id")
  capAmount  Decimal  @map("cap_amount") @db.Decimal(10, 2)
  usedAmount Decimal  @default(0) @map("used_amount") @db.Decimal(10, 2)
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  vendor       Vendor                  @relation(fields: [vendorId], references: [id])
  transactions CreditLineTransaction[]

  @@map("credit_lines")
}

model CreditLineTransaction {
  id            Int      @id @default(autoincrement())
  creditLineId  Int      @map("credit_line_id")
  invoiceId     Int      @map("invoice_id")
  type          String   // "DRAW" or "REPAYMENT"
  amount        Decimal  @db.Decimal(10, 2)
  balanceBefore Decimal  @map("balance_before") @db.Decimal(10, 2)
  balanceAfter  Decimal  @map("balance_after") @db.Decimal(10, 2)
  createdAt     DateTime @default(now()) @map("created_at")

  creditLine CreditLine @relation(fields: [creditLineId], references: [id])
  invoice    Invoice    @relation(fields: [invoiceId], references: [id])

  @@index([creditLineId])
  @@index([invoiceId])
  @@map("credit_line_transactions")
}
```

- [ ] **Step 2: Add relation fields to Vendor and Invoice models**

In the `Vendor` model, add after the `invoices` relation (after line 21):

```prisma
  creditLine CreditLine?
```

In the `Invoice` model, add after the `loadJobs` relation (after line 76):

```prisma
  creditLineTransactions CreditLineTransaction[]
```

- [ ] **Step 3: Run Prisma migration**

Run:
```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend
npx prisma migrate dev --name add-credit-line
```

Expected: Migration created successfully, tables `credit_lines` and `credit_line_transactions` created.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/prisma/schema.prisma backend/src/db/prisma/migrations/
git commit -m "feat: add CreditLine and CreditLineTransaction schema"
```

---

### Task 2: Seed Credit Line Data

**Files:**
- Modify: `backend/src/db/seed.js`

- [ ] **Step 1: Add credit line config to vendor definitions**

In `seed.js`, add a `creditLine` property to the three vendor objects:

For `claudia` (line 14, inside the claudia object):
```javascript
    creditLine: { cap: 10000, used: 6000 },
```

For `jose` (line 33, inside the jose object):
```javascript
    creditLine: { cap: 5000, used: 5000 },
```

For `alex` (line 46, inside the alex object):
```javascript
    creditLine: { cap: 10000, used: 0 },
```

- [ ] **Step 2: Add credit line upsert to seed function**

In the `seed()` function, after the chain account linking second pass (after line 184, before `console.log`), add:

```javascript
    // Create/update credit line if vendor has one
    if (v.creditLine) {
      await prisma.creditLine.upsert({
        where: { vendorId: vendor.id },
        update: {
          capAmount: v.creditLine.cap,
          usedAmount: v.creditLine.used,
        },
        create: {
          vendorId: vendor.id,
          capAmount: v.creditLine.cap,
          usedAmount: v.creditLine.used,
        },
      });
    }
```

- [ ] **Step 3: Run seed to verify**

Run:
```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend
npx prisma db seed
```

Expected: Seed completes without errors. Claudia, Alex, Jose have credit line records.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/seed.js
git commit -m "feat: seed credit line data for Claudia, Alex, Jose"
```

---

### Task 3: Credit Line Service — Business Logic

**Files:**
- Create: `backend/src/services/creditLineService.js`

- [ ] **Step 1: Create the credit line service**

```javascript
const prisma = require('../db/client');
const { logger } = require('./logger');

/**
 * Get credit line for a vendor. Returns null if vendor has no credit line.
 */
async function getCreditLine(vendorId) {
  return prisma.creditLine.findUnique({
    where: { vendorId },
  });
}

/**
 * Check if a draw amount is available.
 * Returns { available: true, remaining } or { available: false, remaining, error }.
 */
async function checkDrawAvailable(vendorId, amount) {
  const cl = await getCreditLine(vendorId);
  if (!cl) {
    return { available: false, remaining: 0, error: 'No credit line for this vendor' };
  }

  const remaining = Number(cl.capAmount) - Number(cl.usedAmount);
  if (amount > remaining) {
    return {
      available: false,
      remaining,
      error: `Requested $${amount.toLocaleString()} exceeds available credit line of $${remaining.toLocaleString()}`,
    };
  }

  return { available: true, remaining };
}

/**
 * Record a draw (credit line request). Increases usedAmount.
 * Returns the created transaction.
 */
async function recordDraw(vendorId, invoiceId, amount) {
  const cl = await getCreditLine(vendorId);
  if (!cl) throw new Error('No credit line for this vendor');

  const balanceBefore = Number(cl.usedAmount);
  const balanceAfter = balanceBefore + amount;

  if (balanceAfter > Number(cl.capAmount)) {
    throw new Error(`Draw of $${amount} would exceed cap of $${cl.capAmount}`);
  }

  const [transaction] = await prisma.$transaction([
    prisma.creditLineTransaction.create({
      data: {
        creditLineId: cl.id,
        invoiceId,
        type: 'DRAW',
        amount,
        balanceBefore,
        balanceAfter,
      },
    }),
    prisma.creditLine.update({
      where: { id: cl.id },
      data: { usedAmount: balanceAfter },
    }),
  ]);

  logger.info('Credit line draw recorded', {
    vendorId, invoiceId, amount, balanceBefore, balanceAfter,
  });

  return transaction;
}

/**
 * Record a repayment. Decreases usedAmount.
 * Returns the created transaction.
 */
async function recordRepayment(vendorId, invoiceId, amount) {
  const cl = await getCreditLine(vendorId);
  if (!cl) throw new Error('No credit line for this vendor');

  const balanceBefore = Number(cl.usedAmount);
  const balanceAfter = Math.max(0, balanceBefore - amount);

  const [transaction] = await prisma.$transaction([
    prisma.creditLineTransaction.create({
      data: {
        creditLineId: cl.id,
        invoiceId,
        type: 'REPAYMENT',
        amount,
        balanceBefore,
        balanceAfter,
      },
    }),
    prisma.creditLine.update({
      where: { id: cl.id },
      data: { usedAmount: balanceAfter },
    }),
  ]);

  logger.info('Credit line repayment recorded', {
    vendorId, invoiceId, amount, balanceBefore, balanceAfter,
  });

  return transaction;
}

module.exports = {
  getCreditLine,
  checkDrawAvailable,
  recordDraw,
  recordRepayment,
};
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/creditLineService.js
git commit -m "feat: add credit line service (draw, repay, balance check)"
```

---

### Task 4: Credit Line API Routes — Draw + Balance

**Files:**
- Create: `backend/src/routes/creditLine.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Create credit line routes**

```javascript
const express = require('express');
const router = express.Router();
const prisma = require('../db/client');
const creditLineService = require('../services/creditLineService');
const telegram = require('../services/telegram');
const autoloader = require('../services/autoloader');
const { validateInvoice } = require('../services/validator');
const { logger } = require('../services/logger');

// Get credit line balance for a vendor (public — used by vendor form)
router.get('/vendors/:slug/credit-line', async (req, res) => {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { slug: req.params.slug },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const cl = await creditLineService.getCreditLine(vendor.id);
    if (!cl) return res.json({ hasCreditLine: false });

    res.json({
      hasCreditLine: true,
      capAmount: Number(cl.capAmount),
      usedAmount: Number(cl.usedAmount),
      availableAmount: Number(cl.capAmount) - Number(cl.usedAmount),
    });
  } catch (err) {
    logger.error('Credit line balance error', { error: err });
    res.status(500).json({ error: 'Failed to fetch credit line balance' });
  }
});

// Submit credit line draw request
router.post('/submit-credit-line', async (req, res) => {
  try {
    const { vendorSlug, baseAmount, allocations } = req.body;

    const vendor = await prisma.vendor.findUnique({
      where: { slug: vendorSlug },
      include: { accounts: true },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const amount = Number(baseAmount);

    // Check credit line availability
    const check = await creditLineService.checkDrawAvailable(vendor.id, amount);
    if (!check.available) {
      return res.status(400).json({ error: check.error });
    }

    // Validate allocations (reuse invoice validator with no fees)
    const validation = validateInvoice({
      vendor,
      method: 'Credit Line',
      baseAmount: amount,
      feeAmount: 0,
      totalAmount: amount,
      allocations: allocations.map((a) => ({
        accountId: a.accountId,
        dollarAmount: Number(a.dollarAmount),
        credits: a.credits,
      })),
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Create invoice (no QB, no fee)
    const invoice = await prisma.invoice.create({
      data: {
        vendorId: vendor.id,
        method: 'Credit Line',
        baseAmount: amount,
        feeAmount: 0,
        totalAmount: amount,
        status: 'PAID', // Skip REQUESTED/PENDING — goes straight to loading
        paidAt: new Date(),
      },
    });

    // Create allocations
    const enrichedAllocations = [];
    for (const a of allocations) {
      if (a.dollarAmount <= 0) continue;

      let targetAccountId = a.accountId;
      const targetAccount = await prisma.vendorAccount.findUnique({ where: { id: a.accountId } });
      if (targetAccount && targetAccount.parentVendorAccId) {
        targetAccountId = targetAccount.parentVendorAccId;
      }

      const alloc = await prisma.invoiceAllocation.create({
        data: {
          invoiceId: invoice.id,
          vendorAccountId: targetAccountId,
          dollarAmount: a.dollarAmount,
          credits: a.credits,
        },
        include: { vendorAccount: true },
      });
      enrichedAllocations.push({
        ...a,
        platform: alloc.vendorAccount.platform,
        username: alloc.vendorAccount.username,
        operatorId: alloc.vendorAccount.operatorId,
      });
    }

    // Record the draw
    await creditLineService.recordDraw(vendor.id, invoice.id, amount);

    // Get updated balance for notifications
    const cl = await creditLineService.getCreditLine(vendor.id);
    const usedAmount = Number(cl.usedAmount);
    const capAmount = Number(cl.capAmount);

    // Send Telegram notification
    try {
      await telegram.sendCreditLineDraw(
        { name: vendor.name, telegramChatId: vendor.telegramChatId },
        { id: invoice.id, baseAmount: amount },
        enrichedAllocations,
        { usedAmount, capAmount }
      );
    } catch (err) {
      logger.error('Telegram credit line notification failed', { error: err });
    }

    logger.info('Credit line draw submitted', { invoiceId: invoice.id, amount });
    res.json({ success: true, invoiceId: invoice.id });

    // Auto-load in background
    autoloader.processInvoice(invoice.id).catch((err) => {
      logger.error('Credit line auto-load failed', { error: err });
    });
  } catch (err) {
    logger.error('Submit credit line error', { error: err });
    res.status(500).json({ error: 'Failed to submit credit line request' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Register credit line routes in index.js**

In `backend/src/index.js`, add the import after the existing route imports (after line 9):

```javascript
const creditLineRoutes = require('./routes/creditLine');
```

Add the route registration after `app.use('/api', formRoutes);` (after line 121):

```javascript
app.use('/api', creditLineRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/creditLine.js backend/src/index.js
git commit -m "feat: add credit line draw API route and balance endpoint"
```

---

### Task 5: Update Validator — Allow Credit Line Method

**Files:**
- Modify: `backend/src/services/validator.js`

- [ ] **Step 1: Update validateInvoice to handle Credit Line method**

The existing validator checks `if (method !== 'Wire' && baseAmount < 1000)`. Credit Line draws should not have a $1,000 minimum — they should allow any positive amount up to the remaining balance.

Replace the method minimum check (lines 4-6):

```javascript
  if (method !== 'Wire' && method !== 'Credit Line' && baseAmount < 1000) {
    return { valid: false, error: `$1,000 minimum required for ${method}` };
  }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/validator.js
git commit -m "feat: allow Credit Line method in invoice validator"
```

---

### Task 6: Update Autoloader — Pre-Load Credit Line Balance Check

**Files:**
- Modify: `backend/src/services/autoloader.js`

- [ ] **Step 1: Add credit line balance check before loading**

At the top of `autoloader.js`, add the import (after line 4):

```javascript
const creditLineService = require('./creditLineService');
```

In `processInvoiceInternal`, after the invoice is fetched and before loading begins, add a credit line balance re-check. Find the section where the invoice is fetched (around line 58) and after the invoice null check, add:

```javascript
  // Re-check credit line balance before loading (race condition guard)
  if (invoice.method === 'Credit Line') {
    const cl = await creditLineService.getCreditLine(invoice.vendorId);
    if (!cl) {
      logger.error('Credit line not found for credit line invoice', { invoiceId });
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'FAILED' } });
      return;
    }
    // The draw was already recorded, so we just verify usedAmount hasn't exceeded cap
    if (Number(cl.usedAmount) > Number(cl.capAmount)) {
      logger.error('Credit line over-drawn, blocking load', {
        invoiceId,
        usedAmount: Number(cl.usedAmount),
        capAmount: Number(cl.capAmount),
      });
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'FAILED' } });
      return;
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/services/autoloader.js
git commit -m "feat: add credit line balance guard in autoloader"
```

---

### Task 7: Telegram Notifications — Credit Line Draw + Combined Repayment

**Files:**
- Modify: `backend/src/services/telegram.js`

- [ ] **Step 1: Add sendCreditLineDraw function**

Add before `module.exports` (before line 164):

```javascript
// ── Credit Line Draw ──

async function sendCreditLineDraw(vendor, invoice, allocations, creditLineBalance) {
  const allocLines = allocations
    .filter((a) => a.dollarAmount > 0)
    .map((a) => {
      const p = a.platform === 'PLAY777' ? '777' : 'IConnect';
      return `${a.username} (${p}) — ${a.credits.toLocaleString()} credits (${fmt(a.dollarAmount)})`;
    })
    .join('\n');

  const mainMsg = `💳 Credit Line Request

${vendor.name}

Amount: ${fmt(invoice.baseAmount)}

${allocLines}

Balance: ${fmt(creditLineBalance.usedAmount)} / ${fmt(creditLineBalance.capAmount)} used`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    const vendorMsg = `💳 Credit Line Request Received

Your credit line request for ${fmt(invoice.baseAmount)} has been submitted. Credits will be loaded shortly.

${allocLines}`;

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
}

// ── Credit Line Repayment (included in loaded notification) ──

async function sendCreditLineRepayment(vendor, repaymentAmount, creditLineBalance) {
  const mainMsg = `💳 Credit Line Repayment

${vendor.name}

Repaid: ${fmt(repaymentAmount)}
Balance: ${fmt(creditLineBalance.usedAmount)} / ${fmt(creditLineBalance.capAmount)} used`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);
}
```

- [ ] **Step 2: Export the new functions**

Update the `module.exports` at the bottom of the file:

```javascript
module.exports = {
  bot,
  sendWireSubmitted,
  sendInvoiceSent,
  sendLoaded,
  sendVendorPaid,
  sendVendorFailed,
  sendCreditLineDraw,
  sendCreditLineRepayment,
};
```

- [ ] **Step 3: Update sendLoaded to include credit line repayment info**

In the `sendLoaded` function, after the `isCorrection` check block (after line 117), add a check for credit line repayment allocations. Modify the non-correction `mainMsg` block to include repayment info if present.

Replace the non-correction mainMsg section (lines 119-127) with:

```javascript
  // Check if this invoice has a credit line repayment allocation
  const creditLineRepayment = allocations.find((a) => a.isCreditLineRepayment);
  const loadAllocations = allocations.filter((a) => !a.isCreditLineRepayment);

  let mainMsg = `✅ LOADED ✅

${vendor.name}

Invoice ID: ${invoice.qbInvoiceId || invoice.id}

${allocationBlocks(loadAllocations)}`;

  if (creditLineRepayment) {
    mainMsg += `\n\n💳 Credit Line Repayment — ${fmt(creditLineRepayment.dollarAmount)}`;
    if (creditLineRepayment.creditLineBalance) {
      mainMsg += `\n  Balance: ${fmt(creditLineRepayment.creditLineBalance.usedAmount)} / ${fmt(creditLineRepayment.creditLineBalance.capAmount)} used`;
    }
  }

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    let vendorMsg = `✅ LOADED ✅

Credits have been loaded.

${allocationBlocksCreditsOnly(loadAllocations)}`;

    if (creditLineRepayment) {
      vendorMsg += `\n\n💳 Credit Line Repayment — ${fmt(creditLineRepayment.dollarAmount)}`;
    }

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/telegram.js
git commit -m "feat: add credit line Telegram notifications (draw + repayment)"
```

---

### Task 8: Invoice Submission — Handle Credit Line Repayment Allocation

**Files:**
- Modify: `backend/src/routes/forms.js`

- [ ] **Step 1: Import credit line service**

At the top of `forms.js`, add after the existing imports (after line 10):

```javascript
const creditLineService = require('../services/creditLineService');
```

- [ ] **Step 2: Handle credit line repayment in submit-invoice**

In the `submit-invoice` route handler, after creating the invoice allocations loop (after line 97), add credit line repayment handling. Find the section right after the `enrichedAllocations` loop and before the telegram notification section.

Add after the enrichedAllocations loop (after line 97, before `// Format vendor for telegram`):

```javascript
    // Handle credit line repayment allocation
    let creditLineRepaymentAmount = 0;
    if (body.creditLineRepayment && Number(body.creditLineRepayment) > 0) {
      creditLineRepaymentAmount = Number(body.creditLineRepayment);
    }
```

Then after the invoice is paid and loaded (the QB creation + telegram section), we need to track the repayment. But repayment should only be recorded when the invoice is actually paid (QB webhook), not at submission time. So we need to store the repayment intent.

Instead, add a new field to track the repayment amount on the invoice. We'll store it in the allocations with a special marker. After the enrichedAllocations loop, add:

```javascript
    // Store credit line repayment as a special allocation (vendorAccountId = null won't work with FK)
    // Instead, track via invoice metadata — we'll process this when payment arrives
    let creditLineRepaymentAmount = 0;
    if (body.creditLineRepayment && Number(body.creditLineRepayment) > 0) {
      creditLineRepaymentAmount = Number(body.creditLineRepayment);

      // Validate: vendor must have a credit line with outstanding balance
      const cl = await creditLineService.getCreditLine(vendor.id);
      if (!cl) {
        return res.status(400).json({ error: 'Vendor does not have a credit line' });
      }
      if (Number(cl.usedAmount) <= 0) {
        return res.status(400).json({ error: 'Credit line has no outstanding balance to repay' });
      }

      // Store the repayment intent in the Settings table with invoice-specific key
      await prisma.setting.upsert({
        where: { key: `credit_line_repayment_${invoice.id}` },
        update: { value: String(creditLineRepaymentAmount) },
        create: { key: `credit_line_repayment_${invoice.id}`, value: String(creditLineRepaymentAmount) },
      });
    }
```

- [ ] **Step 3: Update the allocation sum validation**

The validator checks that allocation sum matches baseAmount. With credit line repayment, the baseAmount should equal platform allocations + credit line repayment. Update the payload sent to the validator:

The form will send `baseAmount` as the full amount and `allocations` as only the platform allocations. The credit line repayment amount is separate. So the validator needs to account for it.

Before the validation call (around line 45-55), update:

```javascript
    const platformAllocSum = allocations.reduce((s, a) => s + Number(a.dollarAmount), 0);
    const clRepayment = body.creditLineRepayment ? Number(body.creditLineRepayment) : 0;
    const effectiveAllocations = [...allocations];

    // For validation: base amount should match platform allocations + credit line repayment
    const validation = validateInvoice({
      vendor,
      method: methodLabel,
      baseAmount: Number(baseAmount),
      feeAmount: Number(feeAmount),
      totalAmount: Number(totalAmount),
      allocations: effectiveAllocations.map((a) => ({
        accountId: a.accountId,
        dollarAmount: Number(a.dollarAmount),
        credits: a.credits,
      })),
      creditLineRepayment: clRepayment,
    });
```

- [ ] **Step 4: Update validator to accept creditLineRepayment**

In `backend/src/services/validator.js`, update the `validateInvoice` function signature and allocation sum check.

Replace the function signature (line 1):
```javascript
function validateInvoice({ vendor, method, baseAmount, feeAmount, totalAmount, allocations, creditLineRepayment = 0 }) {
```

Replace the allocation sum check (lines 14-17):
```javascript
  const allocSum = allocations.reduce((s, a) => s + Number(a.dollarAmount), 0) + creditLineRepayment;
  if (Math.abs(allocSum - Number(baseAmount)) > 0.01) {
    return { valid: false, error: `Allocation sum ($${(allocSum).toFixed(2)}) does not match base amount ($${Number(baseAmount).toFixed(2)})` };
  }
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/forms.js backend/src/services/validator.js
git commit -m "feat: handle credit line repayment allocation in invoice submission"
```

---

### Task 9: Webhook Processor — Record Repayment When Invoice Is Paid

**Files:**
- Modify: `backend/src/services/webhookProcessor.js` (or wherever QB payment webhook is handled)

- [ ] **Step 1: Find the webhook payment handler**

First, read the webhook processor to understand where payments are handled:

```bash
cat backend/src/routes/webhooks.js
```

Or:
```bash
cat backend/src/services/webhookProcessor.js
```

- [ ] **Step 2: Add credit line repayment processing after payment**

In the webhook handler, after an invoice is marked as PAID, check if it has a credit line repayment stored in Settings. If so, record the repayment.

Add the import at the top:
```javascript
const creditLineService = require('./creditLineService');
const telegram = require('./telegram');
```

After the invoice status is updated to PAID (find the `status: 'PAID'` update), add:

```javascript
    // Check for credit line repayment
    try {
      const repaymentSetting = await prisma.setting.findUnique({
        where: { key: `credit_line_repayment_${invoice.id}` },
      });
      if (repaymentSetting) {
        const repaymentAmount = Number(repaymentSetting.value);
        if (repaymentAmount > 0) {
          await creditLineService.recordRepayment(invoice.vendorId, invoice.id, repaymentAmount);

          // Get updated balance for notification
          const cl = await creditLineService.getCreditLine(invoice.vendorId);
          const vendor = await prisma.vendor.findUnique({ where: { id: invoice.vendorId } });

          await telegram.sendCreditLineRepayment(
            { name: vendor.name, telegramChatId: vendor.telegramChatId },
            repaymentAmount,
            { usedAmount: Number(cl.usedAmount), capAmount: Number(cl.capAmount) }
          );

          // Clean up the setting
          await prisma.setting.delete({ where: { key: `credit_line_repayment_${invoice.id}` } });

          logger.info('Credit line repayment processed', {
            invoiceId: invoice.id,
            vendorId: invoice.vendorId,
            repaymentAmount,
          });
        }
      }
    } catch (clErr) {
      logger.error('Credit line repayment processing failed', { error: clErr, invoiceId: invoice.id });
    }
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/webhookProcessor.js backend/src/routes/webhooks.js
git commit -m "feat: process credit line repayment on QB payment webhook"
```

---

### Task 10: Vendor API — Include Credit Line in Vendor Endpoint

**Files:**
- Modify: `backend/src/index.js`

- [ ] **Step 1: Include credit line data in vendor endpoint response**

In `backend/src/index.js`, in the `GET /api/vendors/:slug` handler (line 30-62), update the Prisma query to include the credit line:

Replace the `prisma.vendor.findUnique` call (lines 32-35):

```javascript
    const vendor = await prisma.vendor.findUnique({
      where: { slug: req.params.slug },
      include: { accounts: true, creditLine: true },
    });
```

Add credit line to the response JSON. After the `accounts` array (after line 57), add:

```javascript
      creditLine: vendor.creditLine ? {
        capAmount: Number(vendor.creditLine.capAmount),
        usedAmount: Number(vendor.creditLine.usedAmount),
        availableAmount: Number(vendor.creditLine.capAmount) - Number(vendor.creditLine.usedAmount),
      } : null,
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/index.js
git commit -m "feat: include credit line data in vendor API response"
```

---

### Task 11: Vendor Form — Request Credit Line Tab

**Files:**
- Modify: `frontend/src/pages/VendorForm.jsx`

- [ ] **Step 1: Add credit line state variables**

After the corrections form state (after line 56), add:

```javascript
  // Credit line state
  const [clAmount, setClAmount] = useState('');
  const [clAllocations, setClAllocations] = useState({});
  const [clSubmitted, setClSubmitted] = useState(false);
  const [clSubmitting, setClSubmitting] = useState(false);
  const [clConfirming, setClConfirming] = useState(false);
```

- [ ] **Step 2: Add credit line derived values**

After the `hasCorrectionTab` declaration (after line 90), add:

```javascript
  // Credit line
  const creditLine = vendor?.creditLine || null;
  const hasCreditLineTab = creditLine !== null;
  const clAvailable = creditLine ? creditLine.availableAmount : 0;
  const clBase = parseFloat(clAmount) || 0;

  const clAllocTotal = invoiceAccounts.reduce((sum, acct) => {
    return sum + (parseFloat(clAllocations[acct.id]) || 0);
  }, 0);
  const clSplitTotal = +clAllocTotal.toFixed(2);
  const clSplitValid = clBase > 0 && clSplitTotal === clBase;
  const clOverLimit = clBase > clAvailable;

  function getClCredits(acct) {
    const amt = parseFloat(clAllocations[acct.id]) || 0;
    const rate = parseFloat(acct.rate);
    if (!amt || !rate) return 0;
    return Math.round(amt / rate);
  }

  function setClAllocation(accountId, value) {
    setClAllocations((prev) => ({ ...prev, [accountId]: value }));
  }

  const hasAnyClAllocation = invoiceAccounts.some(
    (acct) => (parseFloat(clAllocations[acct.id]) || 0) > 0
  );

  const canSubmitCl = clBase > 0 && clSplitValid && !clOverLimit && !clSubmitting && clAvailable > 0;
```

- [ ] **Step 3: Add credit line submit handler**

After the `handleCorrectionSubmit` function (after line 219), add:

```javascript
  async function handleCreditLineSubmit(e) {
    e.preventDefault();
    if (!canSubmitCl) return;

    if (!clConfirming) {
      setClConfirming(true);
      return;
    }

    setClSubmitting(true);
    try {
      const clAccountAllocations = invoiceAccounts
        .map((acct) => ({
          accountId: acct.id,
          platform: acct.platform,
          username: acct.username,
          operatorId: acct.operatorId,
          dollarAmount: parseFloat(clAllocations[acct.id]) || 0,
          credits: getClCredits(acct),
        }))
        .filter((a) => a.dollarAmount > 0);

      await axios.post('/api/submit-credit-line', {
        vendorSlug,
        baseAmount: clBase,
        allocations: clAccountAllocations,
      });
      setClSubmitted(true);
    } catch (err) {
      alert(err.response?.data?.error || 'Credit line request failed. Please try again.');
      setClConfirming(false);
    } finally {
      setClSubmitting(false);
    }
  }
```

- [ ] **Step 4: Add the credit line tab button**

In the tabs section (around line 270-295), update the tab rendering to show credit line tab. The tabs currently only render if `hasCorrectionTab` is true. Change the condition to show tabs if either corrections or credit line exists.

Replace the tab condition and buttons (lines 270-295):

```javascript
          {/* Tabs */}
          {(hasCorrectionTab || hasCreditLineTab) && (
            <div className="flex border-b border-gray-200 mb-8">
              <button
                type="button"
                onClick={() => setActiveTab('invoice')}
                className={`px-6 py-3 text-sm font-semibold border-b-2 transition ${
                  activeTab === 'invoice'
                    ? 'border-amber-700 text-amber-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Invoice
              </button>
              {hasCorrectionTab && (
                <button
                  type="button"
                  onClick={() => setActiveTab('corrections')}
                  className={`px-6 py-3 text-sm font-semibold border-b-2 transition ${
                    activeTab === 'corrections'
                      ? 'border-amber-700 text-amber-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Corrections
                </button>
              )}
              {hasCreditLineTab && (
                <button
                  type="button"
                  onClick={() => setActiveTab('creditLine')}
                  className={`px-6 py-3 text-sm font-semibold border-b-2 transition ${
                    activeTab === 'creditLine'
                      ? 'border-amber-700 text-amber-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Request Credit Line
                </button>
              )}
            </div>
          )}
```

- [ ] **Step 5: Add the credit line tab content**

After the corrections tab section (after line 601, before the closing `</div>` of the card), add:

```javascript
          {/* ============ CREDIT LINE TAB ============ */}
          {activeTab === 'creditLine' && hasCreditLineTab && (
            <>
              {clSubmitted ? (
                <div className="text-center py-12">
                  <div className="text-green-600 text-5xl mb-4">&#10003;</div>
                  <h2 className="text-2xl font-bold mb-2">Credit Line Request Submitted</h2>
                  <p className="text-gray-600">
                    Your credit line request has been submitted. Credits will be loaded shortly.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleCreditLineSubmit}>
                  {/* Credit Line Status */}
                  <div className="mb-6 p-4 rounded-lg border bg-gray-50 border-gray-200">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-semibold text-gray-700">Credit Line</span>
                      <span className={`text-sm font-bold ${clAvailable > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {fmt(clAvailable)} available
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-3">
                      <div
                        className={`h-3 rounded-full transition-all ${
                          creditLine.usedAmount / creditLine.capAmount > 0.8
                            ? 'bg-red-500'
                            : creditLine.usedAmount / creditLine.capAmount > 0.5
                            ? 'bg-yellow-500'
                            : 'bg-green-500'
                        }`}
                        style={{ width: `${(creditLine.usedAmount / creditLine.capAmount) * 100}%` }}
                      ></div>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {fmt(creditLine.usedAmount)} used of {fmt(creditLine.capAmount)} total
                    </p>
                  </div>

                  {clAvailable <= 0 ? (
                    <div className="text-center py-8">
                      <p className="text-red-600 font-semibold text-lg mb-2">
                        Credit line fully used — {fmt(0)} of {fmt(creditLine.capAmount)} available
                      </p>
                      <p className="text-gray-500 text-sm">
                        Submit an invoice with a Credit Line Repayment allocation to free up balance.
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* Amount */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 mb-6">
                        <div>
                          <Label required>Amount ($)</Label>
                          <input
                            type="number"
                            min="1"
                            max={clAvailable}
                            step="0.01"
                            value={clAmount}
                            onChange={(e) => {
                              setClAmount(e.target.value);
                              setClAllocations({});
                              setClConfirming(false);
                            }}
                            placeholder={`Up to ${fmt(clAvailable)}`}
                            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                          <HelpText>
                            Maximum: <strong>{fmt(clAvailable)}</strong>. No fees applied.
                          </HelpText>
                        </div>
                      </div>

                      {clOverLimit && (
                        <div className="mb-6 text-sm text-red-600">
                          Amount exceeds available credit line of {fmt(clAvailable)}.
                        </div>
                      )}

                      {/* Account allocation */}
                      {clBase > 0 && !clOverLimit && (
                        <div className={`grid ${colClass} gap-4 sm:gap-6 mb-6`}>
                          {invoiceAccounts.map((acct) => (
                            <div key={acct.id}>
                              <Label required>{accountLabel(acct)}</Label>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={clAllocations[acct.id] || ''}
                                onChange={(e) => {
                                  setClAllocation(acct.id, e.target.value);
                                  setClConfirming(false);
                                }}
                                placeholder="Amount ($)"
                                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <HelpText>
                                Enter amount in <strong>dollars ($)</strong> for{' '}
                                <strong>{acct.platform === 'PLAY777' ? 'Play777' : 'IConnect'}</strong>.
                              </HelpText>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Split validation */}
                      {clBase > 0 && hasAnyClAllocation && !clSplitValid && (
                        <div className="mb-6 text-sm text-red-600">
                          The amounts must total {fmt(clBase)}. Current total: {fmt(clSplitTotal)}.
                        </div>
                      )}

                      {/* Credits preview */}
                      {clSplitValid && (
                        <div className={`grid ${colClass} gap-4 sm:gap-6 mb-6`}>
                          {invoiceAccounts.map((acct) => {
                            const amt = parseFloat(clAllocations[acct.id]) || 0;
                            if (amt <= 0) return null;
                            const credits = getClCredits(acct);
                            const rate = parseFloat(acct.rate);
                            return (
                              <div key={acct.id}>
                                <p className="text-sm font-semibold text-gray-900">
                                  Credits ({accountLabel(acct)})
                                </p>
                                <p className="text-lg font-bold text-gray-900">
                                  {credits.toLocaleString()}
                                </p>
                                <HelpText>
                                  <strong>Credits</strong> at{' '}
                                  <strong>{(rate * 100).toFixed(0)}% rate</strong>.
                                </HelpText>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Confirmation screen */}
                      {clConfirming && clSplitValid && (
                        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-md">
                          <p className="text-sm font-semibold text-amber-800 mb-2">
                            Confirm Credit Line Request
                          </p>
                          <div className="text-sm text-amber-700 space-y-1">
                            <p>Amount: <strong>{fmt(clBase)}</strong></p>
                            {invoiceAccounts.map((acct) => {
                              const amt = parseFloat(clAllocations[acct.id]) || 0;
                              if (amt <= 0) return null;
                              return (
                                <p key={acct.id}>
                                  {accountLabel(acct)}: {fmt(amt)} — {getClCredits(acct).toLocaleString()} credits
                                </p>
                              );
                            })}
                            <p className="mt-2 pt-2 border-t border-amber-300">
                              Remaining after request: <strong>{fmt(clAvailable - clBase)}</strong>
                            </p>
                          </div>
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={!canSubmitCl}
                        className={`w-full sm:w-auto px-8 py-3 rounded-md text-white font-semibold transition ${
                          canSubmitCl
                            ? 'bg-amber-700 hover:bg-amber-800 cursor-pointer'
                            : 'bg-gray-300 cursor-not-allowed'
                        }`}
                      >
                        {clSubmitting
                          ? 'Submitting...'
                          : clConfirming
                          ? 'Confirm Request'
                          : 'Request Credit Line'}
                      </button>
                    </>
                  )}
                </form>
              )}
            </>
          )}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/VendorForm.jsx
git commit -m "feat: add Request Credit Line tab to vendor form"
```

---

### Task 12: Vendor Form — Credit Line Repayment Row in Invoice Tab

**Files:**
- Modify: `frontend/src/pages/VendorForm.jsx`

- [ ] **Step 1: Add credit line repayment state**

After the wire receipt state (after line 51), add:

```javascript
  // Credit line repayment state (in invoice tab)
  const [clRepayment, setClRepayment] = useState('');
```

- [ ] **Step 2: Reset repayment on method/amount change**

In the `useEffect` that resets on method change (line 72), add `setClRepayment('')`:

```javascript
  useEffect(() => {
    setBaseAmount('');
    setAllocations({});
    setClRepayment('');
  }, [method]);
```

In the `useEffect` that resets on base amount change (line 77), add `setClRepayment('')`:

```javascript
  useEffect(() => {
    setAllocations({});
    setClRepayment('');
  }, [baseAmount]);
```

- [ ] **Step 3: Update allocation validation to include repayment**

The current `splitTotal` and `splitValid` (lines 106-110) only consider platform allocations. Update to include credit line repayment:

```javascript
  const clRepaymentAmount = parseFloat(clRepayment) || 0;

  const allocTotal = invoiceAccounts.reduce((sum, acct) => {
    return sum + (parseFloat(allocations[acct.id]) || 0);
  }, 0) + clRepaymentAmount;
  const splitTotal = +allocTotal.toFixed(2);
  const splitValid = base > 0 && splitTotal === base;
```

- [ ] **Step 4: Update handleInvoiceSubmit to include repayment**

In the `handleInvoiceSubmit` function, update the payload to include the credit line repayment amount. After building the payload (around line 158-165):

```javascript
      const payload = {
        vendorSlug,
        method,
        baseAmount: base,
        feeAmount,
        totalAmount,
        allocations: accountAllocations,
        creditLineRepayment: clRepaymentAmount > 0 ? clRepaymentAmount : undefined,
      };
```

- [ ] **Step 5: Add Credit Line Repayment row in the allocation grid**

After the invoice accounts allocation grid (after line 452, before the split validation message), add the credit line repayment field:

```javascript
                {/* Credit Line Repayment row */}
                {base > 0 && hasCreditLineTab && creditLine.usedAmount > 0 && (
                  <div className="mb-6">
                    <div className="p-4 rounded-lg border border-blue-200 bg-blue-50">
                      <Label>Credit Line Repayment</Label>
                      <input
                        type="number"
                        min="0"
                        max={Math.min(base, creditLine.usedAmount)}
                        step="0.01"
                        value={clRepayment}
                        onChange={(e) => setClRepayment(e.target.value)}
                        placeholder="Amount ($)"
                        className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <HelpText>
                        Allocate toward your credit line balance. Currently{' '}
                        <strong>{fmt(creditLine.usedAmount)}</strong> /{' '}
                        <strong>{fmt(creditLine.capAmount)}</strong> used.
                      </HelpText>
                    </div>
                  </div>
                )}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/VendorForm.jsx
git commit -m "feat: add Credit Line Repayment allocation option in invoice tab"
```

---

### Task 13: Admin Dashboard — Credit Lines View

**Files:**
- Modify: `frontend/src/pages/AdminDashboard.jsx`
- Modify: `backend/src/routes/admin.js`

- [ ] **Step 1: Add admin credit line API endpoints**

In `backend/src/routes/admin.js`, add these endpoints before `module.exports`:

```javascript
// Credit Line overview (all vendors)
router.get('/credit-lines', async (req, res) => {
  try {
    const creditLines = await prisma.creditLine.findMany({
      include: {
        vendor: { select: { slug: true, name: true, businessName: true } },
      },
    });

    const formatted = creditLines.map((cl) => ({
      id: cl.id,
      vendorSlug: cl.vendor.slug,
      vendorName: cl.vendor.name,
      businessName: cl.vendor.businessName,
      capAmount: Number(cl.capAmount),
      usedAmount: Number(cl.usedAmount),
      availableAmount: Number(cl.capAmount) - Number(cl.usedAmount),
      updatedAt: cl.updatedAt,
    }));

    res.json(formatted);
  } catch (err) {
    logger.error('Credit lines overview error', { error: err });
    res.status(500).json({ error: 'Failed to fetch credit lines' });
  }
});

// Credit Line transactions (all or filtered by vendor)
router.get('/credit-line-transactions', async (req, res) => {
  try {
    const { vendorSlug, type } = req.query;

    const where = {};
    if (vendorSlug) {
      const vendor = await prisma.vendor.findUnique({ where: { slug: vendorSlug } });
      if (vendor) {
        const cl = await prisma.creditLine.findUnique({ where: { vendorId: vendor.id } });
        if (cl) where.creditLineId = cl.id;
      }
    }
    if (type) where.type = type;

    const transactions = await prisma.creditLineTransaction.findMany({
      where,
      include: {
        creditLine: {
          include: { vendor: { select: { slug: true, name: true } } },
        },
        invoice: { select: { id: true, method: true, baseAmount: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const formatted = transactions.map((t) => ({
      id: t.id,
      vendorSlug: t.creditLine.vendor.slug,
      vendorName: t.creditLine.vendor.name,
      type: t.type,
      amount: Number(t.amount),
      balanceBefore: Number(t.balanceBefore),
      balanceAfter: Number(t.balanceAfter),
      invoiceId: t.invoiceId,
      createdAt: t.createdAt,
    }));

    res.json(formatted);
  } catch (err) {
    logger.error('Credit line transactions error', { error: err });
    res.status(500).json({ error: 'Failed to fetch credit line transactions' });
  }
});
```

- [ ] **Step 2: Add credit line view toggle in AdminDashboard**

In `AdminDashboard.jsx`, add a "Credit Lines" button to the view toggle bar (around line 183, after the Corrections button):

```javascript
              <button
                onClick={() => setView('creditLines')}
                className={`px-3 py-1 text-xs rounded-md transition ${view === 'creditLines' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-300'}`}
              >
                Credit Lines
              </button>
```

- [ ] **Step 3: Add state and fetch for credit lines**

After the `corrections` state (around line 19), add:

```javascript
  const [creditLines, setCreditLines] = useState([]);
  const [clTransactions, setClTransactions] = useState([]);
  const [clVendorFilter, setClVendorFilter] = useState('');
```

Add fetch functions after `fetchCorrections` (around line 59):

```javascript
  const fetchCreditLines = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/credit-lines', { headers: getAuthHeaders() });
      setCreditLines(res.data);
    } catch (err) {
      handleAuthError(err);
    }
  }, []);

  const fetchClTransactions = useCallback(async () => {
    try {
      const params = clVendorFilter ? `?vendorSlug=${clVendorFilter}` : '';
      const res = await axios.get(`/api/admin/credit-line-transactions${params}`, { headers: getAuthHeaders() });
      setClTransactions(res.data);
    } catch (err) {
      handleAuthError(err);
    }
  }, [clVendorFilter]);
```

Add to the `useEffect` (around line 67):

```javascript
    fetchCreditLines();
    fetchClTransactions();
```

And add to the dependency arrays and interval if desired.

- [ ] **Step 4: Add the view routing**

In the main render (around line 192-213), add the credit lines view case:

```javascript
        ) : view === 'creditLines' ? (
          <CreditLinesView
            creditLines={creditLines}
            transactions={clTransactions}
            vendorFilter={clVendorFilter}
            onVendorFilter={(slug) => setClVendorFilter(slug)}
            onRefresh={() => { fetchCreditLines(); fetchClTransactions(); }}
          />
```

- [ ] **Step 5: Add the CreditLinesView component**

Add before the `StatusBadge` component:

```javascript
function CreditLinesView({ creditLines, transactions, vendorFilter, onVendorFilter, onRefresh }) {
  function fmt(n) {
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return (
    <div>
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
        {creditLines.map((cl) => {
          const pct = cl.capAmount > 0 ? (cl.usedAmount / cl.capAmount) * 100 : 0;
          const color = pct > 80 ? 'text-red-400' : pct > 50 ? 'text-yellow-400' : 'text-green-400';
          return (
            <div
              key={cl.id}
              onClick={() => onVendorFilter(vendorFilter === cl.vendorSlug ? '' : cl.vendorSlug)}
              className={`bg-[#161922] rounded-xl border cursor-pointer transition ${
                vendorFilter === cl.vendorSlug ? 'border-blue-500' : 'border-gray-800 hover:border-gray-600'
              } p-4`}
            >
              <p className="text-xs text-gray-500 mb-1">{cl.vendorName}</p>
              <p className={`text-xl font-bold ${color}`}>{fmt(cl.availableAmount)}</p>
              <div className="w-full bg-gray-800 rounded-full h-1.5 mt-2">
                <div
                  className={`h-1.5 rounded-full ${
                    pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${pct}%` }}
                ></div>
              </div>
              <p className="text-[10px] text-gray-600 mt-1">
                {fmt(cl.usedAmount)} / {fmt(cl.capAmount)} used
              </p>
            </div>
          );
        })}
      </div>

      {/* Transaction History */}
      <div className="bg-[#161922] rounded-xl border border-gray-800 overflow-x-auto">
        <div className="flex justify-between items-center px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-gray-300">
            Transaction History
            {vendorFilter && <span className="text-blue-400 ml-2">({vendorFilter})</span>}
          </h3>
          {vendorFilter && (
            <button
              onClick={() => onVendorFilter('')}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Clear filter
            </button>
          )}
        </div>
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Vendor</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-right">Balance After</th>
              <th className="px-4 py-3">Invoice</th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 ? (
              <tr>
                <td colSpan="6" className="px-4 py-8 text-center text-gray-500">
                  No transactions yet.
                </td>
              </tr>
            ) : (
              transactions.map((t) => (
                <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{' '}
                    {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-200 capitalize">{t.vendorName}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                      t.type === 'DRAW'
                        ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                        : 'bg-green-500/15 text-green-400 border-green-500/30'
                    }`}>
                      {t.type}
                    </span>
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${
                    t.type === 'DRAW' ? 'text-orange-400' : 'text-green-400'
                  }`}>
                    {t.type === 'DRAW' ? '-' : '+'}{fmt(t.amount)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-300">
                    {fmt(t.balanceAfter)}
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                    #{t.invoiceId}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/AdminDashboard.jsx backend/src/routes/admin.js
git commit -m "feat: add Credit Lines admin dashboard view with overview and transaction history"
```

---

### Task 14: Integration Test — End-to-End Credit Line Flow

**Files:**
- All previously modified files

- [ ] **Step 1: Build frontend and restart backend**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/frontend
npm run build

cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend
npx prisma db seed
```

- [ ] **Step 2: Test credit line balance endpoint**

```bash
curl -s http://localhost:3000/api/vendors/alex | jq '.creditLine'
```

Expected:
```json
{
  "capAmount": 10000,
  "usedAmount": 0,
  "availableAmount": 10000
}
```

```bash
curl -s http://localhost:3000/api/vendors/jose | jq '.creditLine'
```

Expected: `usedAmount: 5000`, `availableAmount: 0`

- [ ] **Step 3: Test credit line draw for Alex (should succeed)**

```bash
curl -s -X POST http://localhost:3000/api/submit-credit-line \
  -H 'Content-Type: application/json' \
  -d '{
    "vendorSlug": "alex",
    "baseAmount": 3000,
    "allocations": [
      { "accountId": <ALEX_ACCOUNT_ID>, "dollarAmount": 3000, "credits": 8571 }
    ]
  }'
```

Expected: `{ "success": true, "invoiceId": ... }`

- [ ] **Step 4: Test credit line draw for Jose (should fail — maxed out)**

```bash
curl -s -X POST http://localhost:3000/api/submit-credit-line \
  -H 'Content-Type: application/json' \
  -d '{
    "vendorSlug": "jose",
    "baseAmount": 1000,
    "allocations": [
      { "accountId": <JOSE_ACCOUNT_ID>, "dollarAmount": 1000, "credits": 3333 }
    ]
  }'
```

Expected: `400` with error about exceeding available credit line.

- [ ] **Step 5: Test admin credit line endpoints**

```bash
# Get credit lines overview
curl -s http://localhost:3000/api/admin/credit-lines \
  -H "Authorization: Bearer <ADMIN_TOKEN>" | jq

# Get transactions
curl -s http://localhost:3000/api/admin/credit-line-transactions \
  -H "Authorization: Bearer <ADMIN_TOKEN>" | jq
```

Expected: Credit lines show for all 3 vendors. Transactions show Alex's draw.

- [ ] **Step 6: Verify Telegram notification was sent**

Check the admin Telegram chat for the credit line draw notification for Alex.

- [ ] **Step 7: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: integration fixes for credit line feature"
```

---

### Task 15: Deploy to Production

- [ ] **Step 1: Push code to remote**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git push origin main
```

- [ ] **Step 2: Deploy to Hetzner VPS**

```bash
bash deploy.sh
```

Or SSH in and pull:
```bash
ssh root@<HETZNER_IP>
cd /root/WokeAVR-CreditLoader-Pipeline
git pull origin main
cd backend && npx prisma migrate deploy && npx prisma db seed
cd ../frontend && npm run build
pm2 restart creditloader
```

- [ ] **Step 3: Verify production**

Test the vendor form URLs in browser:
- `https://load.wokeavr.com/form/claudia` — should show Request Credit Line tab
- `https://load.wokeavr.com/form/alex` — should show Request Credit Line tab
- `https://load.wokeavr.com/form/jose` — should show tab but disabled (maxed out)
- `https://load.wokeavr.com/form/mike` — should NOT show credit line tab

Check admin dashboard at `https://load.wokeavr.com/admin` — Credit Lines view should show all 3 vendors.
