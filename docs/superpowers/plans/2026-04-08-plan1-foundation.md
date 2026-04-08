# Plan 1: Foundation — Logger, DB Models, Validation, Webhooks, Ops

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation layer that all subsequent hardening depends on — structured logging, new database models, server-side validation, reliable webhook processing, and deployment automation.

**Architecture:** Add a logger module used by all services, extend the Prisma schema with LoadEvent/LoadStep/WebhookEvent models, add validation middleware to form routes, replace fire-and-forget webhook processing with a persistent queue, and create a deploy script + scheduled health digest.

**Tech Stack:** Node.js, Express, Prisma (PostgreSQL), Jest, node-telegram-bot-api

**Spec:** `docs/superpowers/specs/2026-04-08-pipeline-hardening-design.md` (Sections 3, 4.1-4.3, 4.5, 5, 8)

---

## File Structure

### New Files
- `backend/src/services/logger.js` — Structured JSON logger with CDT timestamps and per-invoice file logging
- `backend/src/services/validator.js` — Server-side invoice/correction validation functions
- `backend/src/services/webhookProcessor.js` — Background webhook queue processor
- `backend/src/services/healthDigest.js` — Daily health digest via Telegram
- `backend/src/db/prisma/migrations/20260408_add_hardening_models/migration.sql` — New tables
- `backend/__tests__/validator.test.js` — Unit tests for validation
- `backend/__tests__/logger.test.js` — Unit tests for logger
- `backend/__tests__/webhookProcessor.test.js` — Unit tests for webhook processor
- `deploy.sh` — One-command deploy script

### Modified Files
- `backend/src/db/prisma/schema.prisma` — Add LoadEvent, LoadStep, WebhookEvent models
- `backend/src/routes/forms.js` — Add server-side validation before invoice/correction creation
- `backend/src/routes/webhooks.js` — Save to WebhookEvent queue instead of processing inline
- `backend/src/routes/admin.js` — Add LoadEvent query endpoint
- `backend/src/index.js` — Start webhook processor, health digest scheduler, stale load detection
- `backend/src/services/autoloader.js` — Emit LoadEvents at each step
- `backend/src/services/telegram.js` — Add vendor status notifications, health digest message
- `backend/package.json` — Add jest devDependency

---

### Task 1: Structured Logger

**Files:**
- Create: `backend/src/services/logger.js`
- Create: `backend/__tests__/logger.test.js`

- [ ] **Step 1: Write the failing test**

```js
// backend/__tests__/logger.test.js
const { createLogger } = require('../src/services/logger');

describe('logger', () => {
  let output;
  let logger;

  beforeEach(() => {
    output = [];
    logger = createLogger({ write: (line) => output.push(JSON.parse(line)) });
  });

  test('outputs JSON with CDT timestamp', () => {
    logger.info('test message');
    expect(output).toHaveLength(1);
    expect(output[0].message).toBe('test message');
    expect(output[0].level).toBe('info');
    expect(output[0].timestamp).toMatch(/T\d{2}:\d{2}:\d{2}-05:00$/);
  });

  test('includes context fields', () => {
    logger.info('loading', { invoiceId: 40, platform: 'PLAY777' });
    expect(output[0].context.invoiceId).toBe(40);
    expect(output[0].context.platform).toBe('PLAY777');
  });

  test('error level includes stack', () => {
    const err = new Error('boom');
    logger.error('failed', { error: err });
    expect(output[0].level).toBe('error');
    expect(output[0].context.error).toContain('boom');
  });

  test('child logger inherits context', () => {
    const child = logger.child({ invoiceId: 42 });
    child.info('step done', { step: 'LOGIN' });
    expect(output[0].context.invoiceId).toBe(42);
    expect(output[0].context.step).toBe('LOGIN');
  });
});
```

- [ ] **Step 2: Install jest and run test to verify it fails**

```bash
cd backend && npm install --save-dev jest && npx jest __tests__/logger.test.js --no-cache
```

Expected: FAIL with "Cannot find module '../src/services/logger'"

- [ ] **Step 3: Write the logger implementation**

```js
// backend/src/services/logger.js
const fs = require('fs');
const path = require('path');

function cdtTimestamp() {
  const now = new Date();
  const cdt = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const iso = cdt.toISOString().replace('Z', '-05:00');
  return iso;
}

function createLogger(stream = process.stdout) {
  const baseContext = {};

  function log(level, message, context = {}) {
    const merged = { ...baseContext, ...context };
    if (merged.error instanceof Error) {
      merged.error = `${merged.error.message}\n${merged.error.stack}`;
    }
    const entry = {
      timestamp: cdtTimestamp(),
      level,
      message,
      context: Object.keys(merged).length > 0 ? merged : undefined,
    };
    const line = JSON.stringify(entry) + '\n';
    if (stream.write) {
      stream.write(line);
    }
  }

  return {
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
    debug: (msg, ctx) => log('debug', msg, ctx),
    child: (parentCtx) => {
      const childStream = stream;
      const childLogger = createLogger(childStream);
      const origInfo = childLogger.info;
      const origWarn = childLogger.warn;
      const origError = childLogger.error;
      const origDebug = childLogger.debug;
      childLogger.info = (msg, ctx = {}) => log('info', msg, { ...parentCtx, ...ctx });
      childLogger.warn = (msg, ctx = {}) => log('warn', msg, { ...parentCtx, ...ctx });
      childLogger.error = (msg, ctx = {}) => log('error', msg, { ...parentCtx, ...ctx });
      childLogger.debug = (msg, ctx = {}) => log('debug', msg, { ...parentCtx, ...ctx });
      childLogger.child = (extraCtx) => createLogger(childStream).child({ ...parentCtx, ...extraCtx });
      // Hack: re-bind child's child method properly
      const result = { ...childLogger };
      result.child = (extraCtx) => {
        const combined = { ...parentCtx, ...extraCtx };
        return createLogger(stream).child(combined);
      };
      return result;
    },
  };
}

// File logger — creates per-invoice log files
function createFileLogger(invoiceId) {
  const logDir = '/var/log/creditloader/loads';
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(logDir, `invoice-${invoiceId}-${ts}.log`);
  const fileStream = fs.createWriteStream(logPath, { flags: 'a' });
  return { logger: createLogger(fileStream), logPath, close: () => fileStream.end() };
}

// Default singleton logger (stdout)
const logger = createLogger();

module.exports = { logger, createLogger, createFileLogger };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npx jest __tests__/logger.test.js --no-cache
```

