# Cash Payment Method Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Cash` payment method to the vendor form, gated to Alex and Claudia, that creates no QB invoice and waits in PENDING until admin confirms cash received from the pipeline.

**Architecture:** Cash mirrors Wire's offline-payment flow (status=PENDING, no QB, admin confirms → autoload fires) but with fee=0, no receipt upload, and a server-side allowlist of vendor slugs. A new shared constant module holds the allowlist so the frontend and backend never drift.

**Tech Stack:** Node 20 / Express / Prisma / Jest (backend). React + axios + Tailwind (frontend).

**Spec:** `docs/superpowers/specs/2026-04-18-cash-payment-method-design.md`

---

## File Map

**Create:**
- `backend/src/constants/cash.js` — allowlist of vendor slugs that can use Cash.

**Modify:**
- `backend/src/services/validator.js` — accept `method === 'Cash'` with fee=0 validation.
- `backend/src/routes/forms.js` — Cash branch: allowlist guard, fee enforcement, status=PENDING, no QB.
- `backend/src/services/telegram.js` — new `sendCashSubmitted(vendor, invoice, allocations)`.
- `backend/src/routes/admin.js` — new `POST /invoices/:id/confirm-cash` endpoint.
- `backend/__tests__/validator.test.js` — add Cash test cases.
- `frontend/src/pages/VendorForm.jsx` — add Cash to method config + dropdown + gating.
- `frontend/src/components/InvoiceCard.jsx` — add `Mark Cash Received` button for Cash PENDING.
- `frontend/src/pages/AdminDashboard.jsx` — wire `onConfirmCash` handler.

---

## Task 1: Allowlist constant module

**Files:**
- Create: `backend/src/constants/cash.js`

- [ ] **Step 1: Create the constant file**

```js
// backend/src/constants/cash.js

// Vendor slugs allowed to use the Cash payment method.
// Hardcoded — expand here if a third vendor needs it.
const CASH_ALLOWED_SLUGS = ['alex', 'claudia'];

module.exports = { CASH_ALLOWED_SLUGS };
```

- [ ] **Step 2: Commit**

```bash
cd ~/Claude/Projects/loading-pipeline
git add backend/src/constants/cash.js
git commit -m "cash: add allowlist constant for vendor slugs"
```

---

## Task 2: Validator accepts Cash (TDD)

**Files:**
- Modify: `backend/src/services/validator.js`
- Test: `backend/__tests__/validator.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `backend/__tests__/validator.test.js` after the existing `describe('validateInvoice', ...)` block closes — just before the file's final `validateCorrection` describe:

```js
  describe('Cash method', () => {
    const cashVendor = makeVendor();

    test('valid Cash invoice with single allocation', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 2000,
        feeAmount: 0,
        totalAmount: 2000,
        allocations: [{ accountId: 10, dollarAmount: 2000, credits: 5714 }],
      });
      expect(result.valid).toBe(true);
    });

    test('Cash rejects nonzero fee', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 2000,
        feeAmount: 10,
        totalAmount: 2010,
        allocations: [{ accountId: 10, dollarAmount: 2000, credits: 5714 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/cash.*fee/i);
    });

    test('Cash enforces $1000 minimum', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 500,
        feeAmount: 0,
        totalAmount: 500,
        allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/minimum/i);
    });

    test('Cash supports credit-line repayment', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 3000,
        feeAmount: 0,
        totalAmount: 3000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2857 }],
        creditLineRepayment: 2000,
      });
      expect(result.valid).toBe(true);
    });
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd ~/Claude/Projects/loading-pipeline/backend && npx jest __tests__/validator.test.js --no-cache`
Expected: 1 failing test — `Cash rejects nonzero fee` (the other three pass already because existing validator logic is permissive for unknown methods and the $1000 minimum check applies to Cash).

- [ ] **Step 3: Add the Cash fee enforcement**

Modify `backend/src/services/validator.js`. After the existing `if (baseAmount <= 0)` check and before the $1000 minimum check, add:

```js
  if (method === 'Cash' && Number(feeAmount) !== 0) {
    return { valid: false, error: 'Cash invoices must have no fee' };
  }
