const { getBrowserContext, closeBrowser, humanDelay, humanType, humanMouseMove } = require('./browser');
const { restoreSession, saveSession } = require('./browserSession');
const { captureFailure } = require('./screenshot');
const telegram = require('./telegram');
const prisma = require('../db/client');
const { logger } = require('./logger');
const masterBalance = require('./masterBalance');

const DASHBOARD_URL = 'https://pna.play777games.com/dashboard';
const VENDORS_URL = 'https://pna.play777games.com/vendors-overview';
const MY_BALANCE_URL = 'https://pna.play777games.com/history/my-balance';
const USERNAME = process.env.PLAY777_USERNAME;
const PASSWORD = process.env.PLAY777_PASSWORD;

const LOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — includes verification step
const TFA_TIMEOUT_MS = 5 * 60 * 1000;

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

  await humanDelay(5000, 7000);

  if (page.url().includes('login-2fa')) {
    logger.warn('Play777: 2FA triggered — waiting for code via dashboard');
    try {
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        '🔐 Play777 requires 2FA.\n\nEnter code in admin dashboard (Settings → 2FA Code) within 5 minutes.'
      );
    } catch {}

    const code = await poll2FACode();
    if (!code) {
      await captureFailure(page, 0, '2FA_TIMEOUT');
      throw new Error('2FA code not received within 5 minutes');
    }

    const codeInput = page.locator('input[name="code"], input[type="text"]').first();
    await codeInput.waitFor({ state: 'visible', timeout: 10000 });
    await codeInput.fill(code);
    await humanDelay(300, 500);
    await page.locator('button:has-text("Verify"), button[type="submit"]').first().click();
    await humanDelay(5000, 7000);

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