Expected: 4 tests PASS

- [ ] **Step 5: Add jest config to package.json**

Add to `backend/package.json`:
```json
"scripts": {
  "test": "jest --no-cache"
}
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/logger.js backend/__tests__/logger.test.js backend/package.json backend/package-lock.json
git commit -m "feat: add structured JSON logger with CDT timestamps and child contexts"
```

---

### Task 2: Database Schema — New Models

**Files:**
- Modify: `backend/src/db/prisma/schema.prisma`
- Create: `backend/src/db/prisma/migrations/20260408120000_add_hardening_models/migration.sql`

- [ ] **Step 1: Add LoadEvent, LoadStep, WebhookEvent to schema.prisma**

Append after the existing `Setting` model in `backend/src/db/prisma/schema.prisma`:

```prisma
model LoadStep {
  id             Int      @id @default(autoincrement())
  loadJobId      Int      @map("load_job_id")
  step           String   // VENDOR_DEPOSIT, OPERATOR_CHAIN, CORRECTION_DEDUCT, CORRECTION_DEPOSIT
  accountId      Int      @map("account_id")
  credits        Int
  status         String   @default("PENDING") // PENDING, SUCCESS, FAILED, VERIFIED, UNVERIFIED
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
  step           String   // BROWSER_LAUNCHED, LOGIN_OK, NAVIGATED_VENDORS, FOUND_ROW, OPENED_MODAL, ENTERED_CREDITS, SUBMITTED, VERIFIED
  status         String   // SUCCESS, FAILED, INFO
  metadata       Json?
  screenshotPath String?  @map("screenshot_path")
  createdAt      DateTime @default(now()) @map("created_at")

  loadJob LoadJob @relation(fields: [loadJobId], references: [id])

  @@index([loadJobId])
  @@map("load_events")
}

model WebhookEvent {
  id          Int       @id @default(autoincrement())
  source      String    // "quickbooks"
  eventType   String    @map("event_type") // "payment"
  payload     Json
  status      String    @default("RECEIVED") // RECEIVED, PROCESSING, PROCESSED, FAILED
  error       String?
  attempts    Int       @default(0)
  receivedAt  DateTime  @default(now()) @map("received_at")
  processedAt DateTime? @map("processed_at")

  @@index([status])
  @@map("webhook_events")
}
```

Also add reverse relations to `LoadJob` and `VendorAccount`:

In the `LoadJob` model, add:
```prisma
  loadSteps  LoadStep[]
  loadEvents LoadEvent[]
```

In the `VendorAccount` model, add:
```prisma
  loadSteps LoadStep[]
```

- [ ] **Step 2: Create the migration SQL file**

Create `backend/src/db/prisma/migrations/20260408120000_add_hardening_models/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "load_steps" (
    "id" SERIAL NOT NULL,
    "load_job_id" INTEGER NOT NULL,
    "step" TEXT NOT NULL,
    "account_id" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "balance_before" INTEGER,
    "balance_after" INTEGER,
    "screenshot_path" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_events" (
    "id" SERIAL NOT NULL,
    "load_job_id" INTEGER NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "metadata" JSONB,
    "screenshot_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "load_steps_load_job_id_idx" ON "load_steps"("load_job_id");

-- CreateIndex
CREATE INDEX "load_events_load_job_id_idx" ON "load_events"("load_job_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- AddForeignKey
ALTER TABLE "load_steps" ADD CONSTRAINT "load_steps_load_job_id_fkey" FOREIGN KEY ("load_job_id") REFERENCES "load_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_steps" ADD CONSTRAINT "load_steps_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "vendor_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_events" ADD CONSTRAINT "load_events_load_job_id_fkey" FOREIGN KEY ("load_job_id") REFERENCES "load_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 3: Run migration and generate client**

```bash
cd backend && npx prisma migrate deploy --schema src/db/prisma/schema.prisma && npx prisma generate --schema src/db/prisma/schema.prisma
```

Expected: Migration applied, client generated

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/prisma/schema.prisma backend/src/db/prisma/migrations/20260408120000_add_hardening_models/
git commit -m "feat: add LoadStep, LoadEvent, WebhookEvent database models"
```

---

### Task 3: Server-Side Validation

