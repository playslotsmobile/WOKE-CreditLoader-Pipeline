const { chromium } = require('playwright');
const { logger } = require('./logger');

// AdsPower API config
const ADSPOWER_API = process.env.ADSPOWER_API_URL || 'http://127.0.0.1:50325';
const ADSPOWER_TOKEN = process.env.ADSPOWER_API_KEY;

// AdsPower profile IDs per platform
const PROFILE_IDS = {
  play777: process.env.ADSPOWER_PLAY777_ID,
  iconnect: process.env.ADSPOWER_ICONNECT_ID,
};

// Rate limiter — track launches per platform
const launchHistory = {};
const MAX_LAUNCHES = 3;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Inter-launch minimum cooldown per platform. AdsPower's Electron daemon
// crashes more often when profiles are spawned in rapid succession (observed
// ~75% failure rate at 3 launches in 6 min vs ~0% at 1 launch per hour).
const MIN_INTERLAUNCH_MS = {
  play777: 60 * 1000,   // Play777 has Cloudflare anti-bot scripts that may
                        // crash the renderer; give it space.
  iconnect: 30 * 1000,  // iConnect is more forgiving.
};
const lastLaunchAt = {};

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

async function enforceInterlaunchCooldown(platform) {
  const min = MIN_INTERLAUNCH_MS[platform];
  if (!min) return;
  const last = lastLaunchAt[platform];
  if (!last) return;
  const elapsed = Date.now() - last;
  if (elapsed < min) {
    const waitMs = min - elapsed;
    logger.info('Inter-launch cooldown', { platform, waitMs });
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Returns true if an error message looks like an AdsPower / Chromium crash
// rather than a logic / selector failure. Used by callers to decide whether
// a retry on a freshly-launched profile is worth attempting.
function isCrashError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  return (
    msg.includes('target page, context or browser has been closed') ||
    msg.includes('browser has been closed') ||
    msg.includes('target closed') ||
    msg.includes('browserdisconnected') ||
    msg.includes('connection closed') ||
    msg.includes('failed to start adspower profile') ||
    msg.includes('adspower is not responding')
  );
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

// Check if AdsPower API is responsive
async function checkAdsPowerHealth() {
  try {
    const res = await fetch(`${ADSPOWER_API}/api/v1/user/list?page_size=1`, {
      headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return data.code === 0;
  } catch {
    return false;
  }
}

// Try to restart AdsPower via systemd
async function restartAdsPower() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('systemctl restart adspower', (err) => {
      if (err) {
        logger.error('Failed to restart AdsPower service', { error: err });
        resolve(false);
      } else {
        logger.info('AdsPower service restarted');
        resolve(true);
      }
    });
  });
}

// Launch an AdsPower profile with auto-recovery
async function getBrowserContext(platform) {
  const profileId = PROFILE_IDS[platform];
  if (!profileId) {
    throw new Error(`No AdsPower profile ID configured for platform: ${platform}. Set ADSPOWER_${platform.toUpperCase()}_ID in .env`);
  }

  checkRateLimit(platform);
  await enforceInterlaunchCooldown(platform);
  lastLaunchAt[platform] = Date.now();

  // Health check — try to recover if AdsPower is down
  let healthy = await checkAdsPowerHealth();
  if (!healthy) {
    logger.warn('AdsPower API unreachable — attempting recovery', { platform });

    // Try 1: restart the service
    await restartAdsPower();
    await new Promise((r) => setTimeout(r, 15000)); // Wait 15s for startup
    healthy = await checkAdsPowerHealth();

    if (!healthy) {
      throw new Error('AdsPower is not responding after restart attempt');
    }
    logger.info('AdsPower recovered after restart');
  }

  // Stop any lingering instance of this profile
  try {
    await fetch(`${ADSPOWER_API}/api/v1/browser/stop?user_id=${profileId}`, {
      headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
    });
    await new Promise((r) => setTimeout(r, 2000));
  } catch {}

  // Start the profile
  const launchArgs = encodeURIComponent(JSON.stringify([
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--js-flags=--max-old-space-size=512',
  ]));
  const startUrl = `${ADSPOWER_API}/api/v1/browser/start?user_id=${profileId}&launch_args=${launchArgs}`;

  let data;
  try {
    const res = await fetch(startUrl, {
      headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
    });
    data = await res.json();
  } catch (err) {
    throw new Error(`Failed to start AdsPower profile: ${err.message}`);
  }

  if (data.code !== 0) {
    // Retry once after a brief wait
    logger.warn('AdsPower profile start failed, retrying', { platform, msg: data.msg });
    await new Promise((r) => setTimeout(r, 5000));

    try {
      const res = await fetch(startUrl, {
        headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
      });
      data = await res.json();
    } catch (err) {
      throw new Error(`Failed to start AdsPower profile on retry: ${err.message}`);
    }

    if (data.code !== 0) {
      throw new Error(`AdsPower failed to start profile after retry: ${data.msg}`);
    }
  }

  const debugPort = data.data.debug_port;
  logger.info('AdsPower profile launched', { platform, debugPort });

  // Connect Playwright via CDP. Bump timeout to 120s because AdsPower
  // profiles with many stale tabs can take a while to enumerate all
  // CDP targets on initial connection.
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 120000 });
  const context = browser.contexts()[0];

  return { browser, context, profileId, platform };
}

