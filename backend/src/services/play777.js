const { getBrowserContext, closeBrowser, humanDelay, humanType, humanMouseMove } = require('./browser');
const telegram = require('./telegram');

const DASHBOARD_URL = 'https://pna.play777games.com/dashboard';
const VENDORS_URL = 'https://pna.play777games.com/vendors-overview';
const USERNAME = process.env.PLAY777_USERNAME;
const PASSWORD = process.env.PLAY777_PASSWORD;

async function ensureLoggedIn(page) {
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(2000, 4000);

  if (!page.url().includes('/login')) {
    console.log('Play777: Already logged in');
    return true;
  }

  console.log('Play777: Session expired, logging in...');
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

  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
    console.log('Play777: Login successful');
    return true;
  } catch (e) {
    const content = await page.content();
    if (content.includes('verification') || content.includes('2fa') || content.includes('code')) {
      console.log('Play777: 2FA triggered — alerting admin');
      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          '🔐 Play777 requires 2FA. Please log in manually in AdsPower and restart.'
        );
      } catch (err) {
        console.error('Failed to send 2FA alert:', err.message);
      }
      return false;
    }
    console.error('Play777: Login failed —', e.message);
    return false;
  }
}

// Fill the deposit modal and confirm.
// Modal must already be open with vendor/operator pre-filled.
// transactionType: 'deposit' (default) or 'correction'
async function fillDepositModal(page, credits, transactionType = 'deposit') {
  const form = page.locator('#app-form-agent-balance');
  await form.waitFor({ state: 'visible', timeout: 10000 });
  await humanDelay(800, 1500);

  // Switch transaction type if needed (default is Deposit)
  if (transactionType === 'correction') {
    const txTypeSelect = form.locator('.multiselect').nth(0);
    await txTypeSelect.click();
    await humanDelay(500, 1000);
    const correctionOption = form.locator('li[aria-label="Correction"]');
    await correctionOption.waitFor({ state: 'visible', timeout: 5000 });
    await correctionOption.click();
    await humanDelay(800, 1500);
  }

  // Select "Wire Transfer" from Payment Method dropdown
  // Index shifts based on transaction type dropdown position
  await humanMouseMove(page);
  const paymentMethodSelect = form.locator('.multiselect').nth(1);
  await paymentMethodSelect.click();
  await humanDelay(500, 1000);

  const wireOption = form.locator('li[aria-label="Wire Transfer"]');
  await wireOption.waitFor({ state: 'visible', timeout: 5000 });
  await wireOption.click();
  await humanDelay(800, 1500);

  // Enter credits amount
  await humanMouseMove(page);
  const creditsInput = form.locator('.input-group input[type="number"]');
  await creditsInput.waitFor({ state: 'visible', timeout: 5000 });
  await creditsInput.click();
  await humanDelay(300, 600);
  await creditsInput.fill(String(credits));
  await humanDelay(800, 1500);

  // Click "Deposit" in the modal footer to submit
  // ("Add Deposit" just adds another row for batch deposits — don't click that)
  await humanMouseMove(page);
  const modal = page.locator('.modal.show').first();
  const depositBtn = modal.locator('.modal-footer button:has-text("Deposit")');
  await depositBtn.click();
  await humanDelay(1500, 3000);

  // Confirm deposit popup
  const confirmBtn = page.locator('button:has-text("Confirm Deposit")').first();
  await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
  await humanDelay(1000, 2000);
  await confirmBtn.click();

  // Wait for success
  try {
    await page.waitForSelector('.toast-success, .alert-success, .swal2-success, [class*="success"]', { timeout: 15000 });
    return true;
  } catch {
    const modalStillOpen = await form.isVisible().catch(() => false);
    if (!modalStillOpen) return true; // Modal closed = success
    throw new Error('Deposit confirmation did not complete');
  }
}

