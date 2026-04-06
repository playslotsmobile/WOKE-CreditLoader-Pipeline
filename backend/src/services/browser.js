const { chromium } = require('playwright');
const path = require('path');

// AdsPower API config
const ADSPOWER_API = 'http://local.adspower.net:50325';
const ADSPOWER_TOKEN = process.env.ADSPOWER_API_KEY;

// AdsPower profile IDs per platform
const PROFILE_IDS = {
  play777: process.env.ADSPOWER_PLAY777_ID,
  iconnect: process.env.ADSPOWER_ICONNECT_ID,
};

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

// Simulate subtle mouse movement — real users don't teleport between clicks
async function humanMouseMove(page) {
  const x = 200 + Math.floor(Math.random() * 800);
  const y = 150 + Math.floor(Math.random() * 400);
  await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
}

// Launch an AdsPower profile and connect Playwright to it
async function getBrowserContext(platform) {
  const profileId = PROFILE_IDS[platform];
  if (!profileId) {
    throw new Error(`No AdsPower profile ID configured for platform: ${platform}. Set ADSPOWER_${platform.toUpperCase()}_ID in .env`);
  }

  // Start the AdsPower browser profile with memory-saving flags
  const launchArgs = encodeURIComponent(JSON.stringify([
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=512',
  ]));
  const startUrl = `${ADSPOWER_API}/api/v1/browser/start?user_id=${profileId}&launch_args=${launchArgs}`;
  const res = await fetch(startUrl, {
    headers: { 'Authorization': `Bearer ${ADSPOWER_TOKEN}` },
  });
  const data = await res.json();

  if (data.code !== 0) {
    throw new Error(`AdsPower failed to start profile: ${data.msg}`);
  }

  const wsUrl = data.data.ws.puppeteer;
  const debugPort = data.data.debug_port;
  console.log(`${platform}: AdsPower profile launched (port ${debugPort})`);

  // Connect Playwright via CDP
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];

  return { browser, context, profileId, debugPort };
}

// Close the AdsPower browser profile
async function closeBrowser(session) {
  if (session.profileId) {
    const stopUrl = `${ADSPOWER_API}/api/v1/browser/stop?user_id=${session.profileId}`;
    await fetch(stopUrl, {
      headers: { 'Authorization': `Bearer ${ADSPOWER_TOKEN}` },
    }).catch(() => {});
    console.log('AdsPower profile closed.');
  }
}

// No-op — AdsPower handles session persistence automatically
async function saveSession() {}

module.exports = {
  getBrowserContext,
  closeBrowser,
  saveSession,
  humanDelay,
  humanType,
  humanMouseMove,
};