// Close the AdsPower browser profile
async function closeBrowser(session) {
  if (session.profileId) {
    try {
      const stopUrl = `${ADSPOWER_API}/api/v1/browser/stop?user_id=${session.profileId}`;
      await fetch(stopUrl, {
        headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
      });
      logger.info('AdsPower profile closed', { platform: session.platform });
    } catch (err) {
      logger.error('Failed to close AdsPower profile', { error: err });
    }
  }
}

/**
 * Run an operation that needs a fresh browser context, and recover ONCE if
 * the underlying AdsPower profile / Chromium process crashes mid-flow
 * ("Target page closed", "browser has been closed", etc).
 *
 * Use:  withBrowserRecovery('play777', async (session) => { ...page work... })
 *
 * The wrapper handles getBrowserContext + closeBrowser bookkeeping itself, so
 * the inner fn is just the work. On a crash-shaped error, it waits 15s for
 * AdsPower's auto-recovery (browser.js already restarts the systemd unit on
 * checkAdsPowerHealth failure), then retries with a fresh profile launch.
 *
 * Caps recovery at ONE retry to avoid burning the rate-limit window. Real
 * persistent failures still propagate so the autoloader's outer retry can
 * decide whether to back off harder.
 */
async function withBrowserRecovery(platform, fn) {
  let session;
  try {
    session = await getBrowserContext(platform);
    return await fn(session);
  } catch (err) {
    if (!isCrashError(err)) throw err;
    logger.warn('Browser crash detected — attempting one recovery retry', {
      platform, error: err.message,
    });
    if (session) {
      try { await closeBrowser(session); } catch {}
      session = null;
    }
    // Wait for AdsPower's restart-on-recovery path inside getBrowserContext.
    await new Promise((r) => setTimeout(r, 15000));
    session = await getBrowserContext(platform);
    return await fn(session);
  } finally {
    if (session) {
      try { await closeBrowser(session); } catch {}
    }
  }
}

/**
 * Close all pages in the context except the first one. AdsPower profiles
 * persist tabs across launches; without periodic pruning a long-running
 * profile accumulates dozens of stale tabs from prior runs. Beyond memory
 * waste, a 30+ tab pile pointing at the same automated origin is a strong
 * bot-fingerprint signal to Cloudflare's behavioral models — observed on
 * 2026-05-16 contributing to mid-session "Sorry, you have been blocked"
 * pages even on a clean residential IP.
 *
 * Best-effort: a stuck page that won't close is logged but does not throw.
 * Returns the count of pages closed.
 */
async function pruneStaleTabs(context) {
  const pages = context.pages();
  if (pages.length <= 1) return 0;
  let closed = 0;
  for (let i = 1; i < pages.length; i++) {
    try {
      await pages[i].close({ runBeforeUnload: false });
      closed++;
    } catch (err) {
      // Stuck tabs aren't worth failing the load over.
      logger.warn('pruneStaleTabs: failed to close a stale tab', { index: i, error: err.message });
    }
  }
  if (closed > 0) {
    logger.info('Pruned stale tabs', { closed, remaining: 1 });
  }
  return closed;
}

/**
 * Sit on the current page for a randomized interval, simulating human
 * "looking at the page" behavior: tiny mouse movements + a small scroll.
 * Cloudflare's behavioral WAF rewards this kind of pre-navigation idle
 * with a lower friction score on subsequent gotos in the same session.
 *
 * Default range tuned to 8-15s based on observed CF challenge cadence
 * (long enough to be classified as a human reading the page, short enough
 * that total load latency stays acceptable).
 */
async function humanDwell(page, minMs = 8000, maxMs = 15000) {
  const total = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  const endAt = Date.now() + total;
  while (Date.now() < endAt) {
    try {
      const x = 200 + Math.floor(Math.random() * 800);
      const y = 200 + Math.floor(Math.random() * 400);
      await page.mouse.move(x, y, { steps: 3 + Math.floor(Math.random() * 5) });
      if (Math.random() < 0.4) {
        const dy = Math.floor(Math.random() * 160) - 40;
        await page.mouse.wheel(0, dy);
      }
    } catch {
      // Page may be navigating; that's fine, just exit early.
      return;
    }
    await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1800)));
  }
}

module.exports = {
  getBrowserContext,
  closeBrowser,
  humanDelay,
  humanType,
  humanMouseMove,
  humanDwell,
  pruneStaleTabs,
  checkAdsPowerHealth,
  isCrashError,
  withBrowserRecovery,
};