```

Full updated top of function for clarity:

```js
function validateInvoice({ vendor, method, baseAmount, feeAmount, totalAmount, allocations, creditLineRepayment = 0 }) {
  if (baseAmount <= 0) return { valid: false, error: 'Base amount must be positive' };

  if (method === 'Cash' && Number(feeAmount) !== 0) {
    return { valid: false, error: 'Cash invoices must have no fee' };
  }

  if (method !== 'Wire' && method !== 'Credit Line' && baseAmount < 1000) {
    return { valid: false, error: `$1,000 minimum required for ${method}` };
  }
  // ... rest unchanged
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd ~/Claude/Projects/loading-pipeline/backend && npx jest __tests__/validator.test.js --no-cache`
Expected: all 4 Cash tests pass, no other tests regress.

- [ ] **Step 5: Commit**

```bash
cd ~/Claude/Projects/loading-pipeline
git add backend/src/services/validator.js backend/__tests__/validator.test.js
git commit -m "cash: validator accepts method=Cash with fee=0"
```

---

## Task 3: Backend forms.js — Cash submission branch

**Files:**
- Modify: `backend/src/routes/forms.js`

- [ ] **Step 1: Import the allowlist**

At the top of `backend/src/routes/forms.js`, alongside other requires:

```js
const { CASH_ALLOWED_SLUGS } = require('../constants/cash');
```

- [ ] **Step 2: Add allowlist guard and method handling**

In the POST `/submit-invoice` handler, after `const vendor = await prisma.vendor.findUnique(...)` returns and before `validateInvoice` runs, add:

```js
    if (method === 'Cash' && !CASH_ALLOWED_SLUGS.includes(vendor.slug)) {
      return res.status(403).json({ error: 'Cash not enabled for this vendor' });
    }
```

Then update the `isWire` / `methodLabel` computation to include Cash as an offline method:

Find:
```js
    const isWire = method === 'Wire';
    const methodLabel = isWire ? 'Wire' : method === 'ACH' ? 'ACH (1%)' : 'Credit/Debit (3%)';
```

Replace with:
```js
    const isWire = method === 'Wire';
    const isCash = method === 'Cash';
    const isOffline = isWire || isCash;
    let methodLabel;
    if (isWire) methodLabel = 'Wire';
    else if (isCash) methodLabel = 'Cash';
    else if (method === 'ACH') methodLabel = 'ACH (1%)';
    else methodLabel = 'Credit/Debit (3%)';
```

Then replace the invoice creation's `status` line. Find:
```js
        status: isWire ? 'PENDING' : 'REQUESTED',
```

Replace with:
```js
        status: isOffline ? 'PENDING' : 'REQUESTED',
```

- [ ] **Step 3: Gate QB invoice creation on !isOffline**

Look for the `if (!isWire)` block that creates the QB invoice (it should be further down in the handler — the block that calls `quickbooks.createInvoice` and `quickbooks.sendInvoiceEmail`). Replace the `if (!isWire)` guard with `if (!isOffline)` so Cash also skips QB.

If the block looks like:
```js
    if (!isWire) {
      // QB invoice creation ...
    }
```

Change to:
```js
    if (!isOffline) {
      // QB invoice creation ...
    }
```

- [ ] **Step 4: Branch Telegram submission on Cash vs Wire**

Find the block that sends Telegram on submission. It currently looks something like:
```js
    if (isWire) {
      try {
        await telegram.sendWireSubmitted(vendorData, invoiceData, enrichedAllocations, req.file ? req.file.path : null);
      } catch (err) { ... }
    }
```

Add a parallel Cash branch before the Wire block (so Wire remains unchanged):

```js
    if (isCash) {
      try {
        await telegram.sendCashSubmitted(vendorData, invoiceData, enrichedAllocations);
      } catch (err) {
        logger.error('Telegram cash notification failed', { error: err });
      }
    }
```

(The `sendCashSubmitted` function will be added in Task 4.)

- [ ] **Step 5: Verify the backend still boots**

Run: `cd ~/Claude/Projects/loading-pipeline/backend && node -e "require('./src/routes/forms')"`
Expected: exits cleanly with no output. A SyntaxError here means the edits broke the file.

- [ ] **Step 6: Commit**

```bash
cd ~/Claude/Projects/loading-pipeline
git add backend/src/routes/forms.js
git commit -m "cash: handle Cash method in form submission (allowlist, no QB, PENDING)"
```

---

## Task 4: Telegram sendCashSubmitted

**Files:**
- Modify: `backend/src/services/telegram.js`

- [ ] **Step 1: Add the function**

In `backend/src/services/telegram.js`, just below the existing `sendWireSubmitted` function definition, add:

```js
async function sendCashSubmitted(vendor, invoice, allocations) {
  const mainMsg = `💵 Cash Submitted

${vendor.name}

Invoice ID: ${invoice.id}
Method: Cash
Amount: ${fmt(invoice.baseAmount)}

${allocationBlocks(allocations)}

🔒 PENDING CASH CONFIRMATION 🔒`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    const vendorMsg = `💵 Cash Request Received

Your cash form for ${fmt(invoice.baseAmount)} has been submitted. Credits will be loaded once the cash is received and confirmed.`;

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
}
```

- [ ] **Step 2: Export it**

In the `module.exports` block at the bottom of `telegram.js`, add `sendCashSubmitted` to the export list. Find the existing `sendWireSubmitted,` line and add the new one right after:

```js
module.exports = {
  // ... existing exports
  sendWireSubmitted,
  sendCashSubmitted,
  // ... rest of exports
};
```

- [ ] **Step 3: Verify module loads**

Run: `cd ~/Claude/Projects/loading-pipeline/backend && node -e "const t = require('./src/services/telegram'); if (typeof t.sendCashSubmitted !== 'function') { console.error('FAIL: export missing'); process.exit(1); } console.log('OK');"`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
cd ~/Claude/Projects/loading-pipeline
git add backend/src/services/telegram.js
git commit -m "cash: add sendCashSubmitted Telegram helper"
```

---

## Task 5: Admin confirm-cash endpoint

**Files:**
- Modify: `backend/src/routes/admin.js`

- [ ] **Step 1: Add the endpoint**

In `backend/src/routes/admin.js`, locate the existing `POST /invoices/:id/confirm-wire` handler. Immediately after its closing `});`, add the Cash mirror:

```js
// Admin confirms cash was received — flips PENDING Cash → PAID and triggers autoload.
router.post('/invoices/:id/confirm-cash', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        vendor: true,
        allocations: { include: { vendorAccount: true } },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.method !== 'Cash') return res.status(400).json({ error: 'Not a cash invoice' });
    if (invoice.status !== 'PENDING') return res.status(400).json({ error: 'Invoice not in PENDING status' });

    await prisma.invoice.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    res.json({ success: true, message: 'Cash confirmed, loading credits...' });

    autoloader.processInvoice(id).catch((err) => {
      console.error('Auto-loader failed for cash invoice:', err.message);
    });
  } catch (err) {
    console.error('Confirm cash error:', err);
    res.status(500).json({ error: 'Failed to confirm cash' });
  }
});
```

- [ ] **Step 2: Verify the file still parses**

Run: `cd ~/Claude/Projects/loading-pipeline/backend && node -e "require('./src/routes/admin')"`
Expected: exits cleanly.

- [ ] **Step 3: Commit**

```bash
cd ~/Claude/Projects/loading-pipeline
git add backend/src/routes/admin.js
git commit -m "cash: add POST /invoices/:id/confirm-cash admin endpoint"
```

---

## Task 6: Frontend VendorForm — Cash option

**Files:**
- Modify: `frontend/src/pages/VendorForm.jsx`

- [ ] **Step 1: Add Cash to FEE_RATES, METHOD_CONFIG, and the allowlist constant**

At the top of `frontend/src/pages/VendorForm.jsx`, replace:

```js
const FEE_RATES = {
  'Credit/Debit': 0.03,
  ACH: 0.01,
  Wire: 0,
};

const METHOD_CONFIG = {
  'Credit/Debit': { min: 1000, max: 4500, step: 250 },
  ACH: { min: 1000, max: 9000, step: 250 },
  Wire: { min: 1000, max: 20000 },
};
```

With:

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

- [ ] **Step 2: Expose Cash-specific flags**

Inside the component body, find the line:

```js
  const isWire = method === 'Wire';
```

Replace with:

```js
  const isWire = method === 'Wire';
  const isCash = method === 'Cash';
  const isOffline = isWire || isCash;
  const cashAllowed = CASH_ALLOWED_SLUGS.includes(vendorSlug);
```

- [ ] **Step 3: Update dropdown options to include Cash for allowed vendors**

Find the `<select>` element for the payment method dropdown (it renders options for Credit/Debit, ACH, Wire). After the Wire option, add:

```jsx
                    {cashAllowed && <option value="Cash">Cash</option>}
```

- [ ] **Step 4: Update dropdown-options builder to handle Cash**

Find:
```js
  const dropdownOptions = useMemo(() => {
    if (!config || isWire) return [];
    return buildOptions(config.min, config.max, config.step);
  }, [method]);
```

Replace with:
```js
  const dropdownOptions = useMemo(() => {
    if (!config) return [];
    if (isWire) return [];
    return buildOptions(config.min, config.max, config.step);
  }, [method]);
```

(Cash uses the dropdown like Credit/Debit/ACH — it has min/max/step, not a freeform Wire input.)

- [ ] **Step 5: Hide the "Total w/ Fee" row for Cash**

Find the block that renders the fee-included total. It begins with something like:
```jsx
                {method && !isWire && base > 0 && (
```

Replace `!isWire` with `!isOffline`:
```jsx
                {method && !isOffline && base > 0 && (
```

(Wire already hid this; Cash should hide it too — total equals base when fee is 0.)

- [ ] **Step 6: Update the wireValid guard so it also covers Cash**

Find:
```js
  const wireValid =
    !isWire || (base >= (config?.min || 0) && base <= (config?.max || Infinity));
```

This only applies to Wire's freeform input — Cash uses the dropdown so options are pre-bounded. Leave this as-is — no change needed.

- [ ] **Step 7: Update submission payload (no receipt logic needed for Cash)**

Find:
```js
      if (isWire && wireReceipt) {
        const formData = new FormData();
        formData.append('data', JSON.stringify(payload));
        formData.append('wireReceipt', wireReceipt);
        await axios.post('/api/submit-invoice', formData);
      } else {
        await axios.post('/api/submit-invoice', payload);
      }
```

No change needed — Cash falls into the else branch (JSON payload, no receipt).

- [ ] **Step 8: Add helper text for Cash under the dropdown**

Find the `<HelpText>Choose your payment method.</HelpText>` line. Below it (still inside the method-picker `<div>`), add:

```jsx
                  {isCash && (
                    <p className="text-xs text-gray-500 mt-1">
                      No invoice will be sent. Pay cash in person — admin will mark paid to trigger the load.
                    </p>
                  )}
```

- [ ] **Step 9: Verify frontend builds**

Run: `cd ~/Claude/Projects/loading-pipeline/frontend && npm run build 2>&1 | tail -20`
Expected: build succeeds with no errors. Warnings are OK.

- [ ] **Step 10: Commit**

```bash
cd ~/Claude/Projects/loading-pipeline
git add frontend/src/pages/VendorForm.jsx
git commit -m "cash: add Cash payment method to vendor form (gated to alex/claudia)"
```

---

## Task 7: Frontend InvoiceCard + AdminDashboard — Mark Cash Received button

**Files:**
- Modify: `frontend/src/components/InvoiceCard.jsx`
- Modify: `frontend/src/pages/AdminDashboard.jsx`

- [ ] **Step 1: Add onConfirmCash prop + button to InvoiceCard**

In `frontend/src/components/InvoiceCard.jsx`, update the component signature to accept `onConfirmCash`:

Find:
```js
export default function InvoiceCard({ invoice, allocations, onConfirmWire, onTriggerLoad, onMarkLoaded, onResendEmail, onShowEvents, onDelete }) {
```

Replace with:
```js
export default function InvoiceCard({ invoice, allocations, onConfirmWire, onConfirmCash, onTriggerLoad, onMarkLoaded, onResendEmail, onShowEvents, onDelete }) {
```

- [ ] **Step 2: Branch the PENDING button on method**

Find:
```jsx
        {isPending && (
          <button
            onClick={() => onConfirmWire(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition"
          >
            Confirm Wire
          </button>
        )}
```

Replace with:
```jsx
        {isPending && invoice.method === 'Cash' && (
          <button
            onClick={() => onConfirmCash(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition"
          >
            Mark Cash Received
          </button>
        )}

        {isPending && invoice.method !== 'Cash' && (
          <button
            onClick={() => onConfirmWire(invoice.id)}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition"
          >
            Confirm Wire
          </button>
        )}
```

- [ ] **Step 3: Add handleConfirmCash in AdminDashboard**

In `frontend/src/pages/AdminDashboard.jsx`, find the existing `handleConfirmWire` (or similar function that calls `/confirm-wire`). Add a sibling `handleConfirmCash` right after it:

```js
  async function handleConfirmCash(invoiceId) {
    try {
      await axios.post(`/api/admin/invoices/${invoiceId}/confirm-cash`, {}, { headers: getAuthHeaders() });
      await loadData();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to confirm cash');
    }
  }
```

(Mirror whatever post-action behavior `handleConfirmWire` uses — typically a data reload.)

- [ ] **Step 4: Pass onConfirmCash into every InvoiceCard**

Find each `<InvoiceCard ... onConfirmWire={handleConfirmWire} .../>` usage in `AdminDashboard.jsx`. Add `onConfirmCash={handleConfirmCash}` to each:

```jsx
              <InvoiceCard
                invoice={inv}
                allocations={allocsByInvoice[inv.id] || []}
                onConfirmWire={handleConfirmWire}
                onConfirmCash={handleConfirmCash}
                // ... existing props unchanged
              />
```

- [ ] **Step 5: Verify frontend builds**

Run: `cd ~/Claude/Projects/loading-pipeline/frontend && npm run build 2>&1 | tail -20`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
cd ~/Claude/Projects/loading-pipeline
git add frontend/src/components/InvoiceCard.jsx frontend/src/pages/AdminDashboard.jsx
git commit -m "cash: add Mark Cash Received button to pipeline PENDING column"
```

---

## Task 8: Deploy + end-to-end smoke test

**Files:** none modified — deploy and verify.

- [ ] **Step 1: Push to origin**

```bash
cd ~/Claude/Projects/loading-pipeline
git push
```

- [ ] **Step 2: Deploy to Hetzner**

Run: `cd ~/Claude/Projects/loading-pipeline && ./deploy.sh 2>&1 | tail -30`
Expected: healthcheck passes, `creditloader` service restarts, frontend assets updated.

- [ ] **Step 3: Verify Cash appears in Alex's form**

Open `https://load.wokeavr.com/load/alex` in a browser. The Payment Method dropdown must list: Credit/Debit (3%), ACH (1%), Wire, **Cash**.

Open `https://load.wokeavr.com/load/claudia`. Same four options must appear.

Open any other vendor form (e.g. `https://load.wokeavr.com/load/lynette`). The dropdown must show only Credit/Debit, ACH, Wire — **no Cash**.

- [ ] **Step 4: Server-side allowlist verification**

Run the allowlist-bypass attempt directly against the API:

```bash
curl -s -X POST https://load.wokeavr.com/api/submit-invoice \
  -H 'Content-Type: application/json' \
  -d '{"vendorSlug":"lynette","method":"Cash","baseAmount":1000,"feeAmount":0,"totalAmount":1000,"allocations":[]}'
```

Expected response: `{"error":"Cash not enabled for this vendor"}` with HTTP 403.

- [ ] **Step 5: Smoke test — Cash submit + admin confirm (Claudia, $1 via DB-direct cleanup)**

Use Alex or Claudia's form to submit a **$1,000 Cash** invoice (smallest allowed). Allocate to one of their accounts. Submit.

In DB, verify the new invoice:
```bash
ssh root@87.99.135.197 'cd /root/WOKE-CreditLoader-Pipeline/backend && node -e "const p = require(\"./src/db/client\"); (async () => { const inv = await p.invoice.findFirst({ where: { method: \"Cash\" }, orderBy: { id: \"desc\" } }); console.log(JSON.stringify(inv, null, 2)); await p.\$disconnect(); })();"'
```
Expected: `method="Cash"`, `status="PENDING"`, `qbInvoiceId=null`, `feeAmount="0"`.

In admin dashboard pipeline, find the new Cash invoice in the PENDING column. Click **Mark Cash Received**.

Within ~30s, the invoice moves to PAID and the autoloader kicks. For a smoke test, the actual platform load can be allowed to run (it'll hit Play777/iConnect for real) or **skip by deleting the invoice via admin Delete** before it completes loading to avoid unwanted credit deposits.

- [ ] **Step 6: Update the vault note**

Append to `~/My Brain/Projects/creditloader.md` under the Status list:

```
- Cash payment method added (2026-04-18): allowlisted to alex + claudia. Status PENDING → admin clicks "Mark Cash Received" on pipeline → PAID → autoload. No QB invoice, fee=0. Allowlist in backend/src/constants/cash.js.
```

Bump frontmatter `last_verified`.

- [ ] **Step 7: Commit the note**

```bash
cd ~ && git add "My Brain/Projects/creditloader.md"
git commit -m "notebook: cash payment method shipped for alex+claudia"
```

---

## Self-review

- **Spec coverage**: every design section maps to a task —
  - Frontend method config + gating → Task 6
  - Backend forms.js handling + allowlist → Task 3
  - `confirm-cash` endpoint → Task 5
  - Telegram helper → Task 4
  - Pipeline UI button → Task 7
  - Defense-in-depth server allowlist → Task 3 + smoke test Task 8
  - No migration → confirmed, none needed
- **Placeholders**: none.
- **Type consistency**: `CASH_ALLOWED_SLUGS` name matches between `backend/src/constants/cash.js` and `frontend/src/pages/VendorForm.jsx`. `sendCashSubmitted(vendor, invoice, allocations)` signature matches the Wire version. `/confirm-cash` route matches admin + frontend handler.
- **Out of scope** per spec: delete-route drift fix not included — tracked separately.
