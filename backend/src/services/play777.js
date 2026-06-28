const { getBrowserContext, closeBrowser, humanDelay, humanType, humanMouseMove, humanDwell, pruneStaleTabs, isCrashError } = require('./browser');
const { restoreSession, saveSession } = require('./browserSession');
const { captureFailure } = require('./screenshot');
const telegram = require('./telegram');
const prisma = require('../db/client');
const { logger } = require('./logger');
const masterBalance = require('./masterBalance');
const blockadeDetector = require('./blockadeDetector');

const DASHBOARD_URL = 'https://pna.play777games.com/dashboard';
const VENDORS_URL = 'https://pna.play777games.com/vendors-overview';
// Play777 renamed /history/my-balance -> /history/balance on/around 2026-05.
// The old URL returns a 404 SPA page that hangs DCL until our timeout.
const MY_BALANCE_URL = 'https://pna.play777games.com/history/balance';
const USERNAME = process.env.PLAY777_USERNAME;
const PASSWORD = process.env.PLAY777_PASSWORD;

const LOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — includes verification step
const TFA_TIMEOUT_MS = 5 * 60 * 1000;

async function ensureLoggedIn(page) {
  // 90s timeout (was 60s): when CF serves a JS challenge to a fresh
  // session, the browser can take 10-30s to solve before DCL fires.
  // 60s was just-too-tight, especially when proxy adds latency.
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
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
    } catch (alertErr) {
      logger.error('Telegram 2FA-prompt alert failed — admin will not see the prompt!', { error: alertErr.message });
    }

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

  // Race the success indicator against the phone-verification form. When
  // Master715 depletes mid-deposit, Play777 silently aborts the modal and
  // routes the operator into a "change phone" / "verify phone" form
  // (see reference_play777_master.md). The Confirm button then falls
  // through to whatever's at that screen position now, which used to
  // surface as a generic 'no success indicator found' timeout — and we
  // had no idea master was depleted or session needed re-verification.
  // Detect that state distinctly so the operator gets a real signal.
  const PHONE_FORM_SELECTORS = [
    'input[type="tel"]',
    'input[name*="phone" i]',
    'input[placeholder*="phone" i]',
    '[class*="phone-verif" i]',
    '[class*="change-phone" i]',
    'h1:has-text("Verify Phone")',
    'h2:has-text("Verify Phone")',
    'h1:has-text("Change Phone")',
    'h2:has-text("Change Phone")',
    ':text-matches("verify your phone", "i")',
  ].join(', ');

  let outcome;
  try {
    outcome = await Promise.race([
      page.waitForSelector('.toast-success, .alert-success, .swal2-success, [class*="success"]', { timeout: 15000 })
        .then(() => 'success'),
      page.waitForSelector(PHONE_FORM_SELECTORS, { timeout: 15000 })
        .then(() => 'phone_form'),
    ]);
  } catch {
    outcome = 'timeout';
  }

  if (outcome === 'phone_form') {
    await captureFailure(page, jobId, 'PHONE_VERIFICATION_REQUIRED');
    // Telegram the admin immediately — operator action is required and
    // retrying into the same wall just burns rate-limit slots.
    try {
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `📵 *PHONE VERIFICATION REQUIRED — Play777 deposit blocked*\n\n` +
        `LoadJob #${jobId} hit Play777's change-phone form mid-deposit (typically means Master715 is depleted or the session needs re-verification).\n\n` +
        `*Action:* log into Play777 admin via VNC, complete the phone verification / top up master, then retry the affected invoice from the admin dashboard.`,
        { parse_mode: 'Markdown' }
      );
    } catch (alertErr) {
      logger.error('Telegram PHONE_VERIFICATION_REQUIRED alert send failed', { error: alertErr.message });
    }
    throw new Error('PHONE_VERIFICATION_REQUIRED: Master715 depleted or session needs phone re-verification — admin alerted');
  }
  if (outcome === 'timeout') {
    await captureFailure(page, jobId, 'DEPOSIT_CONFIRM_FAILED');
    throw new Error(`${transactionType === 'correction' ? 'Correction' : 'Deposit'} confirmation did not complete — no success indicator found`);
  }
  return true;
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
    // 90s navigation timeout to give CF JS challenge time to solve.
    await page.goto(VENDORS_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await humanDelay(5000, 8000);

    await dismissStuckModal(page, jobId);

    try {
      // Table selector wait stays at 60s — this is HTML hydration, not network.
      await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 60000 });
      await humanDelay(2000, 3000);
      return; // Table loaded successfully
    } catch {
      if (attempt === 0) {
        logger.warn('Vendors table did not load — reloading page', { jobId, attempt });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await humanDelay(8000, 12000);
      } else {
        // The table never loaded. Before reporting a generic timeout, figure
        // out WHY — a blocking modal ("Update Your Contact" phone wall) or a
        // Cloudflare block page looks identical to "slow table" from here, but
        // needs a human, not a retry. Tag the error with BLOCKADE:<TYPE> so the
        // autoloader stops + alerts instead of thrashing into the wall.
        const blockade = await blockadeDetector.detectOnPage(page);
        const shotPath = await captureFailure(
          page,
          jobId,
          blockade ? `BLOCKED_${blockade.type}` : 'VENDORS_TABLE_EMPTY'
        );
        if (blockade) {
          const err = new Error(`BLOCKADE:${blockade.type}: ${blockade.label} on vendors page`);
          err.blockade = blockade;
          err.screenshotPath = shotPath;
          throw err;
        }
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
    // Navigate to My Balance. Prefer SPA routing (click the in-app sidebar
    // link) over a fresh page.goto deep-link: the browser is already logged in
    // and past Cloudflare here, but a direct goto to /history/balance gets
    // CF-challenged ~18% of the time and times out at 90s — skipping
    // verification entirely. Clicking the link routes client-side with no full
    // document load for CF to intercept (the 2026-06-23 root-vs-deeplink find).
    // Fall back to the direct goto if the link isn't present.
    let onBalancePage = false;
    try {
      const balanceLink = page
        .locator('a[href="/history/balance"], a[href$="/history/balance"], a:has-text("My Balance")')
        .first();
      if ((await balanceLink.count()) > 0) {
        await balanceLink.click({ timeout: 10000 });
        await page.waitForURL('**/history/balance', { timeout: 30000 });
        onBalancePage = true;
        logger.info('My Balance reached via SPA nav (no deep-link goto)', { jobId });
      }
    } catch (navErr) {
      logger.warn('My Balance SPA nav failed — falling back to direct goto', { jobId, error: navErr.message });
    }
    if (!onBalancePage) {
      // 90s navigation timeout — CF can re-challenge mid-session on this URL too.
      await page.goto(MY_BALANCE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    }
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {}
    await humanDelay(5000, 8000);

    // Wait for the table to load. The SPA hydrates the rows after an XHR
    // settles — observed taking 30–45s under load. Reload once before giving
    // up rather than skipping verification on a slow page.
    let tableLoaded = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 45000 });
        tableLoaded = true;
        break;
      } catch {
        if (attempt === 0) {
          logger.warn('My Balance table did not load — reloading', { jobId });
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          try {
            await page.waitForLoadState('networkidle', { timeout: 15000 });
          } catch {}
          await humanDelay(3000, 5000);
        }
      }
    }
    if (!tableLoaded) {
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
  // Crash recovery: AdsPower's daemon crashes ~25-75% during burst Play777
  // launches (Cloudflare anti-bot scripts + Chromium GPU FATAL on headless
  // VPS). Detect crash-shaped failures and retry ONCE on a fresh profile.
  // Capped at 1 to preserve the launch rate-limit window — autoloader's
  // outer 3-retry budget still applies.
  const MAX_CRASH_RETRIES = 1;
  for (let attempt = 0; attempt <= MAX_CRASH_RETRIES; attempt++) {
    const result = await loadCreditsAttempt(account, credits, parentVendor, transactionType, jobId);
    if (result.success || !isCrashError({ message: result.error || '' }) || attempt >= MAX_CRASH_RETRIES) {
      return result;
    }
    logger.warn('Play777: AdsPower crash detected, retrying once on fresh profile', {
      attempt: attempt + 1, error: result.error, account: account.username,
    });
    await new Promise((r) => setTimeout(r, 20000)); // wait for AdsPower auto-recovery
  }
}