**Files:**
- Create: `backend/src/services/validator.js`
- Create: `backend/__tests__/validator.test.js`
- Modify: `backend/src/routes/forms.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/__tests__/validator.test.js
const { validateInvoice, validateCorrection } = require('../src/services/validator');

describe('validateInvoice', () => {
  const makeVendor = () => ({
    id: 1,
    accounts: [
      { id: 10, platform: 'PLAY777', rate: '0.35', loadType: 'vendor' },
      { id: 11, platform: 'ICONNECT', rate: '0.15', loadType: 'vendor' },
      { id: 12, platform: 'PLAY777', rate: '0.35', loadType: 'correction' },
    ],
  });

  test('valid invoice passes', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'ACH (1%)',
      baseAmount: 1000,
      feeAmount: 10,
      totalAmount: 1010,
      allocations: [
        { accountId: 10, dollarAmount: 700, credits: 2000 },
        { accountId: 11, dollarAmount: 300, credits: 2000 },
      ],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects when allocation sum != baseAmount', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'ACH (1%)',
      baseAmount: 1000,
      feeAmount: 10,
      totalAmount: 1010,
      allocations: [
        { accountId: 10, dollarAmount: 500, credits: 1428 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/allocation.*sum/i);
  });

  test('rejects Card/ACH below $1000 minimum', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Credit/Debit (3%)',
      baseAmount: 500,
      feeAmount: 15,
      totalAmount: 515,
      allocations: [
        { accountId: 10, dollarAmount: 500, credits: 1428 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/minimum/i);
  });

  test('rejects negative amounts', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [
        { accountId: 10, dollarAmount: -500, credits: 1428 },
        { accountId: 11, dollarAmount: 1500, credits: 10000 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/negative/i);
  });

  test('rejects account not belonging to vendor', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [
        { accountId: 999, dollarAmount: 1000, credits: 2857 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not belong/i);
  });

  test('rejects correction account in invoice submission', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [
        { accountId: 12, dollarAmount: 1000, credits: 2857 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/correction account/i);
  });

  test('rejects credits mismatch beyond tolerance', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [
        { accountId: 10, dollarAmount: 1000, credits: 9999 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/credits.*mismatch/i);
  });

  test('wire allows below $1000', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 500,
      feeAmount: 0,
      totalAmount: 500,
      allocations: [
        { accountId: 10, dollarAmount: 500, credits: 1428 },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateCorrection', () => {
  const makeVendor = () => ({
    id: 1,
    accounts: [
      { id: 10, platform: 'PLAY777', rate: '0.35', loadType: 'vendor' },
      { id: 12, platform: 'PLAY777', rate: '0.35', loadType: 'correction' },
    ],
  });

  test('valid correction passes', () => {
    const result = validateCorrection({
      vendor: makeVendor(),
      sourceAccountId: 10,
      corrections: [{ accountId: 12, credits: 100 }],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects non-correction target account', () => {
    const result = validateCorrection({
      vendor: makeVendor(),
      sourceAccountId: 10,
      corrections: [{ accountId: 10, credits: 100 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/correction account/i);
  });

  test('rejects zero credits', () => {
    const result = validateCorrection({
      vendor: makeVendor(),
      sourceAccountId: 10,
      corrections: [{ accountId: 12, credits: 0 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no credits/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest __tests__/validator.test.js --no-cache
```

Expected: FAIL with "Cannot find module '../src/services/validator'"

- [ ] **Step 3: Write the validator implementation**

```js
// backend/src/services/validator.js

function validateInvoice({ vendor, method, baseAmount, feeAmount, totalAmount, allocations }) {
  // Amount validation
  if (baseAmount <= 0) return { valid: false, error: 'Base amount must be positive' };

  // $1000 minimum for Card/ACH
  if (method !== 'Wire' && baseAmount < 1000) {
    return { valid: false, error: `$1,000 minimum required for ${method}` };
  }

  // Check for negative amounts
  for (const a of allocations) {
    if (a.dollarAmount < 0) {
      return { valid: false, error: 'Negative dollar amounts not allowed' };
    }
  }

  // Allocation sum must match baseAmount
  const allocSum = allocations.reduce((s, a) => s + Number(a.dollarAmount), 0);
  if (Math.abs(allocSum - Number(baseAmount)) > 0.01) {
    return { valid: false, error: `Allocation sum ($${allocSum.toFixed(2)}) does not match base amount ($${Number(baseAmount).toFixed(2)})` };
  }

  // Account ownership and type checks
  const vendorAccountIds = new Set(vendor.accounts.map((a) => a.id));
  const accountMap = Object.fromEntries(vendor.accounts.map((a) => [a.id, a]));

  for (const a of allocations) {
    if (!vendorAccountIds.has(a.accountId)) {
      return { valid: false, error: `Account ${a.accountId} does not belong to this vendor` };
    }
    const acct = accountMap[a.accountId];
    if (acct.loadType === 'correction') {
      return { valid: false, error: `Cannot use correction account ${acct.username} in invoice submission` };
    }
  }

  // Credit recalculation
  for (const a of allocations) {
    if (a.dollarAmount <= 0) continue;
    const acct = accountMap[a.accountId];
    const expectedCredits = Math.floor(Number(a.dollarAmount) / Number(acct.rate));
    if (Math.abs(expectedCredits - a.credits) > 1) {
      return {
        valid: false,
        error: `Credits mismatch for ${acct.username}: expected ~${expectedCredits}, got ${a.credits}`,
      };
    }
  }

  return { valid: true };
}

function validateCorrection({ vendor, sourceAccountId, corrections }) {
  // Source account must exist and belong to vendor
  const source = vendor.accounts.find((a) => a.id === sourceAccountId);
  if (!source) {
    return { valid: false, error: 'Source account does not belong to this vendor' };
  }

  // Total credits must be positive
  const totalCredits = corrections.reduce((s, c) => s + (c.credits || 0), 0);
  if (totalCredits <= 0) {
    return { valid: false, error: 'No credits to correct' };
  }

  // Target accounts must be correction type and belong to vendor
  const vendorAccountIds = new Set(vendor.accounts.map((a) => a.id));
  const accountMap = Object.fromEntries(vendor.accounts.map((a) => [a.id, a]));

  for (const c of corrections) {
    if (c.credits <= 0) continue;
    if (!vendorAccountIds.has(c.accountId)) {
      return { valid: false, error: `Account ${c.accountId} does not belong to this vendor` };
    }
    const acct = accountMap[c.accountId];
    if (acct.loadType !== 'correction') {
      return { valid: false, error: `Account ${acct.username} is not a correction account` };
    }
  }

  return { valid: true };
}

module.exports = { validateInvoice, validateCorrection };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npx jest __tests__/validator.test.js --no-cache
```