async function findElement(page, strategies, description) {
  for (const selector of strategies) {
    try {
      const el = page.locator(selector);
      const count = await el.count();
      if (count > 0) {
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

    // Must click "Confirm Correction" on the confirmation popup
    const confirmCorrBtn = await findElement(page, [
      'button:has-text("Confirm Correction")',
      '.swal2-confirm',
      'button.btn-primary:has-text("Confirm")',
    ], 'Confirm Correction button');
    await humanDelay(1000, 2000);
    await confirmCorrBtn.click();
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

  try {
    await page.waitForSelector('.toast-success, .alert-success, .swal2-success, [class*="success"]', { timeout: 15000 });
    return true;
  } catch {
    await captureFailure(page, jobId, 'DEPOSIT_CONFIRM_FAILED');
    throw new Error(`${transactionType === 'correction' ? 'Correction' : 'Deposit'} confirmation did not complete — no success indicator found`);
  }
}

async function dismissStuckModal(page, jobId = 0) {
  // A leftover .modal.show from a prior session silently intercepts every
  // subsequent click on the vendors page. Press Escape until no open modal
  // remains (up to 3 tries), then click the scrim as a last resort.
  for (let i = 0; i < 3; i++) {
    const open = await page.locator('.modal.fade.show, .modal.show').first().isVisible({ timeout: 300 }).catch(() => false);
    if (!open) return;
    logger.warn('Play777: stuck modal detected on vendors page — dismissing', { jobId, attempt: i + 1 });
    await page.keyboard.press('Escape').catch(() => {});
    await humanDelay(600, 1000);
  }
  const stillOpen = await page.locator('.modal.fade.show, .modal.show').first().isVisible({ timeout: 300 }).catch(() => false);
  if (stillOpen) {
    await page.locator('.modal-backdrop').first().click({ timeout: 2000, force: true }).catch(() => {});
    await humanDelay(500, 800);
  }
}

async function navigateToVendorsAndWait(page, jobId = 0) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(VENDORS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await humanDelay(5000, 8000);

    await dismissStuckModal(page, jobId);

    try {
      await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 60000 });
      await humanDelay(2000, 3000);
      return; // Table loaded successfully
    } catch {
      if (attempt === 0) {
        logger.warn('Vendors table did not load — reloading page', { jobId, attempt });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanDelay(8000, 12000);
      } else {
        await captureFailure(page, jobId, 'VENDORS_TABLE_EMPTY');
        throw new Error('Vendors table did not load after 2 attempts');
      }
    }
  }
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

// Verify a transaction by checking My Balance page
async function verifyTransaction(page, expectedAccount, expectedType, expectedCredits, jobId = 0) {
  try {
    await page.goto(MY_BALANCE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(5000, 8000);

    // Wait for the table to load
    try {
      await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 30000 });
    } catch {
      logger.warn('My Balance table did not load — skipping verification', { jobId });
      return { verified: false, reason: 'Table did not load' };
    }
    await humanDelay(1000, 2000);

    // Check the most recent transactions (top 5 rows) for a match
    const match = await page.evaluate(({ account, type, credits }) => {
      const rows = document.querySelectorAll('table tbody tr');
      for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const cells = rows[i].querySelectorAll('td');
        if (cells.length < 6) continue;

        const transactionId = cells[0]?.innerText?.trim();
        const date = cells[1]?.innerText?.trim();
        const to = cells[3]?.innerText?.trim();
        const txType = cells[4]?.innerText?.trim();
        const amount = cells[5]?.innerText?.trim();
        const balance = cells[6]?.innerText?.trim();

        // Match by account name and transaction type
        const accountMatch = to && to.includes(account);
        const typeMatch = txType && txType.toLowerCase() === type.toLowerCase();

        if (accountMatch && typeMatch) {
          return { found: true, transactionId, date, to, type: txType, amount, balance, rowIndex: i };
        }
      }
      return { found: false };
    }, { account: expectedAccount, type: expectedType, credits: expectedCredits });

    // Opportunistic master balance capture — the first row of the my-balance
    // table has the running balance after the most recent transaction, which is
    // what Master715 holds right now. Free to read while we're already on the page.
    try {
      const currentBalance = await masterBalance.readPlay777FromMyBalance(page);
      if (currentBalance != null) {
        await masterBalance.recordBalance('PLAY777', currentBalance, 'opportunistic');
      }
    } catch (balanceErr) {
      logger.warn('Opportunistic Play777 balance capture failed', { error: balanceErr.message });
    }

    if (match.found) {
      logger.info('Transaction verified in My Balance', {
        transactionId: match.transactionId,
        account: expectedAccount,
        type: expectedType,
        amount: match.amount,
        balance: match.balance,
      });
      return { verified: true, ...match };
    }

    logger.warn('Transaction not found in My Balance — may need more time to appear', {
      account: expectedAccount,
      type: expectedType,
      jobId,
    });
    return { verified: false, reason: 'Transaction not found in recent rows' };
  } catch (err) {
    logger.error('Verification failed', { error: err, jobId });
    return { verified: false, reason: err.message };
  }
}

async function loadCredits(account, credits, parentVendor, transactionType = 'deposit', jobId = 0) {
  let session;

  const doLoad = async () => {
    session = await getBrowserContext('play777');
    const context = session.context;

    await restoreSession(context, 'play777');

    // Reuse existing page or create new one (avoids tab buildup)
    const existingPages = context.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Failed to login to Play777');

    await saveSession(context, 'play777');

    if (parentVendor) {
      await loadOperator(page, parentVendor, account, credits, transactionType, jobId);
    } else {
      await loadVendor(page, account, credits, transactionType, jobId);
    }

    // Verify the transaction in My Balance
    const txType = transactionType === 'correction' ? 'Correction' : 'Deposit';
    const verification = await verifyTransaction(page, account.username, txType, credits, jobId);

    await saveSession(context, 'play777');

    return {
      success: true,
      platform: 'PLAY777',
      account: account.username,
      credits,
      verified: verification.verified,
      transactionId: verification.transactionId || null,
    };
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

module.exports = { loadCredits, ensureLoggedIn, verifyTransaction };
