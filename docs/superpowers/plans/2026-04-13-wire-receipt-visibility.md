# Wire Receipt Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist wire receipt filenames in the database, send the actual image to Telegram, and display receipt thumbnails on the admin dashboard pipeline view.

**Architecture:** Add a nullable `wireReceiptPath` column to the Invoice model. On wire submission, save the filename to the invoice record and send the photo via Telegram `sendPhoto`. Serve uploads behind `requireAdmin` and render a clickable thumbnail on wire invoice cards.

**Tech Stack:** Prisma (migration), Express (static route), node-telegram-bot-api (`sendPhoto`), React (InvoiceCard thumbnail)

---

### Task 1: Add wireReceiptPath to Invoice Schema + Migration

**Files:**
- Modify: `backend/src/db/prisma/schema.prisma:94-115`

- [ ] **Step 1: Add the column to the Prisma schema**

In `backend/src/db/prisma/schema.prisma`, add `wireReceiptPath` to the Invoice model after `loadedAt`:

```prisma
model Invoice {
  id               Int           @id @default(autoincrement())
  vendorId         Int           @map("vendor_id")
  qbInvoiceId      String?       @map("qb_invoice_id")
  method           String
  baseAmount       Decimal       @map("base_amount") @db.Decimal(10, 2)
  feeAmount        Decimal       @map("fee_amount") @db.Decimal(10, 2)
  totalAmount      Decimal       @map("total_amount") @db.Decimal(10, 2)
  status           InvoiceStatus @default(REQUESTED)
  submittedAt      DateTime      @default(now()) @map("submitted_at")
  paidAt           DateTime?     @map("paid_at")
  loadedAt         DateTime?     @map("loaded_at")
  wireReceiptPath  String?       @map("wire_receipt_path")

  vendor                 Vendor              @relation(fields: [vendorId], references: [id])
  allocations            InvoiceAllocation[]
  loadJobs               LoadJob[]
  creditLineTransactions CreditLineTransaction[]

  @@index([qbInvoiceId])
  @@index([vendorId])
  @@map("invoices")
}
```

- [ ] **Step 2: Generate and run the migration**

```bash
cd backend
npx prisma migrate dev --schema=src/db/prisma/schema.prisma --name add_wire_receipt_path
```

Expected: Migration creates `wire_receipt_path` nullable column on `invoices` table. Prisma client regenerated.

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/prisma/schema.prisma backend/src/db/prisma/migrations/
git commit -m "feat: add wireReceiptPath column to Invoice model"
```

---

### Task 2: Persist Receipt Path on Wire Submission

**Files:**
- Modify: `backend/src/routes/forms.js:70-82` (invoice create) and `backend/src/routes/forms.js:140-151` (receipt save block)

- [ ] **Step 1: Save wireReceiptPath when creating the invoice**

In `backend/src/routes/forms.js`, modify the `prisma.invoice.create` call (around line 72) to include the receipt filename:

```javascript
    // Create invoice in DB
    const invoice = await prisma.invoice.create({
      data: {
        vendorId: vendor.id,
        method: methodLabel,
        baseAmount,
        feeAmount,
        totalAmount,
        status: isWire ? 'PENDING' : 'REQUESTED',
        wireReceiptPath: req.file ? req.file.filename : null,
      },
    });
```

- [ ] **Step 2: Remove the orphaned "Save wire receipt path" comment block**

The existing block at lines 140-151 logs the filename and does the backup copy. Keep the backup logic but remove the misleading "Save wire receipt path" comment since we now actually save it in the DB. Replace:

```javascript
    // Save wire receipt path if uploaded
    if (req.file) {
      logger.info('Wire receipt saved', { filename: req.file.filename });
      // Backup wire receipt
      const backupDir = '/var/backups/creditloader/receipts';
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(req.file.path, path.join(backupDir, req.file.filename));
      } catch (backupErr) {
        logger.error('Wire receipt backup failed', { error: backupErr });
      }
    }