Expected: 10 tests PASS

- [ ] **Step 5: Integrate validator into forms.js**

In `backend/src/routes/forms.js`, add at the top:
```js
const { validateInvoice, validateCorrection } = require('../services/validator');
```

In the `submit-invoice` route, after fetching the vendor and before creating the invoice, add:
```js
    const validation = validateInvoice({
      vendor,
      method: methodLabel,
      baseAmount: Number(baseAmount),
      feeAmount: Number(feeAmount),
      totalAmount: Number(totalAmount),
      allocations: allocations.map((a) => ({
        accountId: a.accountId,
        dollarAmount: Number(a.dollarAmount),
        credits: a.credits,
      })),
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
```

In the `submit-correction` route, after fetching the vendor and source account, replace the existing totalCredits check with:
```js
    const validation = validateCorrection({
      vendor,
      sourceAccountId,
      corrections,
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    const totalCredits = corrections.reduce((sum, c) => sum + c.credits, 0);
```

- [ ] **Step 6: Run all tests**

```bash
cd backend && npx jest --no-cache
```

Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/validator.js backend/__tests__/validator.test.js backend/src/routes/forms.js
git commit -m "feat: add server-side invoice and correction validation"
```

---

### Task 4: Persistent Webhook Queue

**Files:**
- Create: `backend/src/services/webhookProcessor.js`
- Create: `backend/__tests__/webhookProcessor.test.js`
- Modify: `backend/src/routes/webhooks.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/__tests__/webhookProcessor.test.js
const { processWebhookEvent } = require('../src/services/webhookProcessor');

// Mock prisma
jest.mock('../src/db/client', () => {
  const events = [];
  return {
    webhookEvent: {
      create: jest.fn((args) => {
        const evt = { id: events.length + 1, ...args.data, attempts: 0 };
        events.push(evt);
        return evt;
      }),
      findMany: jest.fn(() => events.filter((e) => e.status === 'RECEIVED')),
      update: jest.fn((args) => {
        const evt = events.find((e) => e.id === args.where.id);
        Object.assign(evt, args.data);
        return evt;
      }),
    },
    processedWebhook: {
      findUnique: jest.fn(() => null),
      create: jest.fn(),
    },
    invoice: {
      findFirst: jest.fn(() => null),
      update: jest.fn(),
    },
    _events: events,
    _reset: () => { events.length = 0; },
  };
});

describe('processWebhookEvent', () => {
  const prisma = require('../src/db/client');

  beforeEach(() => prisma._reset());

  test('marks event PROCESSED on success', async () => {
    const event = {
      id: 1,
      source: 'quickbooks',
      eventType: 'payment',
      payload: { eventNotifications: [] },
      status: 'RECEIVED',
      attempts: 0,
    };
    await processWebhookEvent(event);
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ status: 'PROCESSED' }),
      })
    );
  });

  test('marks event FAILED after max attempts', async () => {
    const event = {
      id: 2,
      source: 'quickbooks',
      eventType: 'payment',
      payload: { eventNotifications: [{ dataChangeEvent: { entities: [{ name: 'Payment', id: '999' }] } }] },
      status: 'RECEIVED',
      attempts: 2,
    };
    // Mock getPayment to throw
    jest.spyOn(require('../src/services/quickbooks'), 'getPayment').mockRejectedValue(new Error('QB down'));
    await processWebhookEvent(event);
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 2 },
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npx jest __tests__/webhookProcessor.test.js --no-cache
```

Expected: FAIL with "Cannot find module '../src/services/webhookProcessor'"

- [ ] **Step 3: Write the webhook processor**

```js
// backend/src/services/webhookProcessor.js
const prisma = require('../db/client');
const quickbooks = require('./quickbooks');
const autoloader = require('./autoloader');
const telegram = require('./telegram');
const { logger } = require('./logger');

const MAX_ATTEMPTS = 3;

async function processWebhookEvent(event) {
  const log = logger.child({ webhookEventId: event.id, source: event.source });

  try {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', attempts: event.attempts + 1 },
    });

    const payload = event.payload;
    const notifications = payload?.eventNotifications || [];

    for (const notification of notifications) {
      const entities = notification?.dataChangeEvent?.entities || [];
      for (const entity of entities) {
        if (entity.name === 'Payment') {
          await handlePayment(entity.id, log);
        }
      }
    }

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    log.info('Webhook event processed');
  } catch (err) {
    log.error('Webhook processing failed', { error: err });
    const newAttempts = event.attempts + 1;
    const status = newAttempts >= MAX_ATTEMPTS ? 'FAILED' : 'RECEIVED';

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status, error: err.message, attempts: newAttempts },
    });

    if (status === 'FAILED') {
      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `🚨 Webhook processing FAILED after ${MAX_ATTEMPTS} attempts\n\nEvent #${event.id}\nSource: ${event.source}\nError: ${err.message}`
        );
      } catch {}
    }
  }
}

