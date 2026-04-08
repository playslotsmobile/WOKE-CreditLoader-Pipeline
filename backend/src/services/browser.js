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