async function loadCreditsAttempt(account, credits, parentVendor, transactionType = 'deposit', jobId = 0) {
  let session;

  const doLoad = async () => {
    session = await getBrowserContext('play777');
    const context = session.context;

    await restoreSession(context, 'play777');

    // Close any stale tabs left over from prior launches. AdsPower
    // profiles persist tabs across runs and the accumulating pile (often
    // 30+ Play777 dashboards) is itself a bot-fingerprint signal to CF
    // beyond just being a memory leak. Best-effort, never fatal.
    await pruneStaleTabs(context).catch(() => {});

    // Reuse existing page or create new one (avoids tab buildup)
    const existingPages = context.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Failed to login to Play777');

    await saveSession(context, 'play777');

    // Human-cadence dwell on /dashboard before navigating elsewhere.
    // CF's behavioral WAF treats rapid post-login navigation as bot-like;
    // 8-15s of mouse/scroll activity here significantly lowers friction
    // on the subsequent /vendors-overview and /history/balance gotos.
    await humanDwell(page).catch(() => {});

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

/**
 * Run a Play777 correction (deduct + deposits) inside ONE AdsPower
 * profile launch instead of N separate launches.
 *
 * Why this matters:
 *   - Each profile launch burns a rate-limit slot (3 per 10 min). A
 *     1-deduct-1-deposit correction used to cost 2 slots; this costs 1.
 *   - Each launch is a new CF behavioral evaluation. Staying in one
 *     session keeps cf_clearance cached and significantly reduces the
 *     mid-flow "Sorry, you have been blocked" rate.
 *   - The previous flow had a partial-success window: Step 1 succeeded
 *     on Play777 but Step 2 failed before any DB update. The
 *     correction-idempotency guard in autoloader (c377a3f) is insurance
 *     for that case; single-session is the structural fix that makes
 *     the partial-success window much smaller.
 *
 * Args:
 *   source: { username, operatorId }       — the "vendor"-type account
 *                                            (CR1234 typically). Step 1
 *                                            deducts totalCredits from here.
 *   targets: [{ account: { username, operatorId },
 *               credits,
 *               jobId }]                   — Step 2 targets. Each gets
 *                                            an independent deposit.
 *   primaryJobId                            — for logging/screenshot tagging
 *                                            on the deduct step
 *   options.skipDeduct: boolean             — when the idempotency guard
 *                                            in autoloader determines a
 *                                            prior attempt already deducted,
 *                                            skip Step 1 and only run Step 2
 *                                            (still single-session).
 *
 * Returns:
 *   {
 *     deduct: { ran, success, verified, transactionId, credits, error? },
 *     deposits: [{ jobId, account, credits, success, verified, transactionId, error? }],
 *   }
 *
 * Partial failure is normal — caller (autoloader) decides per-job pass/fail.
 * A deduct failure short-circuits deposits (we don't want to deposit
 * without a confirmed deduct).
 */
const CORRECTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — multi-step flow needs headroom

async function runCorrection(source, targets, primaryJobId = 0, options = {}) {
  const skipDeduct = !!options.skipDeduct;
  const totalDeductCredits = targets.reduce((s, t) => s + t.credits, 0);
  let session;

  const doRun = async () => {
    session = await getBrowserContext('play777');
    const context = session.context;
    await restoreSession(context, 'play777');
    await pruneStaleTabs(context).catch(() => {});

    const existingPages = context.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Failed to login to Play777');
    await saveSession(context, 'play777');
    await humanDwell(page).catch(() => {});

    const result = {
      deduct: { ran: false, success: false, verified: false, transactionId: null, credits: totalDeductCredits },
      deposits: [],
    };

    // STEP 1: deduct totalDeductCredits from the source account.
    // Skipped when the autoloader's idempotency guard determines a prior
    // attempt already succeeded on this leg.
    if (!skipDeduct) {
      result.deduct.ran = true;
      try {
        await loadVendor(page, source, totalDeductCredits, 'correction', primaryJobId);
        const v = await verifyTransaction(page, source.username, 'Correction', totalDeductCredits, primaryJobId);
        result.deduct.success = true;
        result.deduct.verified = v.verified;
        result.deduct.transactionId = v.transactionId || null;
        await saveSession(context, 'play777');
      } catch (err) {
        result.deduct.error = err.message;
        logger.error('runCorrection: Step 1 deduct failed', { source: source.username, error: err.message });
        return result; // no deposits if deduct didn't land
      }
      await humanDelay(5000, 10000); // inter-step pause
    } else {
      logger.info('runCorrection: skipDeduct=true, proceeding to deposits only', { source: source.username, credits: totalDeductCredits });
    }

    // STEP 2: deposits, one per target, all inside the same session.
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const dep = { jobId: t.jobId, account: t.account.username, credits: t.credits, success: false, verified: false, transactionId: null };
      try {
        await loadVendor(page, t.account, t.credits, 'deposit', t.jobId);
        const v = await verifyTransaction(page, t.account.username, 'Deposit', t.credits, t.jobId);
        dep.success = true;
        dep.verified = v.verified;
        dep.transactionId = v.transactionId || null;
        await saveSession(context, 'play777');
      } catch (err) {
        dep.error = err.message;
        logger.error('runCorrection: Step 2 deposit failed for target', { account: t.account.username, error: err.message });
        // Continue to next target — partial success is still useful.
      }
      result.deposits.push(dep);
      if (i < targets.length - 1) await humanDelay(5000, 10000); // inter-deposit pause
    }

    return result;
  };

  try {
    return await Promise.race([
      doRun(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Play777 correction timed out after 10 minutes')), CORRECTION_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    logger.error('Play777 runCorrection fatal', { error: err });
    return {
      deduct: { ran: !skipDeduct, success: false, error: err.message, credits: totalDeductCredits },
      deposits: targets.map((t) => ({ jobId: t.jobId, account: t.account.username, credits: t.credits, success: false, error: err.message })),
    };
  } finally {
    if (session) {
      await closeBrowser(session);
    }
  }
}

module.exports = { loadCredits, ensureLoggedIn, verifyTransaction, runCorrection };