async function handlePayment(paymentId, log) {
  log.info('Processing payment', { paymentId });

  const existing = await prisma.processedWebhook.findUnique({
    where: { paymentId: String(paymentId) },
  });
  if (existing) {
    log.info('Payment already processed — skipping', { paymentId });
    return;
  }

  let payment;
  try {
    payment = await quickbooks.getPayment(paymentId);
  } catch (err) {
    log.error('Failed to fetch payment from QB', { paymentId, error: err });
    throw err;
  }

  const invoiceRefs = (payment.Line || [])
    .filter((line) => line.LinkedTxn)
    .flatMap((line) => line.LinkedTxn)
    .filter((txn) => txn.TxnType === 'Invoice')
    .map((txn) => txn.TxnId);

  if (invoiceRefs.length === 0) {
    log.info('Payment has no linked invoices', { paymentId });
    return;
  }

  for (const qbInvoiceId of invoiceRefs) {
    let invoice = await prisma.invoice.findFirst({
      where: {
        OR: [
          { qbInvoiceId: qbInvoiceId },
          { qbInvoiceId: String(qbInvoiceId) },
        ],
      },
      include: { vendor: true },
    });

    if (!invoice) {
      try {
        const qbInvoice = await quickbooks.getInvoice(qbInvoiceId);
        const docNumber = qbInvoice?.DocNumber;
        if (docNumber) {
          invoice = await prisma.invoice.findFirst({
            where: { qbInvoiceId: docNumber },
            include: { vendor: true },
          });
        }
      } catch (err) {
        log.error('Failed to resolve QB invoice', { qbInvoiceId, error: err });
      }
    }

    if (!invoice) {
      log.warn('No matching local invoice for QB ID', { qbInvoiceId });
      continue;
    }

    if (invoice.status !== 'REQUESTED') {
      log.info('Invoice not in REQUESTED status — skipping', { invoiceId: invoice.id, status: invoice.status });
      continue;
    }

    await prisma.processedWebhook.create({
      data: { paymentId: String(paymentId), invoiceId: invoice.id },
    }).catch(() => {});

    log.info('Marking invoice PAID and triggering load', { invoiceId: invoice.id, vendorName: invoice.vendor.name });

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    autoloader.processInvoice(invoice.id).catch(async (err) => {
      log.error('Auto-loader failed', { invoiceId: invoice.id, error: err });
      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `🚨 AUTO-LOAD FAILED 🚨\n\nInvoice #${invoice.id}\nVendor: ${invoice.vendor.name}\nPayment ID: ${paymentId}\nError: ${err.message}\n\nUse the admin dashboard to retry.`
        );
      } catch {}
    });
  }
}

// Background processor — picks up RECEIVED events
async function startWebhookProcessor() {
  const log = logger.child({ service: 'webhookProcessor' });

  // Process any unfinished events on startup
  const pending = await prisma.webhookEvent.findMany({
    where: { status: { in: ['RECEIVED', 'PROCESSING'] } },
    orderBy: { receivedAt: 'asc' },
  });
  if (pending.length > 0) {
    log.info(`Found ${pending.length} unprocessed webhook events on startup`);
    for (const event of pending) {
      await processWebhookEvent(event);
    }
  }

  // Poll every 5 seconds for new RECEIVED events
  setInterval(async () => {
    try {
      const events = await prisma.webhookEvent.findMany({
        where: { status: 'RECEIVED' },
        orderBy: { receivedAt: 'asc' },
        take: 10,
      });
      for (const event of events) {
        await processWebhookEvent(event);
      }
    } catch (err) {
      log.error('Webhook processor poll failed', { error: err });
    }
  }, 5000);
}

module.exports = { processWebhookEvent, startWebhookProcessor, handlePayment };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npx jest __tests__/webhookProcessor.test.js --no-cache
```

Expected: 2 tests PASS

- [ ] **Step 5: Update webhooks.js to save to queue instead of processing inline**

Replace `backend/src/routes/webhooks.js` webhook handler body (keep the signature verification):

```js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../db/client');
const { logger } = require('../services/logger');

const log = logger.child({ service: 'webhooks' });

function verifySignature(payload, signature) {
  const webhookToken = process.env.QB_WEBHOOK_TOKEN;
  if (!webhookToken) {
    log.warn('QB_WEBHOOK_TOKEN not set — rejecting webhook');
    return false;
  }

  const hash = crypto
    .createHmac('sha256', webhookToken)
    .update(payload)
    .digest('base64');

  return hash === signature;
}

router.post('/qb-webhook', async (req, res) => {
  const signature = req.headers['intuit-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature)) {
    log.error('QB webhook: invalid or missing signature');
    return res.status(401).send('Invalid signature');
  }

  // Save to persistent queue and respond immediately
  try {
    await prisma.webhookEvent.create({
      data: {
        source: 'quickbooks',
        eventType: 'payment',
        payload: req.body,
        status: 'RECEIVED',
      },
    });
    log.info('QB webhook queued for processing');
  } catch (err) {
    log.error('Failed to queue webhook event', { error: err });
  }

  res.status(200).send('OK');
});

module.exports = router;
```

- [ ] **Step 6: Start webhook processor in index.js**

In `backend/src/index.js`, add import:
```js
const { startWebhookProcessor } = require('./services/webhookProcessor');
```

In the `app.listen` callback, add:
```js
  startWebhookProcessor();
