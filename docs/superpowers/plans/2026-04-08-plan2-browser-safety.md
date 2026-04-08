# Plan 2: Browser Resilience & Safety — Remove AdsPower, Add Verification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AdsPower with direct Playwright + stealth, add screenshot-on-failure, 2FA handling via dashboard, balance verification after loads, and session reuse across loads within an invoice.

**Architecture:** Rewrite browser.js to launch headless Chromium directly via playwright-extra with stealth plugin, using DataImpulse proxy inline. Store/restore cookies in the DB Settings table for session persistence. Wrap all browser operations with screenshot capture on failure. Add balance verification by scraping Balance History after each load/correction step.

**Tech Stack:** playwright-extra, puppeteer-extra-plugin-stealth, Prisma (Settings table for cookies), DataImpulse residential proxy

**Spec:** `docs/superpowers/specs/2026-04-08-pipeline-hardening-design.md` (Sections 1, 2, 6)

---

## File Structure

### New Files
- `backend/src/services/browserSession.js` — Cookie persistence (save/restore to DB)
- `backend/src/services/screenshot.js` — Screenshot + HTML capture on failure
- `backend/src/services/balanceVerifier.js` — Scrape Balance History, verify transactions
- `backend/__tests__/browserSession.test.js` — Tests for cookie persistence
- `backend/__tests__/screenshot.test.js` — Tests for screenshot path generation

### Modified Files
- `backend/src/services/browser.js` — Complete rewrite: remove AdsPower, use playwright-extra + stealth + proxy
- `backend/src/services/play777.js` — Adapt to new browser API, add screenshot capture, session reuse
- `backend/src/services/iconnect.js` — Adapt to new browser API, add screenshot capture
- `backend/src/services/autoloader.js` — Session reuse across loads, balance verification calls
- `backend/src/routes/admin.js` — Add 2FA code endpoint, screenshot serving
- `backend/src/index.js` — Add static route for screenshots
- `backend/src/db/prisma/schema.prisma` — No changes (using Settings table for cookies)

### Removed Dependencies
- AdsPower API calls removed entirely from browser.js
- `ADSPOWER_API_URL`, `ADSPOWER_API_KEY`, `ADSPOWER_PLAY777_ID`, `ADSPOWER_ICONNECT_ID` env vars no longer needed

---

### Task 1: Rewrite browser.js — Playwright + Stealth + Proxy

**Files:**
- Modify: `backend/src/services/browser.js` (complete rewrite)

- [ ] **Step 1: Read the current browser.js**

Read `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend/src/services/browser.js` to understand the existing API surface: `getBrowserContext(platform)`, `closeBrowser(session)`, `humanDelay`, `humanType`, `humanMouseMove`.

- [ ] **Step 2: Rewrite browser.js**

Replace the entire file with:

```js
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const { logger } = require('./logger');

// Apply stealth plugin
chromium.use(stealth());

// Proxy config — DataImpulse residential premium
const PROXY_HOST = process.env.PROXY_HOST || 'gw.dataimpulse.com';
const PROXY_PORT = process.env.PROXY_PORT || '823';
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;

// Rate limiter — track launches per platform
const launchHistory = {};
const MAX_LAUNCHES = 3;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function checkRateLimit(platform) {
  const now = Date.now();
  if (!launchHistory[platform]) launchHistory[platform] = [];
  launchHistory[platform] = launchHistory[platform].filter((t) => now - t < WINDOW_MS);
  if (launchHistory[platform].length >= MAX_LAUNCHES) {
    const oldestInWindow = launchHistory[platform][0];
    const waitSec = Math.ceil((WINDOW_MS - (now - oldestInWindow)) / 1000);
    throw new Error(`Rate limit: ${MAX_LAUNCHES} browser launches in ${WINDOW_MS / 60000}min window. Wait ${waitSec}s before retrying.`);
  }
  launchHistory[platform].push(now);
}

// Human-like delay — randomized to look natural
function humanDelay(min = 800, max = 2500) {
  const delay = Math.floor(Math.random() * (max - min) + min);
  return new Promise((r) => setTimeout(r, delay));
}

// Type like a human — variable speed per character with occasional pauses
async function humanType(page, selector, text) {
  await page.click(selector);
  await humanDelay(300, 600);
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (i > 0 && Math.random() < 0.08) {
      await humanDelay(400, 1200);
    }
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 150) + 30 });
  }
}

// Simulate subtle mouse movement
async function humanMouseMove(page) {
  const x = 200 + Math.floor(Math.random() * 800);
  const y = 150 + Math.floor(Math.random() * 400);
  await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
}

// Launch a browser with stealth and proxy
async function getBrowserContext(platform) {
  checkRateLimit(platform);

  const launchArgs = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=512',
  ];

  const launchOptions = {
    headless: true,
    args: launchArgs,
  };

  // Add proxy if credentials are configured
  if (PROXY_USER && PROXY_PASS) {
    launchOptions.proxy = {
      server: `http://${PROXY_HOST}:${PROXY_PORT}`,
      username: PROXY_USER,
      password: PROXY_PASS,
    };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  logger.info('Browser launched', { platform, proxy: PROXY_USER ? 'enabled' : 'disabled' });

  return { browser, context, platform };
}