// Load credits to a vendor account via Vendors Overview page
async function loadVendor(page, account, credits, transactionType = 'deposit') {
  // Navigate to Vendors Overview filtered to this specific vendor
  await page.goto(`${VENDORS_URL}?vendor_id=${account.operatorId}`, { waitUntil: 'networkidle', timeout: 60000 });
  await humanDelay(5000, 8000);

  // Wait for the filtered vendor row to appear
  const row = page.locator(`tr:has(a[onclick="return showAgentDrawer(${account.operatorId})"])`);
  await row.waitFor({ timeout: 30000 });
  await row.scrollIntoViewIfNeeded();
  await humanDelay(500, 1000);

  // Click $ button (index 1) on the vendor row
  const actionButtons = await row.locator('td').last().locator('button.btn-icon').all();
  console.log(`Play777: Loading ${credits} credits to vendor ${account.username} (${account.operatorId})`);
  await humanMouseMove(page);
  await actionButtons[1].click();
  await humanDelay(1500, 3000);

  await fillDepositModal(page, credits, transactionType);
  console.log(`Play777: Successfully loaded ${credits} credits to vendor ${account.username}`);
}

// Load credits to an operator under a vendor via the operators drawer
async function loadOperator(page, vendor, operator, credits, transactionType = 'deposit') {
  // Navigate to Vendors Overview filtered to this specific vendor
  await page.goto(`${VENDORS_URL}?vendor_id=${vendor.operatorId}`, { waitUntil: 'networkidle', timeout: 60000 });
  await humanDelay(5000, 8000);

  // Wait for the filtered vendor row to appear
  const vendorRow = page.locator(`tr:has(a[onclick="return showAgentDrawer(${vendor.operatorId})"])`);
  await vendorRow.waitFor({ timeout: 30000 });
  await vendorRow.scrollIntoViewIfNeeded();
  await humanDelay(500, 1000);

  const vendorButtons = await vendorRow.locator('td').last().locator('button.btn-icon').all();
  console.log(`Play777: Opening operators for vendor ${vendor.username}`);
  await humanMouseMove(page);
  await vendorButtons[4].click();
  await humanDelay(3000, 5000);

  // Find the operator row — the people icon expands an inline operators table
  // Use .last() to match the one in the expanded section, not the main vendor table
  const operatorRow = page.locator(`tr:has(a[onclick="return showAgentDrawer(${operator.operatorId})"])`).last();
  await operatorRow.waitFor({ timeout: 30000 });
  await operatorRow.scrollIntoViewIfNeeded();
  await humanDelay(500, 1000);

  // Click $ button (index 1) on the operator row
  const operatorButtons = await operatorRow.locator('td').last().locator('button.btn-icon').all();
  console.log(`Play777: Loading ${credits} credits to operator ${operator.username} (${operator.operatorId})`);
  await humanMouseMove(page);
  await operatorButtons[1].click();
  await humanDelay(1500, 3000);

  await fillDepositModal(page, credits, transactionType);
  console.log(`Play777: Successfully loaded ${credits} credits to operator ${operator.username}`);
}

// Main entry point — loads credits to a single account
// For operators, pass parentVendor with the vendor's info
// transactionType: 'deposit' (default) or 'correction'
async function loadCredits(account, credits, parentVendor, transactionType = 'deposit') {
  let session, page;

  try {
    session = await getBrowserContext('play777');
    const context = session.context;
    const pages = context.pages();
    page = pages.find((p) => p.url().includes('play777')) || await context.newPage();

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Failed to login to Play777');

    if (parentVendor) {
      // This is an operator — load via vendor's operators drawer
      await loadOperator(page, parentVendor, account, credits, transactionType);
    } else {
      // This is a vendor — load directly from Vendors Overview
      await loadVendor(page, account, credits, transactionType);
    }

    return { success: true, platform: 'PLAY777', account: account.username, credits };
  } catch (err) {
    console.error('Play777 load error:', err.message);
    return { success: false, platform: 'PLAY777', account: account.username, error: err.message };
  } finally {
    if (session) {
      await closeBrowser(session);
    }
  }
}

module.exports = { loadCredits, ensureLoggedIn };
