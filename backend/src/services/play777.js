const { getBrowserContext, saveSession, humanDelay, humanType } = require('./browser');
const telegram = require('./telegram');

const LOGIN_URL = process.env.PLAY777_URL || 'https://pna.play777games.com/login';
const USERNAME = process.env.PLAY777_USERNAME;
const PASSWORD = process.env.PLAY777_PASSWORD;

async function ensureLoggedIn(page, context, sessionPath) {
  // Check if we're already logged in by looking for a dashboard element
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await humanDelay(1500, 3000);

  const url = page.url();

  // If we're not on the login page, we're already logged in
  if (!url.includes('/login')) {
    console.log('Play777: Already logged in (session valid)');
    return true;
  }

  console.log('Play777: Session expired, logging in...');

  // Fill login form with human-like behavior
  await humanDelay(500, 1200);
  await humanType(page, 'input[name="username"]', USERNAME);
  await humanDelay(400, 900);
  await humanType(page, 'input[name="password"]', PASSWORD);
  await humanDelay(300, 800);

  // Check "Trust this device"
  const trustCheckbox = page.locator('input[name="remember"]');
  if (await trustCheckbox.isVisible()) {
    const isChecked = await trustCheckbox.isChecked();
    if (!isChecked) {
      await trustCheckbox.click();
      await humanDelay(200, 500);
    }
  }

  // Click sign in
  await humanDelay(500, 1000);
  await page.click('button.btn.btn-primary');

  // Wait for navigation
  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
    console.log('Play777: Login successful');
    await saveSession(context, sessionPath);
    return true;
  } catch (e) {
    // Check if 2FA was triggered
    const pageContent = await page.content();
    if (pageContent.includes('verification') || pageContent.includes('2fa') || pageContent.includes('code')) {
      console.log('Play777: 2FA triggered — alerting admin');
      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          '🔐 Play777 requires 2FA verification. Please complete login manually and restart the loader.'
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

// Load credits to a vendor/operator account
async function loadCredits(account, credits) {
  let browser, context, page;

  try {
    const session = await getBrowserContext('play777');
    browser = session.browser;
    context = session.context;
    page = await context.newPage();

    // Login
    const loggedIn = await ensureLoggedIn(page, context, session.sessionPath);
    if (!loggedIn) {
      throw new Error('Failed to login to Play777');
    }

    await humanDelay(2000, 4000);

    // TODO: Navigate to vendor/operator credit loading UI
    // This requires knowing the post-login UI structure.
    // The flow will be:
    // 1. Navigate to vendor management / credit loading page
    // 2. Search for vendor by operator ID
    // 3. Click on the vendor/operator
    // 4. Enter credit amount
    // 5. Confirm the load
    //
    // For chained loads (operator under vendor):
    // 1. Navigate to vendor (parentOperatorId)
    // 2. Impersonate/sub-login
    // 3. Navigate to operator
    // 4. Load credits
    //
    // Need screenshots of the post-login UI to build this.

    console.log(`Play777: Would load ${credits} credits to ${account.username} (${account.operatorId})`);

    // Placeholder — return success for now
    return { success: true, platform: 'PLAY777', account: account.username, credits };
  } catch (err) {
    console.error('Play777 load error:', err.message);
    return { success: false, platform: 'PLAY777', account: account.username, error: err.message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { loadCredits, ensureLoggedIn };