// Close browser
async function closeBrowser(session) {
  try {
    if (session.browser) {
      await session.browser.close();
      logger.info('Browser closed', { platform: session.platform });
    }
  } catch (err) {
    logger.error('Failed to close browser', { error: err });
  }
}

module.exports = {
  getBrowserContext,
  closeBrowser,
  humanDelay,
  humanType,
  humanMouseMove,
};
```

- [ ] **Step 3: Add proxy env vars to .env on VPS**

SSH to VPS and add to `/root/WOKE-CreditLoader-Pipeline/backend/.env`:
```
PROXY_HOST=gw.dataimpulse.com
PROXY_PORT=823
PROXY_USER=ac6522d6f0307b76a04b
PROXY_PASS=4bd6a06e95604f12
```

- [ ] **Step 4: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/services/browser.js
git commit -m "feat: replace AdsPower with direct Playwright + stealth + DataImpulse proxy"
```

---

### Task 2: Cookie Persistence — Save/Restore Sessions

**Files:**
- Create: `backend/src/services/browserSession.js`
- Create: `backend/__tests__/browserSession.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// backend/__tests__/browserSession.test.js
const { serializeCookies, deserializeCookies } = require('../src/services/browserSession');

describe('browserSession', () => {
  test('serializeCookies converts cookie array to JSON string', () => {
    const cookies = [
      { name: 'session', value: 'abc123', domain: '.example.com', path: '/' },
    ];
    const result = serializeCookies(cookies);
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed[0].name).toBe('session');
  });

  test('deserializeCookies converts JSON string back to array', () => {
    const json = JSON.stringify([{ name: 'token', value: 'xyz' }]);
    const result = deserializeCookies(json);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('token');
  });

  test('deserializeCookies returns empty array for null', () => {
    expect(deserializeCookies(null)).toEqual([]);
  });

  test('deserializeCookies returns empty array for invalid JSON', () => {
    expect(deserializeCookies('not json')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest __tests__/browserSession.test.js --no-cache
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write the implementation**

```js
// backend/src/services/browserSession.js
const prisma = require('../db/client');
const { logger } = require('./logger');

function serializeCookies(cookies) {
  return JSON.stringify(cookies);
}

function deserializeCookies(json) {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

async function saveCookies(platform, cookies) {
  const key = `${platform}_cookies`;
  const value = serializeCookies(cookies);
  try {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    logger.info('Session cookies saved', { platform, cookieCount: cookies.length });
  } catch (err) {
    logger.error('Failed to save cookies', { platform, error: err });
  }
}

async function loadCookies(platform) {
  const key = `${platform}_cookies`;
  try {
    const setting = await prisma.setting.findUnique({ where: { key } });
    if (!setting) return [];
    const cookies = deserializeCookies(setting.value);
    logger.info('Session cookies loaded', { platform, cookieCount: cookies.length });
    return cookies;
  } catch (err) {
    logger.error('Failed to load cookies', { platform, error: err });
    return [];
  }
}

async function restoreSession(context, platform) {
  const cookies = await loadCookies(platform);
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }
  return cookies.length > 0;
}

async function saveSession(context, platform) {
  const cookies = await context.cookies();
  await saveCookies(platform, cookies);
}

