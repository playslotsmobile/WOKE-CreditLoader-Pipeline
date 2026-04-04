const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(__dirname, '..', '..', 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Human-like delay — randomized to look natural
function humanDelay(min = 800, max = 2500) {
  const delay = Math.floor(Math.random() * (max - min) + min);
  return new Promise((r) => setTimeout(r, delay));
}

// Type like a human — variable speed per character
async function humanType(page, selector, text) {
  await page.click(selector);
  await humanDelay(300, 600);
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 120) + 40 });
  }
}

// Get a browser context with persistent session for a platform
async function getBrowserContext(platform) {
  const sessionPath = path.join(SESSION_DIR, `${platform}-session.json`);
  const headless = process.env.HEADLESS !== 'false';

  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--lang=en-US,en',
    ],
  });

  // Load saved session if it exists
  let storageState;
  if (fs.existsSync(sessionPath)) {
    try {
      storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    } catch (e) {
      console.log(`${platform}: Invalid session file, starting fresh`);
    }
  }

  const context = await browser.newContext({
    storageState: storageState || undefined,
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });

  return { browser, context, sessionPath };
}

// Save session cookies/storage after login
async function saveSession(context, sessionPath) {
  const state = await context.storageState();
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
  console.log('Session saved.');
}

module.exports = {
  getBrowserContext,
  saveSession,
  humanDelay,
  humanType,
};