```

With:

```javascript
    // Backup wire receipt to secondary storage
    if (req.file) {
      logger.info('Wire receipt saved to DB', { filename: req.file.filename, invoiceId: invoice.id });
      const backupDir = '/var/backups/creditloader/receipts';
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(req.file.path, path.join(backupDir, req.file.filename));
      } catch (backupErr) {
        logger.error('Wire receipt backup failed', { error: backupErr });
      }
    }
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/forms.js
git commit -m "feat: persist wire receipt filename in invoice record"
```

---

### Task 3: Send Actual Photo to Telegram

**Files:**
- Modify: `backend/src/services/telegram.js:1-60`
- Modify: `backend/src/routes/forms.js:153-158` (wire telegram call)

- [ ] **Step 1: Update sendWireSubmitted to accept and send the receipt file**

In `backend/src/services/telegram.js`, add `fs` and `path` imports at the top:

```javascript
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
```

Then replace the `sendWireSubmitted` function:

```javascript
async function sendWireSubmitted(vendor, invoice, allocations, receiptFilePath) {
  const mainMsg = `📩 Wire Submitted

${vendor.name}

Invoice ID: ${invoice.id}
Method: Wire
Amount: ${fmt(invoice.baseAmount)}

${allocationBlocks(allocations)}

🔒 PENDING WIRE CONFIRMATION 🔒`;

  // Send receipt photo with caption if file exists, otherwise text-only
  if (receiptFilePath && fs.existsSync(receiptFilePath)) {
    await bot.sendPhoto(ADMIN_CHAT_ID, fs.createReadStream(receiptFilePath), {
      caption: mainMsg,
    });
  } else {
    await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);
  }

  if (vendor.telegramChatId) {
    const vendorMsg = `📩 Wire Submission Received

Your wire form for ${fmt(invoice.baseAmount)} has been submitted. Credits will be loaded once the wire is confirmed.`;

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
}
```

- [ ] **Step 2: Pass the receipt file path from forms.js**

In `backend/src/routes/forms.js`, update the wire telegram call (around line 153-158). Replace:

```javascript
    if (isWire) {
      try {
        await telegram.sendWireSubmitted(vendorData, invoiceData, enrichedAllocations);
      } catch (err) {
        logger.error('Telegram wire notification failed', { error: err });
      }
```

With:

```javascript
    if (isWire) {
      try {
        await telegram.sendWireSubmitted(vendorData, invoiceData, enrichedAllocations, req.file ? req.file.path : null);
      } catch (err) {
        logger.error('Telegram wire notification failed', { error: err });
      }
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/telegram.js backend/src/routes/forms.js
git commit -m "feat: send wire receipt photo to Telegram admin chat"
```

---

### Task 4: Serve Uploads Behind Admin Auth

**Files:**
- Modify: `backend/src/index.js:133` (add static route after screenshots line)

- [ ] **Step 1: Add the uploads static route**

In `backend/src/index.js`, add a new static route right after the screenshots line (line 133):

```javascript
// Serve failure screenshots for admin dashboard
app.use('/api/screenshots', requireAdmin, express.static('/var/log/creditloader/failures'));

// Serve wire receipt uploads for admin dashboard
app.use('/api/uploads', requireAdmin, express.static(path.join(__dirname, '..', 'uploads')));
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/index.js
git commit -m "feat: serve wire receipt uploads behind admin auth"
```

---

### Task 5: Include wireReceiptPath in Admin API Response

**Files:**
- Modify: `backend/src/routes/admin.js:54-66` (formatted invoice mapping)

- [ ] **Step 1: Add wireReceiptPath to the invoice response**

In `backend/src/routes/admin.js`, in the `formatted` mapping inside `GET /invoices` (around line 54), add `wireReceiptPath`:

```javascript
    const formatted = invoices.map((inv) => ({
      invoice: {
        id: inv.id,
        vendorSlug: inv.vendor.slug,
        qbInvoiceId: inv.qbInvoiceId,
        method: inv.method,
        baseAmount: Number(inv.baseAmount),
        feeAmount: Number(inv.feeAmount),
        totalAmount: Number(inv.totalAmount),
        status: inv.status,
        submittedAt: inv.submittedAt,
        paidAt: inv.paidAt,
        loadedAt: inv.loadedAt,
        wireReceiptPath: inv.wireReceiptPath,
      },
      allocations: inv.allocations.map((a) => ({
        accountId: a.vendorAccountId,
        dollarAmount: Number(a.dollarAmount),
        credits: a.credits,
        platform: a.vendorAccount.platform,
        username: a.vendorAccount.username,
        operatorId: a.vendorAccount.operatorId,
      })),
    }));
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/routes/admin.js
git commit -m "feat: include wireReceiptPath in admin invoices API"
```

---

### Task 6: Show Receipt Thumbnail on InvoiceCard

**Files:**
- Modify: `frontend/src/components/InvoiceCard.jsx`

- [ ] **Step 1: Add receipt thumbnail and lightbox state**

Replace the entire `InvoiceCard.jsx` with:

```jsx
import { useState } from 'react';

function fmt(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function InvoiceCard({ invoice, allocations, onConfirmWire, onTriggerLoad, onResendEmail, onShowEvents }) {
  const [showReceipt, setShowReceipt] = useState(false);

  const isPending = invoice.status === 'PENDING';
  const isFailed = invoice.status === 'FAILED';
  const isPaid = invoice.status === 'PAID';
  const isRequested = invoice.status === 'REQUESTED';
  const canResend = (isRequested || isPending) && invoice.qbInvoiceId;

  const receiptUrl = invoice.wireReceiptPath ? `/api/uploads/${invoice.wireReceiptPath}` : null;

  return (
    <>
      <div className="bg-[#1c1f2e] rounded-lg border border-gray-800 hover:border-gray-700 transition p-3 group">
        {/* Header */}
        <div className="flex justify-between items-start mb-2">
          <p className="font-semibold text-sm text-gray-200 capitalize">{invoice.vendorSlug}</p>
          <span className="text-[10px] text-gray-600 font-mono">{timeAgo(invoice.submittedAt)}</span>
        </div>

        {/* Method & Amount */}
        <div className="flex justify-between items-baseline mb-3">
          <span className="text-[10px] uppercase tracking-wider text-gray-500">{invoice.method}</span>
          <span className="text-sm font-bold text-gray-100">{fmt(invoice.baseAmount)}</span>
        </div>

        {/* Wire Receipt Thumbnail */}
        {receiptUrl && (
          <button
            onClick={() => setShowReceipt(true)}
            className="mb-3 w-full rounded-md overflow-hidden border border-gray-700 hover:border-amber-500/50 transition"
          >
            <img
              src={receiptUrl}
              alt="Wire receipt"
              className="w-full h-20 object-cover opacity-80 hover:opacity-100 transition"
            />
          </button>
        )}

        {/* Allocations */}
        <div className="space-y-1.5 mb-1">
          {allocations
            .filter((a) => a.dollarAmount > 0)
            .map((a, i) => {
              const platform = a.platform === 'PLAY777' ? '777' : 'IC';
              const id = a.operatorId ? ` ${a.operatorId}` : '';
              return (
                <div key={i} className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1 h-1 rounded-full ${a.platform === 'PLAY777' ? 'bg-blue-400' : 'bg-emerald-400'}`}></span>
                    <span className="text-gray-500">{platform}</span>
                    <span className="text-gray-400">{a.username}{id}</span>
                  </div>
                  <span className="font-mono text-gray-300">{a.credits.toLocaleString()}</span>
                </div>
              );
            })}
        </div>

        {/* Actions */}
        {isPending && (
          <button
            onClick={() => onConfirmWire(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition"
          >
            Confirm Wire
          </button>
        )}

        {isFailed && (
          <button
            onClick={() => onTriggerLoad(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition"
          >
            Retry Load
          </button>
        )}

        {isPaid && (
          <button
            onClick={() => onTriggerLoad(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 transition"
          >
            Trigger Load
          </button>
        )}

        {canResend && (
          <button
            onClick={() => onResendEmail(invoice.id)}
            className="mt-2 w-full text-xs font-semibold py-2 rounded-lg bg-gray-500/10 border border-gray-500/30 text-gray-400 hover:bg-gray-500/20 transition"
          >
            Resend Email
          </button>
        )}

        {onShowEvents && (
          <button
            onClick={() => onShowEvents(invoice.id)}
            className="mt-2 w-full text-xs font-semibold py-1.5 rounded-lg text-[#2563eb] hover:bg-[#2563eb]/10 transition"
          >
            Events
          </button>
        )}
      </div>

      {/* Receipt Lightbox */}
      {showReceipt && receiptUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setShowReceipt(false)}
        >
          <div className="relative max-w-2xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowReceipt(false)}
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-gray-800 border border-gray-600 text-gray-300 hover:text-white flex items-center justify-center text-sm"
            >
              X
            </button>
            <img
              src={receiptUrl}
              alt="Wire receipt"
              className="rounded-lg max-h-[85vh] object-contain"
            />
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/InvoiceCard.jsx
git commit -m "feat: show wire receipt thumbnail with lightbox on invoice cards"
```

---

### Task 7: Build Frontend and Verify

- [ ] **Step 1: Build the frontend**

```bash
cd frontend
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 2: Commit build output if applicable**

```bash
git add -A
git commit -m "chore: rebuild frontend with wire receipt UI"
```