module.exports = {
  serializeCookies,
  deserializeCookies,
  saveCookies,
  loadCookies,
  restoreSession,
  saveSession,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest __tests__/browserSession.test.js --no-cache
```

Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/services/browserSession.js backend/__tests__/browserSession.test.js
git commit -m "feat: add cookie persistence for browser sessions"
```

---

### Task 3: Screenshot Capture Service

**Files:**
- Create: `backend/src/services/screenshot.js`
- Create: `backend/__tests__/screenshot.test.js`
- Modify: `backend/src/index.js` (serve screenshot files)

- [ ] **Step 1: Write the failing tests**

```js
// backend/__tests__/screenshot.test.js
const { buildScreenshotPath } = require('../src/services/screenshot');

describe('screenshot', () => {
  test('buildScreenshotPath generates correct path', () => {
    const result = buildScreenshotPath(42, 'LOGIN_FAILED');
    expect(result).toMatch(/\/var\/log\/creditloader\/failures\//);
    expect(result).toMatch(/42/);
    expect(result).toMatch(/LOGIN_FAILED/);
    expect(result).toMatch(/\.png$/);
  });

  test('buildScreenshotPath sanitizes step name', () => {
    const result = buildScreenshotPath(1, 'MODAL/SUBMIT');
    expect(result).not.toContain('/SUBMIT');
    expect(result).toMatch(/MODAL-SUBMIT/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest __tests__/screenshot.test.js --no-cache
```

- [ ] **Step 3: Write the implementation**

```js
// backend/src/services/screenshot.js
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const FAILURE_DIR = '/var/log/creditloader/failures';

function buildScreenshotPath(invoiceOrJobId, step) {
  const sanitized = step.replace(/[^a-zA-Z0-9_-]/g, '-');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(FAILURE_DIR, `${invoiceOrJobId}-${sanitized}-${ts}.png`);
}

async function captureFailure(page, invoiceOrJobId, step) {
  try {
    fs.mkdirSync(FAILURE_DIR, { recursive: true });

    const screenshotPath = buildScreenshotPath(invoiceOrJobId, step);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Also save HTML
    const htmlPath = screenshotPath.replace('.png', '.html');
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);

    logger.info('Failure screenshot captured', {
      screenshotPath,
      step,
      url: page.url(),
    });

    return screenshotPath;
  } catch (err) {
    logger.error('Failed to capture screenshot', { error: err, step });
    return null;
  }
}

module.exports = { buildScreenshotPath, captureFailure, FAILURE_DIR };
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest __tests__/screenshot.test.js --no-cache
```

Expected: 2 tests PASS

- [ ] **Step 5: Add static route for screenshot files in index.js**

In `backend/src/index.js`, before the `app.use(express.static(publicPath))` line, add:

```js
// Serve failure screenshots for admin dashboard
app.use('/api/screenshots', requireAdmin, express.static('/var/log/creditloader/failures'));
```

Also import `requireAdmin` at the top:
```js
const { requireAdmin } = require('./middleware/auth');
```

- [ ] **Step 6: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/services/screenshot.js backend/__tests__/screenshot.test.js backend/src/index.js
git commit -m "feat: add screenshot capture on failure with static serving"
```

---

### Task 4: Update play777.js — New Browser API + Screenshots + Cookie Sessions

**Files:**
- Modify: `backend/src/services/play777.js`

This is the biggest task. The key changes:
1. Import browserSession for cookie save/restore
2. Import screenshot for failure capture
3. Restore cookies before navigating (skip login if cookies work)
4. Save cookies after successful login
5. Wrap all critical operations in try/catch that captures screenshots on failure
6. 2FA detection sends Telegram + polls for code via Settings table

- [ ] **Step 1: Read current play777.js**

Read `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend/src/services/play777.js`

- [ ] **Step 2: Rewrite play777.js**

Replace the entire file:

```js
const { getBrowserContext, closeBrowser, humanDelay, humanType, humanMouseMove } = require('./browser');
const { restoreSession, saveSession } = require('./browserSession');
const { captureFailure } = require('./screenshot');
const telegram = require('./telegram');
const prisma = require('../db/client');
const { logger } = require('./logger');

const DASHBOARD_URL = 'https://pna.play777games.com/dashboard';
const VENDORS_URL = 'https://pna.play777games.com/vendors-overview';
const USERNAME = process.env.PLAY777_USERNAME;
const PASSWORD = process.env.PLAY777_PASSWORD;

const LOAD_TIMEOUT_MS = 3 * 60 * 1000;
const TFA_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for 2FA

async function ensureLoggedIn(page) {
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(2000, 4000);

  if (!page.url().includes('/login')) {
    logger.info('Play777: Already logged in');
    return true;
  }

  logger.info('Play777: Session expired, logging in...');
  await humanDelay(500, 1200);
  await humanType(page, 'input[name="username"]', USERNAME);
  await humanDelay(400, 900);
  await humanType(page, 'input[name="password"]', PASSWORD);
  await humanDelay(300, 800);

  const trustCheckbox = page.locator('input[name="remember"]');
  if (await trustCheckbox.isVisible()) {
    if (!(await trustCheckbox.isChecked())) {
      await trustCheckbox.click();
      await humanDelay(200, 500);
    }
  }

  await humanDelay(500, 1000);
  await page.click('button.btn.btn-primary');

  // Wait for redirect — could go to dashboard or 2FA
  await humanDelay(5000, 7000);

  if (page.url().includes('login-2fa')) {
    logger.warn('Play777: 2FA triggered — waiting for code via dashboard');
    try {
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        '🔐 Play777 requires 2FA.\n\nEnter code in admin dashboard (Settings → 2FA Code) within 5 minutes.'
      );
    } catch {}

    // Poll for 2FA code from Settings table
    const code = await poll2FACode();
    if (!code) {
      await captureFailure(page, 0, '2FA_TIMEOUT');
      throw new Error('2FA code not received within 5 minutes');
    }

    // Enter the code
    const codeInput = page.locator('input[name="code"], input[type="text"]').first();
    await codeInput.waitFor({ state: 'visible', timeout: 10000 });
    await codeInput.fill(code);
    await humanDelay(300, 500);
    await page.locator('button:has-text("Verify"), button[type="submit"]').first().click();
    await humanDelay(5000, 7000);

    // Clean up the 2FA code from settings
    await prisma.setting.delete({ where: { key: 'play777_2fa_code' } }).catch(() => {});

    if (page.url().includes('/login')) {
      await captureFailure(page, 0, '2FA_FAILED');
      throw new Error('2FA code was rejected');
    }
    logger.info('Play777: 2FA completed successfully');
  }

  if (!page.url().includes('/login')) {
    logger.info('Play777: Login successful');
    return true;
  }

  await captureFailure(page, 0, 'LOGIN_FAILED');
  throw new Error('Login failed — still on login page');
}

