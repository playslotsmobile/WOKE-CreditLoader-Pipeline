const { getBrowserContext, saveSession, humanDelay, humanType } = require('./browser');
const telegram = require('./telegram');

const LOGIN_URL = process.env.ICONNECT_URL || 'https://river-pay.com';
const USERNAME = process.env.ICONNECT_USERNAME;
const PASSWORD = process.env.ICONNECT_PASSWORD;

async function ensureLoggedIn(page, context, sessionPath) {
  // Navigate to the login page
  await page.goto(LOGIN_URL + '/office/login', { waitUntil: 'networkidle', timeout: 30000 });
  await humanDelay(1500, 3000);

  const url = page.url();

  // If redirected away from login, we're already in
  if (!url.includes('/login')) {
    console.log('IConnect: Already logged in (session valid)');
    return true;
  }

  console.log('IConnect: Session expired, logging in...');

  // Fill login form
  await humanDelay(500, 1200);
  await humanType(page, '#LoginForm_login', USERNAME);
  await humanDelay(400, 900);
  await humanType(page, '#LoginForm_password', PASSWORD);
  await humanDelay(500, 1000);

  // Submit
  await page.click('input[type="submit"][name="yt0"]');

  // Wait for navigation away from login
  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
    console.log('IConnect: Login successful');
    await saveSession(context, sessionPath);
    return true;
  } catch (e) {
    console.error('IConnect: Login failed —', e.message);
    return false;
  }
}

// Load credits to a vendor account
async function loadCredits(account, credits) {
  let browser, context, page;

  try {
    const session = await getBrowserContext('iconnect');
    browser = session.browser;
    context = session.context;
    page = await context.newPage();

    // Login
    const loggedIn = await ensureLoggedIn(page, context, session.sessionPath);
    if (!loggedIn) {
      throw new Error('Failed to login to IConnect');
    }

    await humanDelay(2000, 4000);

    // TODO: Navigate to vendor credit loading UI
    // Need screenshots of the post-login IConnect dashboard to build this.
    // The flow will be:
    // 1. Navigate to vendor/distributor management page
    // 2. Search for vendor by username
    // 3. Click on the vendor
    // 4. Enter credit amount
    // 5. Confirm the load

    console.log(`IConnect: Would load ${credits} credits to ${account.username}`);

    // Placeholder — return success for now
    return { success: true, platform: 'ICONNECT', account: account.username, credits };
  } catch (err) {
    console.error('IConnect load error:', err.message);
    return { success: false, platform: 'ICONNECT', account: account.username, error: err.message };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = { loadCredits, ensureLoggedIn };
