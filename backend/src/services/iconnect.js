const { getBrowserContext, closeBrowser, humanDelay, humanType, humanMouseMove } = require('./browser');
const { restoreSession, saveSession } = require('./browserSession');
const { captureFailure } = require('./screenshot');
const { logger } = require('./logger');
const masterBalance = require('./masterBalance');

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

    // Reuse existing page if present; close any stale extras so tabs don't
    // accumulate across runs (happens when closeBrowser doesn't terminate
    // the AdsPower profile cleanly on prior failures).
    const existingPages = context.pages();
    for (const p of existingPages.slice(1)) {
      await p.close().catch(() => {});
    }
    const page = existingPages[0] || await context.newPage();
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

      // Opportunistic master balance capture — the /agent/show page has
      // "Your balance: NNN usd" in the top banner. Read it while we're here.
      try {
        const currentBalance = await masterBalance.readIconnectFromAgentShow(page);
        if (currentBalance != null) {
          await masterBalance.recordBalance('ICONNECT', currentBalance, 'opportunistic');
        }
      } catch (balanceErr) {
        logger.warn('Opportunistic iConnect balance capture failed', { error: balanceErr.message });
      }

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