```

- [ ] **Step 7: Run all tests**

```bash
cd backend && npx jest --no-cache
```

Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/webhookProcessor.js backend/__tests__/webhookProcessor.test.js backend/src/routes/webhooks.js backend/src/index.js
git commit -m "feat: persistent webhook queue with background processor and retry"
```

---

### Task 5: LoadEvent Emission in Autoloader

**Files:**
- Modify: `backend/src/services/autoloader.js`

- [ ] **Step 1: Add event emission helper**

At the top of `backend/src/services/autoloader.js`, add:
```js
const { logger, createFileLogger } = require('./logger');

async function emitEvent(loadJobId, step, status, metadata = null, screenshotPath = null) {
  try {
    await prisma.loadEvent.create({
      data: { loadJobId, step, status, metadata, screenshotPath },
    });
  } catch (err) {
    logger.error('Failed to emit LoadEvent', { loadJobId, step, error: err });
  }
}
```

- [ ] **Step 2: Add events throughout processInvoice**

Add `emitEvent` calls at key points in the existing `processInvoice` function:

After `await prisma.invoice.update({ ... data: { status: 'LOADING' } })`:
```js
  // Emit events for all pending jobs
  for (const job of pendingJobs) {
    await emitEvent(job.id, 'LOAD_STARTED', 'INFO', { invoiceId, creditsAmount: job.creditsAmount });
  }
```

In the correction flow, after Step 1 completes successfully:
```js
    await emitEvent(pendingJobs[0].id, 'CORRECTION_DEDUCT_OK', 'SUCCESS', {
      sourceAccount: source.username,
      credits: totalCorrectionCredits,
    });
```

If deduct fails:
```js
    await emitEvent(pendingJobs[0].id, 'CORRECTION_DEDUCT_FAILED', 'FAILED', {
      sourceAccount: source.username,
      credits: totalCorrectionCredits,
      error: deductResult.error,
    });
```

In `executeLoad`, after the result is determined:
```js
  await emitEvent(job.id, result.success ? 'LOAD_OK' : 'LOAD_FAILED', result.success ? 'SUCCESS' : 'FAILED', {
    platform,
    account: account.username,
    credits,
    error: result.error || null,
  });
```

When invoice is marked LOADED:
```js
  for (const job of pendingJobs) {
    await emitEvent(job.id, 'INVOICE_LOADED', 'SUCCESS', { invoiceId });
  }
```

When invoice is marked FAILED after max retries:
```js
  for (const job of pendingJobs) {
    await emitEvent(job.id, 'INVOICE_FAILED', 'FAILED', { invoiceId, totalAttempts: MAX_RETRIES });
  }
```

- [ ] **Step 3: Replace console.log/error with logger**

Replace all `console.log` and `console.error` in `autoloader.js` with `logger.info` and `logger.error`, adding context objects where appropriate.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/autoloader.js
git commit -m "feat: emit LoadEvents at each step of autoloader processing"
```

---

### Task 6: Admin API — LoadEvent Endpoint

**Files:**
- Modify: `backend/src/routes/admin.js`

- [ ] **Step 1: Add endpoint to fetch events for an invoice**

Add to `backend/src/routes/admin.js`, after the existing corrections route:

```js
// Load events for an invoice (timeline view)
router.get('/invoices/:id/events', async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);

    const loadJobs = await prisma.loadJob.findMany({
      where: { invoiceId },
      select: { id: true },
    });
    const jobIds = loadJobs.map((j) => j.id);

    const events = await prisma.loadEvent.findMany({
      where: { loadJobId: { in: jobIds } },
      orderBy: { createdAt: 'asc' },
      include: {
        loadJob: {
          select: {
            vendorAccount: {
              select: { username: true, platform: true },
            },
          },
        },
      },
    });

    const formatted = events.map((e) => ({
      id: e.id,
      step: e.step,
      status: e.status,
      metadata: e.metadata,
      screenshotPath: e.screenshotPath,
      account: e.loadJob?.vendorAccount?.username,
      platform: e.loadJob?.vendorAccount?.platform,
      createdAt: e.createdAt,
    }));

    res.json(formatted);
  } catch (err) {
    logger.error('Get events error', { error: err });
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});
```

Add logger import at top of admin.js:
```js
const { logger } = require('../services/logger');
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/routes/admin.js
git commit -m "feat: add admin endpoint for invoice load event timeline"
```

---

### Task 7: Health Digest & Stale Load Detection

**Files:**
- Create: `backend/src/services/healthDigest.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Write the health digest service**

```js
// backend/src/services/healthDigest.js
const prisma = require('../db/client');
const telegram = require('./telegram');
const { logger } = require('./logger');

const log = logger.child({ service: 'healthDigest' });
const ADSPOWER_API = process.env.ADSPOWER_API_URL || 'http://127.0.0.1:50325';
const ADSPOWER_TOKEN = process.env.ADSPOWER_API_KEY;

async function sendDailyDigest() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Invoices processed in last 24h
    const loaded = await prisma.invoice.count({ where: { status: 'LOADED', loadedAt: { gte: since } } });
    const failed = await prisma.invoice.count({ where: { status: 'FAILED', submittedAt: { gte: since } } });

    // Stuck invoices
    const stuckLoading = await prisma.invoice.count({ where: { status: 'LOADING' } });
    const stuckRequested = await prisma.invoice.count({ where: { status: 'REQUESTED' } });

    // AdsPower status
    let adspowerOk = false;
    try {
      const res = await fetch(`${ADSPOWER_API}/api/v1/user/list?page_size=1`, {
        headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      adspowerOk = data.code === 0;
    } catch {}

    // Failed webhooks
    const failedWebhooks = await prisma.webhookEvent.count({ where: { status: 'FAILED' } });

    const msg = `📊 Daily Health Digest

