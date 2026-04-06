const { getBrowserContext, closeBrowser, humanDelay, humanType, humanMouseMove } = require('./browser');

const SHOP_URL = 'https://river-pay.com/agent/show';
const LOGIN_URL = 'https://river-pay.com/office/login';
const USERNAME = process.env.ICONNECT_USERNAME;
const PASSWORD = process.env.ICONNECT_PASSWORD;

async function ensureLoggedIn(page) {
  await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(2000, 4000);

  if (!page.url().includes('/login')) {
    console.log('IConnect: Already logged in');
    return true;
  }

  console.log('IConnect: Session expired, logging in...');
  await humanDelay(500, 1200);
  await humanType(page, '#LoginForm_login', USERNAME);
  await humanDelay(400, 900);
  await humanType(page, '#LoginForm_password', PASSWORD);
  await humanDelay(500, 1000);

  await page.click('input[type="submit"][name="yt0"]');

  try {
    await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
    console.log('IConnect: Login successful');
    return true;
  } catch (e) {
    console.error('IConnect: Login failed —', e.message);
    return false;
  }
}

// Load credits to a shop account
async function loadCredits(account, credits) {
  let session, page;

  try {
    session = await getBrowserContext('iconnect');
    const context = session.context;
    // Always use a fresh page to avoid stale state
    page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Failed to login to IConnect');

    await humanDelay(2000, 4000);

    // Ensure we're on the shops page
    if (!page.url().includes('/agent/show')) {
      await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await humanDelay(2000, 4000);
    }

    console.log(`IConnect: Loading ${credits} credits to ${account.username}`);

    // Find the row with this username and extract the Deposit button's onclick params
    const depositBtn = page.locator(`button[onclick*="'${account.username}'"]`);
    const btnCount = await depositBtn.count();
    if (btnCount === 0) {
      throw new Error(`User "${account.username}" not found in IConnect table`);
    }

    // Extract the agent ID and other params from the onclick attribute
    const onclick = await depositBtn.first().getAttribute('onclick');
    const match = onclick.match(/initDepositModal\(\s*'(\d+)',\s*'([^']+)',\s*'(\d+)',\s*'([^']+)'/);
    if (!match) {
      throw new Error('Could not parse deposit button onclick params');
    }

    const [, agentId, login, parentId, balance] = match;
    console.log(`IConnect: Agent ${login} (ID: ${agentId}), balance: ${balance}`);

    // Open the deposit modal via JS and show it
    await humanMouseMove(page);
    await humanDelay(500, 1200);
    await page.evaluate(({ agentId, login, parentId, balance }) => {
      initDepositModal(agentId, login, parentId, balance);
      // Trigger Bootstrap modal show in case initDepositModal doesn't do it
      $('#modal-deposite').modal('show');
    }, { agentId, login, parentId, balance });
    await humanDelay(1500, 3000);

    // Wait for modal to be visible
    await page.waitForSelector('#modal-deposite.in, #modal-deposite.show', { state: 'visible', timeout: 10000 });
    await humanDelay(800, 1500);

    // Enter amount — use evaluate to fill directly since click can timeout on modal overlays
    await humanDelay(500, 1000);
    await page.evaluate((credits) => {
      const input = document.getElementById('modal-deposite-amount');
      input.value = credits;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(credits));
    await humanDelay(800, 1500);

    // Click Apply — form submits and page reloads
    await Promise.all([
      page.waitForURL('**/agent/show**', { timeout: 30000 }),
      page.evaluate(() => {
        document.querySelector('#modal-deposite input[type="submit"][value="Apply"]').click();
      }),
    ]);

    await humanDelay(2000, 4000);

    if (page.url().includes('/agent/show')) {
      console.log(`IConnect: Successfully loaded ${credits} credits to ${account.username}`);
      return { success: true, platform: 'ICONNECT', account: account.username, credits };
    } else {
      throw new Error('Page did not return to /agent/show after deposit');
    }
  } catch (err) {
    console.error('IConnect load error:', err.message);
    return { success: false, platform: 'ICONNECT', account: account.username, error: err.message };
  } finally {
    if (session) {
      await closeBrowser(session);
    }
  }
}

module.exports = { loadCredits, ensureLoggedIn };