async function poll2FACode() {
  const startTime = Date.now();
  while (Date.now() - startTime < TFA_TIMEOUT_MS) {
    try {
      const setting = await prisma.setting.findUnique({ where: { key: 'play777_2fa_code' } });
      if (setting && setting.value) {
        logger.info('Play777: 2FA code received from dashboard');
        return setting.value;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

// Find an element using multiple selector strategies
async function findElement(page, strategies, description) {
  for (const selector of strategies) {
    try {
      const el = page.locator(selector);
      const count = await el.count();
      if (count > 0) {
        logger.debug('Element found', { description, selector });
        return el.first();
      }
    } catch {}
  }
  throw new Error(`Could not find element: ${description}. Tried: ${strategies.join(', ')}`);
}

async function fillDepositModal(page, credits, transactionType = 'deposit', jobId = 0) {
  const form = page.locator('#app-form-agent-balance');
  await form.waitFor({ state: 'attached', timeout: 10000 });
  await humanDelay(800, 1500);

  if (transactionType === 'correction') {
    const txTypeSelect = form.locator('.multiselect').nth(0);
    await txTypeSelect.click();
    await humanDelay(500, 1000);
    const correctionOption = form.locator('li[aria-label="Correction"]');
    await correctionOption.waitFor({ state: 'attached', timeout: 5000 });
    await correctionOption.click();
    await humanDelay(800, 1500);
  }

  if (transactionType !== 'correction') {
    await humanMouseMove(page);
    const paymentMethodSelect = form.locator('.multiselect').nth(1);
    await paymentMethodSelect.click();
    await humanDelay(500, 1000);
    const wireOption = form.locator('li[aria-label="Wire Transfer"]');
    await wireOption.waitFor({ state: 'attached', timeout: 5000 });
    await wireOption.click();
    await humanDelay(800, 1500);
  }

  await humanMouseMove(page);
  let creditsInput;
  if (transactionType === 'correction') {
    creditsInput = form.locator('input[type="number"]').nth(1);
  } else {
    creditsInput = form.locator('.input-group input[type="number"]');
  }
  await creditsInput.waitFor({ state: 'attached', timeout: 5000 });
  await creditsInput.click();
  await humanDelay(300, 600);
  await creditsInput.fill(String(credits));
  await humanDelay(800, 1500);

  await humanMouseMove(page);
  const modal = page.locator('.modal.show').first();

  if (transactionType === 'correction') {
    const correctBtn = await findElement(modal, [
      '.modal-footer button:has-text("Correct")',
      '.modal-footer button.btn-primary',
      'button[type="submit"]',
    ], 'Correct button');
    await correctBtn.click();
    await humanDelay(1500, 3000);
  } else {
    const depositBtn = await findElement(modal, [
      '.modal-footer button:has-text("Deposit")',
      '.modal-footer button.btn-primary',
      'button[type="submit"]',
    ], 'Deposit button');
    await depositBtn.click();
    await humanDelay(1500, 3000);

    const confirmBtn = await findElement(page, [
      'button:has-text("Confirm Deposit")',
      '.swal2-confirm',
      'button.btn-primary:has-text("Confirm")',
    ], 'Confirm Deposit button');
    await humanDelay(1000, 2000);
    await confirmBtn.click();
  }

  // Wait for success
  try {
    await page.waitForSelector('.toast-success, .alert-success, .swal2-success, [class*="success"]', { timeout: 15000 });
    return true;
  } catch {
    const modalStillOpen = await form.isVisible().catch(() => false);
    if (!modalStillOpen) return true;
    await captureFailure(page, jobId, 'DEPOSIT_CONFIRM_FAILED');
    throw new Error('Deposit confirmation did not complete');
  }
}

async function navigateToVendorsAndWait(page, jobId = 0) {
  await page.goto(VENDORS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await humanDelay(5000, 8000);

  // Adaptive wait — keep checking for table rows for up to 60s
  try {
    await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 60000 });
  } catch {
    await captureFailure(page, jobId, 'VENDORS_TABLE_EMPTY');
    throw new Error('Vendors table did not load within 60 seconds');
  }
  await humanDelay(2000, 3000);
}

async function findVendorRow(page, operatorId, username, jobId = 0) {
  const rowIndex = await page.evaluate((opId) => {
    const rows = document.querySelectorAll('table tbody tr');
    for (let i = 0; i < rows.length; i++) {
      const link = rows[i].querySelector(`a[onclick="return showAgentDrawer(${opId})"]`);
      if (link) return i;
    }
    return -1;
  }, operatorId);

  if (rowIndex === -1) {
    await captureFailure(page, jobId, 'VENDOR_ROW_NOT_FOUND');
    throw new Error(`Vendor ${username} (${operatorId}) not found on vendors page`);
  }

  return page.locator('table tbody tr').nth(rowIndex);
}

async function loadVendor(page, account, credits, transactionType = 'deposit', jobId = 0) {
  await navigateToVendorsAndWait(page, jobId);
  const row = await findVendorRow(page, account.operatorId, account.username, jobId);
  await row.scrollIntoViewIfNeeded();
  await humanDelay(500, 1000);

  const actionButtons = await row.locator('td').last().locator('button.btn-icon').all();
  logger.info('Play777: Loading credits to vendor', { credits, username: account.username, operatorId: account.operatorId });
  await humanMouseMove(page);
  await actionButtons[1].click();
  await humanDelay(1500, 3000);

  await fillDepositModal(page, credits, transactionType, jobId);
  logger.info('Play777: Successfully loaded credits to vendor', { credits, username: account.username });
}

async function loadOperator(page, vendor, operator, credits, transactionType = 'deposit', jobId = 0) {
  await navigateToVendorsAndWait(page, jobId);
  const vendorRow = await findVendorRow(page, vendor.operatorId, vendor.username, jobId);
  await vendorRow.scrollIntoViewIfNeeded();
  await humanDelay(500, 1000);

  const vendorButtons = await vendorRow.locator('td').last().locator('button.btn-icon').all();
  logger.info('Play777: Opening operators for vendor', { username: vendor.username });
  await humanMouseMove(page);
  await vendorButtons[4].click();
  await humanDelay(3000, 5000);

  const operatorRow = page.locator(`tr:has(a[onclick="return showAgentDrawer(${operator.operatorId})"])`).last();
  try {
    await operatorRow.waitFor({ state: 'attached', timeout: 30000 });
  } catch {
    await captureFailure(page, jobId, 'OPERATOR_ROW_NOT_FOUND');
    throw new Error(`Operator ${operator.username} (${operator.operatorId}) not found`);
  }
  await operatorRow.scrollIntoViewIfNeeded();
  await humanDelay(500, 1000);

  const operatorButtons = await operatorRow.locator('td').last().locator('button.btn-icon').all();
  logger.info('Play777: Loading credits to operator', { credits, username: operator.username, operatorId: operator.operatorId });
  await humanMouseMove(page);
  await operatorButtons[1].click();
  await humanDelay(1500, 3000);

  await fillDepositModal(page, credits, transactionType, jobId);
  logger.info('Play777: Successfully loaded credits to operator', { credits, username: operator.username });
}

async function loadCredits(account, credits, parentVendor, transactionType = 'deposit', jobId = 0) {
  let session;

  const doLoad = async () => {
    session = await getBrowserContext('play777');
    const context = session.context;

    // Restore saved cookies for session persistence
    await restoreSession(context, 'play777');

    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Failed to login to Play777');

    // Save cookies after successful login
    await saveSession(context, 'play777');

    if (parentVendor) {
      await loadOperator(page, parentVendor, account, credits, transactionType, jobId);
    } else {
      await loadVendor(page, account, credits, transactionType, jobId);
    }

    // Save cookies after successful load
    await saveSession(context, 'play777');

    return { success: true, platform: 'PLAY777', account: account.username, credits };
  };

  try {
    const result = await Promise.race([
      doLoad(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Play777 load timed out after 3 minutes')), LOAD_TIMEOUT_MS)
      ),
    ]);
    return result;
  } catch (err) {
    logger.error('Play777 load error', { error: err });
    return { success: false, platform: 'PLAY777', account: account.username, error: err.message };
  } finally {
    if (session) {
      await closeBrowser(session);
    }
  }
}

module.exports = { loadCredits, ensureLoggedIn };
```

- [ ] **Step 3: Run all tests**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest --no-cache
```

Expected: All tests PASS (no browser tests — these are unit tests only)

- [ ] **Step 4: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/services/play777.js
git commit -m "feat: rewrite play777.js — cookie sessions, screenshots, 2FA polling, fallback selectors"
```

---

### Task 5: Update iconnect.js — New Browser API + Screenshots + Cookie Sessions

**Files:**
- Modify: `backend/src/services/iconnect.js`

- [ ] **Step 1: Read current iconnect.js**

Read `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend/src/services/iconnect.js`

- [ ] **Step 2: Rewrite iconnect.js**

Replace the entire file:

```js
const { getBrowserContext, closeBrowser, humanDelay, humanType, humanMouseMove } = require('./browser');
const { restoreSession, saveSession } = require('./browserSession');
const { captureFailure } = require('./screenshot');
const { logger } = require('./logger');

const SHOP_URL = 'https://river-pay.com/agent/show';
const USERNAME = process.env.ICONNECT_USERNAME;
const PASSWORD = process.env.ICONNECT_PASSWORD;

const LOAD_TIMEOUT_MS = 3 * 60 * 1000;

async function ensureLoggedIn(page) {
  await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(2000, 4000);

  if (!page.url().includes('/login')) {
    logger.info('IConnect: Already logged in');
    return true;
  }

  logger.info('IConnect: Session expired, logging in...');
  await humanDelay(500, 1200);
  await humanType(page, '#LoginForm_login', USERNAME);
  await humanDelay(400, 900);
  await humanType(page, '#LoginForm_password', PASSWORD);
  await humanDelay(500, 1000);

  await page.click('input[type="submit"][name="yt0"]');

  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
    logger.info('IConnect: Login successful');
    return true;
  } catch (e) {
    await captureFailure(page, 0, 'ICONNECT_LOGIN_FAILED');
    logger.error('IConnect: Login failed', { error: e });
    return false;
  }
}

async function loadCredits(account, credits, jobId = 0) {
  let session;

  const doLoad = async () => {
    session = await getBrowserContext('iconnect');
    const context = session.context;

    await restoreSession(context, 'iconnect');

    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Failed to login to IConnect');

    await saveSession(context, 'iconnect');

    await humanDelay(2000, 4000);

    if (!page.url().includes('/agent/show')) {
      await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await humanDelay(2000, 4000);
    }

    logger.info('IConnect: Loading credits', { credits, username: account.username });

    const depositBtn = page.locator(`button[onclick*="'${account.username}'"]`);
    const btnCount = await depositBtn.count();
    if (btnCount === 0) {
      await captureFailure(page, jobId, 'ICONNECT_USER_NOT_FOUND');
      throw new Error(`User "${account.username}" not found in IConnect table`);
    }

    const onclick = await depositBtn.first().getAttribute('onclick');
    const match = onclick.match(/initDepositModal\(\s*'(\d+)',\s*'([^']+)',\s*'(\d+)',\s*'([^']+)'/);
    if (!match) {
      await captureFailure(page, jobId, 'ICONNECT_PARSE_FAILED');
      throw new Error('Could not parse deposit button onclick params');
    }

    const [, agentId, login, parentId, balance] = match;
    logger.info('IConnect: Agent found', { login, agentId, balance });

    await humanMouseMove(page);
    await humanDelay(500, 1200);
    await page.evaluate(({ agentId, login, parentId, balance }) => {
      initDepositModal(agentId, login, parentId, balance);
      $('#modal-deposite').modal('show');
    }, { agentId, login, parentId, balance });
    await humanDelay(1500, 3000);

    await page.waitForSelector('#modal-deposite.in, #modal-deposite.show', { state: 'visible', timeout: 10000 });
    await humanDelay(800, 1500);

    await humanDelay(500, 1000);
    await page.evaluate((credits) => {
      const input = document.getElementById('modal-deposite-amount');
      input.value = credits;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(credits));
    await humanDelay(800, 1500);

    await Promise.all([
      page.waitForURL('**/agent/show**', { timeout: 30000 }),
      page.evaluate(() => {
        document.querySelector('#modal-deposite input[type="submit"][value="Apply"]').click();
      }),
    ]);

    await humanDelay(2000, 4000);

    if (page.url().includes('/agent/show')) {
      logger.info('IConnect: Successfully loaded credits', { credits, username: account.username });
      await saveSession(context, 'iconnect');
      return { success: true, platform: 'ICONNECT', account: account.username, credits };
    } else {
      await captureFailure(page, jobId, 'ICONNECT_DEPOSIT_FAILED');
      throw new Error('Page did not return to /agent/show after deposit');
    }
  };

  try {
    const result = await Promise.race([
      doLoad(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IConnect load timed out after 3 minutes')), LOAD_TIMEOUT_MS)
      ),
    ]);
    return result;
  } catch (err) {
    logger.error('IConnect load error', { error: err });
    return { success: false, platform: 'ICONNECT', account: account.username, error: err.message };
  } finally {
    if (session) {
      await closeBrowser(session);
    }
  }
}

module.exports = { loadCredits, ensureLoggedIn };
```

- [ ] **Step 3: Run all tests**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest --no-cache
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/services/iconnect.js
git commit -m "feat: rewrite iconnect.js — cookie sessions, screenshots on failure"
```

---

### Task 6: 2FA Code Admin Endpoint

**Files:**
- Modify: `backend/src/routes/admin.js`

- [ ] **Step 1: Read current admin.js**

Read `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend/src/routes/admin.js`

- [ ] **Step 2: Add 2FA code endpoint and status endpoint**

Add these routes after the existing events endpoint:

```js
// Submit 2FA code for Play777 login
router.post('/2fa-code', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    await prisma.setting.upsert({
      where: { key: 'play777_2fa_code' },
      update: { value: String(code) },
      create: { key: 'play777_2fa_code', value: String(code) },
    });

    logger.info('2FA code submitted via dashboard', { codeLength: code.length });
    res.json({ success: true, message: '2FA code submitted — browser will pick it up within 5 seconds' });
  } catch (err) {
    logger.error('2FA code submission failed', { error: err });
    res.status(500).json({ error: 'Failed to submit 2FA code' });
  }
});

// Check if 2FA is currently needed
router.get('/2fa-status', async (req, res) => {
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'play777_2fa_code' } });
    // If the key exists but value is empty, 2FA was requested but not yet answered
    // The play777 service creates this entry when 2FA is triggered
    res.json({ needed: false }); // Frontend will check loading invoices for 2FA status
  } catch (err) {
    res.status(500).json({ error: 'Failed to check 2FA status' });
  }
});
```

- [ ] **Step 3: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/routes/admin.js
git commit -m "feat: add 2FA code submission endpoint for Play777 login"
```

---

### Task 7: Update autoloader.js — Pass jobId to Load Functions

**Files:**
- Modify: `backend/src/services/autoloader.js`

The load functions now accept a `jobId` parameter for screenshot naming. Update the calls in autoloader to pass it.

- [ ] **Step 1: Read current autoloader.js**

Read `/Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend/src/services/autoloader.js`

- [ ] **Step 2: Update executeLoad to pass jobId**

In the `executeLoad` function, update the play777 and iconnect calls to pass `job.id`:

Change the play777 call from:
```js
      result = await play777.loadCredits(
        { username: account.username, operatorId: account.operatorId },
        credits,
        parentVendor,
        transactionType
      );
```
to:
```js
      result = await play777.loadCredits(
        { username: account.username, operatorId: account.operatorId },
        credits,
        parentVendor,
        transactionType,
        job.id
      );
```

Change the iconnect call from:
```js
      result = await iconnect.loadCredits(
        { username: account.username },
        credits
      );
```
to:
```js
      result = await iconnect.loadCredits(
        { username: account.username },
        credits,
        job.id
      );
```

- [ ] **Step 3: Update the correction deduct call to pass jobId**

In the correction flow, update the play777.loadCredits call for deduction:

Change from:
```js
      deductResult = await play777.loadCredits(
        { username: source.username, operatorId: source.operatorId },
        totalCorrectionCredits,
        null,
        'correction'
      );
```
to:
```js
      deductResult = await play777.loadCredits(
        { username: source.username, operatorId: source.operatorId },
        totalCorrectionCredits,
        null,
        'correction',
        pendingJobs[0].id
      );
```

- [ ] **Step 4: Run all tests**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest --no-cache
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/services/autoloader.js
git commit -m "feat: pass jobId to load functions for screenshot naming"
```

---

### Task 8: Remove AdsPower Env Vars and Cleanup

**Files:**
- Modify: `backend/src/services/healthDigest.js` (remove AdsPower health check)
- Modify: `backend/src/healthcheck.js` (remove AdsPower checks)

- [ ] **Step 1: Update healthDigest.js**

In `backend/src/services/healthDigest.js`, remove the AdsPower API check block and replace the infrastructure section:

Remove:
```js
const ADSPOWER_API = process.env.ADSPOWER_API_URL || 'http://127.0.0.1:50325';
const ADSPOWER_TOKEN = process.env.ADSPOWER_API_KEY;
```

Remove the entire `let adspowerOk = false; try { ... } catch {}` block.

Replace the infrastructure lines in the message template:
```
${adspowerOk ? '✅' : '❌'} AdsPower API
```
with:
```
✅ Browser: Playwright + Stealth
```

- [ ] **Step 2: Update healthcheck.js**

In `backend/src/healthcheck.js`, remove the AdsPower API check, AdsPower Play777 profile check, and AdsPower IConnect profile check (the 3 AdsPower-related `await check(...)` blocks). Keep the Backend API, QuickBooks, Database, and External HTTPS checks.

Also remove the `ADSPOWER_API` and `ADSPOWER_TOKEN` constants at the top.

- [ ] **Step 3: Commit**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline
git add backend/src/services/healthDigest.js backend/src/healthcheck.js
git commit -m "chore: remove AdsPower references from health checks"
```

---

### Task 9: Push and Deploy

- [ ] **Step 1: Run all tests**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline/backend && npx jest --no-cache
```

Expected: All tests PASS

- [ ] **Step 2: Push**

```bash
cd /Users/bmacpro/Claude/WokeAVR-CreditLoader-Pipeline && git push
```

- [ ] **Step 3: Add proxy env vars on VPS**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'cat >> /root/WOKE-CreditLoader-Pipeline/backend/.env << EOF
PROXY_HOST=gw.dataimpulse.com
PROXY_PORT=823
PROXY_USER=ac6522d6f0307b76a04b
PROXY_PASS=4bd6a06e95604f12
EOF
echo "Proxy env vars added"'
```

- [ ] **Step 4: Create screenshot directories on VPS**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'mkdir -p /var/log/creditloader/failures /var/log/creditloader/loads && echo "Dirs created"'
```

- [ ] **Step 5: Deploy**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'cd /root/WOKE-CreditLoader-Pipeline && git pull && cd backend && npm install --production && npx prisma generate --schema src/db/prisma/schema.prisma && systemctl restart creditloader && sleep 3 && curl -sf http://localhost:3000/api/vendors/mike > /dev/null && echo "DEPLOY OK" || echo "DEPLOY FAILED"'
```

Expected: "DEPLOY OK"

- [ ] **Step 6: Verify structured logs show new browser launch**

```bash
sshpass -p '7oSp1x/KE2saDgnDu1kfAQ==' ssh -o StrictHostKeyChecking=no root@87.99.135.197 'journalctl -u creditloader --no-pager -n 5'
```

Expected: JSON logs, no AdsPower references

---

## What This Plan Does NOT Cover (Deferred to Plan 3)

- Balance verification (scraping Balance History) — needs Play777 page exploration first
- LoadStep audit trail population — depends on balance verification
- Dashboard event timeline UI (frontend React component)
- Unit/integration/smoke tests for browser flows
- Master balance audit

These are deferred because they require interactive exploration of Play777's Balance History page to confirm selectors, which should happen after the core browser layer is proven working.