Invoices (24h):
✅ Loaded: ${loaded}
❌ Failed: ${failed}

Stuck:
⏳ LOADING: ${stuckLoading}
📋 REQUESTED: ${stuckRequested}

Infrastructure:
${adspowerOk ? '✅' : '❌'} AdsPower API
${failedWebhooks > 0 ? `⚠️ ${failedWebhooks} failed webhooks` : '✅ Webhooks OK'}

⏰ ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}`;

    await telegram.bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
    log.info('Daily digest sent');

    // QB Payment Reconciliation
    await reconcileQBPayments(since);
  } catch (err) {
    log.error('Daily digest failed', { error: err });
  }
}

async function reconcileQBPayments(since) {
  try {
    const quickbooks = require('./quickbooks');
    const sinceStr = since.toISOString().split('T')[0];
    const data = await quickbooks.qbRequest(
      'GET',
      `query?query=SELECT * FROM Payment WHERE TxnDate >= '${sinceStr}'`
    );
    const payments = data.QueryResponse?.Payment || [];

    for (const payment of payments) {
      const paymentId = String(payment.Id);
      const processed = await prisma.processedWebhook.findUnique({
        where: { paymentId },
      });
      if (!processed) {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ Unprocessed QB Payment\n\nPayment ID: ${paymentId}\nAmount: $${payment.TotalAmt}\nDate: ${payment.TxnDate}\n\nThis payment was not processed via webhook. Manual review needed.`
        );
        log.warn('Unprocessed QB payment found', { paymentId, amount: payment.TotalAmt });
      }
    }
  } catch (err) {
    log.error('QB reconciliation failed', { error: err });
  }
}

async function checkStaleLoads() {
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stale = await prisma.invoice.findMany({
      where: { status: 'LOADING', submittedAt: { lt: tenMinAgo } },
      include: { vendor: true },
    });

    for (const inv of stale) {
      const mins = Math.floor((Date.now() - new Date(inv.submittedAt).getTime()) / 60000);
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ Stale Load Detected\n\nInvoice #${inv.id} (${inv.vendor.name}) has been LOADING for ${mins} minutes. Possible hung process.`
      );
      log.warn('Stale load detected', { invoiceId: inv.id, minutes: mins });
    }
  } catch (err) {
    log.error('Stale load check failed', { error: err });
  }
}

function startHealthChecks() {
  // Daily digest at 8:00 AM CDT (13:00 UTC)
  const scheduleDigest = () => {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(13, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target.getTime() - now.getTime();
    setTimeout(() => {
      sendDailyDigest();
      setInterval(sendDailyDigest, 24 * 60 * 60 * 1000);
    }, delay);
    log.info(`Daily digest scheduled in ${Math.round(delay / 60000)} minutes`);
  };

  scheduleDigest();

  // Stale load check every 2 minutes
  setInterval(checkStaleLoads, 2 * 60 * 1000);
}

module.exports = { sendDailyDigest, checkStaleLoads, startHealthChecks };
```

- [ ] **Step 2: Export qbRequest from quickbooks.js**

In `backend/src/services/quickbooks.js`, add `qbRequest` to the exports:
```js
module.exports = {
  findCustomer,
  createInvoice,
  sendInvoiceEmail,
  getInvoice,
  getPayment,
  qbRequest,
};
```

- [ ] **Step 3: Wire into index.js**

In `backend/src/index.js`, add import:
```js
const { startHealthChecks } = require('./services/healthDigest');
```

In the `app.listen` callback, add:
```js
  startHealthChecks();
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/healthDigest.js backend/src/index.js
git commit -m "feat: add daily health digest and stale load detection"
```

---

### Task 8: Vendor Status Notifications

**Files:**
- Modify: `backend/src/services/telegram.js`
- Modify: `backend/src/routes/webhooks.js` (via webhookProcessor)
- Modify: `backend/src/routes/admin.js`

- [ ] **Step 1: Add vendor notification functions to telegram.js**

Add to `backend/src/services/telegram.js`:

```js
async function sendVendorPaid(vendor, invoice) {
  if (!vendor.telegramChatId) return;
  await bot.sendMessage(
    vendor.telegramChatId,
    `💰 Payment Received\n\nYour payment of ${fmt(invoice.totalAmount)} has been received. Credits are being loaded.`
  );
}

async function sendVendorFailed(vendor, invoice) {
  if (!vendor.telegramChatId) return;
  await bot.sendMessage(
    vendor.telegramChatId,
    `⚠️ Loading Issue\n\nThere was an issue loading your credits for invoice #${invoice.id}. Our team has been notified and will resolve this shortly.`
  );
}
```

Update the exports:
```js
module.exports = {
  bot,
  sendWireSubmitted,
  sendInvoiceSent,
  sendLoaded,
  sendVendorPaid,
  sendVendorFailed,
};
```

- [ ] **Step 2: Call sendVendorPaid in webhookProcessor.js when marking PAID**

In `webhookProcessor.js`, after `await prisma.invoice.update(... status: 'PAID' ...)`:
```js
    try {
      await telegram.sendVendorPaid(
        { telegramChatId: invoice.vendor.telegramChatId },
        { totalAmount: invoice.totalAmount, id: invoice.id }
      );
    } catch {}
```

- [ ] **Step 3: Call sendVendorFailed in autoloader.js when marking FAILED**

In the autoloader's final FAILED block (after sending admin alert), add:
```js
      try {
        await telegram.sendVendorFailed(
          { telegramChatId: invoice.vendor.telegramChatId },
          { id: invoice.id }
        );
      } catch {}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/telegram.js backend/src/services/webhookProcessor.js backend/src/services/autoloader.js
git commit -m "feat: send vendor Telegram notifications on PAID and FAILED status"
```

---

### Task 9: Deploy Script & Wire Receipt Backup

**Files:**
- Create: `deploy.sh`
- Modify: `backend/src/routes/forms.js`

- [ ] **Step 1: Create deploy script**

```bash
#!/bin/bash
set -e

echo "🚀 Deploying CreditLoader Pipeline..."

sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 << 'EOF'
  set -e
  cd /root/WOKE-CreditLoader-Pipeline

  echo "📥 Pulling latest code..."
  git pull

  echo "📦 Installing backend dependencies..."
  cd backend
  npm install --production

  echo "🗃️ Running migrations..."
  npx prisma generate --schema src/db/prisma/schema.prisma
  npx prisma migrate deploy --schema src/db/prisma/schema.prisma

  echo "🎨 Building frontend..."
  cd ../frontend
  npm install
  npm run build
  cp -r dist/* ../backend/public/

  echo "🔄 Restarting service..."
  systemctl restart creditloader
  sleep 3

  if curl -sf http://localhost:3000/api/vendors/mike > /dev/null; then
    echo "✅ DEPLOY OK — service is healthy"
  else
    echo "❌ DEPLOY FAILED — health check failed"
    exit 1
  fi
EOF

echo "✅ Deployment complete"
```

Make executable: `chmod +x deploy.sh`

- [ ] **Step 2: Add wire receipt backup to forms.js**

In `backend/src/routes/forms.js`, after `console.log(\`Wire receipt saved: ${req.file.filename}\`);`, add:

```js
      // Backup wire receipt
      const backupDir = '/var/backups/creditloader/receipts';
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(req.file.path, path.join(backupDir, req.file.filename));
      } catch (backupErr) {
        console.error('Wire receipt backup failed:', backupErr.message);
      }
```

- [ ] **Step 3: Commit**

```bash
git add deploy.sh backend/src/routes/forms.js
git commit -m "feat: add deploy script and wire receipt backup"
```

---

### Task 10: Replace console.log in All Services

**Files:**
- Modify: `backend/src/routes/forms.js`
- Modify: `backend/src/routes/admin.js`
- Modify: `backend/src/services/quickbooks.js`
- Modify: `backend/src/services/telegram.js`
- Modify: `backend/src/services/browser.js`
- Modify: `backend/src/services/play777.js`
- Modify: `backend/src/services/iconnect.js`
- Modify: `backend/src/index.js`

- [ ] **Step 1: Add logger import to each file**

Add to the top of each file listed above:
```js
const { logger } = require('../services/logger');
// or for index.js:
const { logger } = require('./services/logger');
```

- [ ] **Step 2: Replace all console.log/error calls**

For each file, replace:
- `console.log('message')` → `logger.info('message')`
- `console.log(\`message ${var}\`)` → `logger.info('message', { var })`
- `console.error('message:', err)` → `logger.error('message', { error: err })`
- `console.error('message:', err.message)` → `logger.error('message', { error: err })`

Use context objects instead of string interpolation. For example in `play777.js`:
- `console.log(\`Play777: Loading ${credits} credits to vendor ${account.username}\`)` becomes `logger.info('Loading credits to vendor', { platform: 'PLAY777', account: account.username, credits })`

In `browser.js`:
- `console.log(\`${platform}: AdsPower profile launched (port ${debugPort})\`)` becomes `logger.info('AdsPower profile launched', { platform, debugPort })`

- [ ] **Step 3: Run all tests to make sure nothing broke**

```bash
cd backend && npx jest --no-cache
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/
git commit -m "refactor: replace all console.log/error with structured logger"
```

---

### Task 11: Push and Deploy

- [ ] **Step 1: Push all changes**

```bash
git push
```

- [ ] **Step 2: Deploy to VPS**

```bash
chmod +x deploy.sh && ./deploy.sh
```

Expected: "DEPLOY OK — service is healthy"

- [ ] **Step 3: Verify new tables exist**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'cd /root/WOKE-CreditLoader-Pipeline/backend && node -e "
require(\"dotenv\").config({ path: \".env\" });
const{PrismaClient}=require(\"@prisma/client\");
const p=new PrismaClient();
(async()=>{
  const le=await p.loadEvent.count();
  const ls=await p.loadStep.count();
  const we=await p.webhookEvent.count();
  console.log(\"LoadEvents:\",le,\"LoadSteps:\",ls,\"WebhookEvents:\",we);
  process.exit(0);
})();
"'
```

Expected: All counts return 0 (tables exist, no data yet)

- [ ] **Step 4: Verify webhook processor is running**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'journalctl -u creditloader --no-pager -n 10'
```

Expected: Log output shows structured JSON, "Daily digest scheduled in X minutes", "Backend running on http://localhost:3000"

- [ ] **Step 5: Commit deployment verification**

No code change needed — just verify everything works.

---

## Next Plan

After Plan 1 is complete, proceed to **Plan 2: Browser Resilience & Safety** which covers:
- Screenshot on failure
- Robust element finding with fallback selectors
- Session reuse across loads
- Adaptive waits
- 2FA detection and dashboard code entry
- AdsPower auto-recovery
- Balance verification and LoadStep audit trail
- Correction and chain load safety
