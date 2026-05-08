const prisma = require('../db/client');
const telegram = require('./telegram');
const { logger } = require('./logger');

// Thresholds are in USD. Master balance tiers drive Telegram alerting and
// block-on-critical invoice gating. These numbers are set by the operator and
// should only be adjusted with explicit approval.
const THRESHOLDS = {
  INFO: 50000,
  WARN: 10000,
  CRITICAL: 2000,
};

// Master account identities per platform. Used for logging and admin alerts —
// the scrapers themselves read whatever the logged-in session's own balance is.
const MASTERS = {
  PLAY777: { label: 'Master715', operator: '1110' },
  ICONNECT: { label: 'tonydist', operator: null },
};

const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

function tierFor(balance) {
  const n = Number(balance);
  if (n <= THRESHOLDS.CRITICAL) return 'CRITICAL';
  if (n <= THRESHOLDS.WARN) return 'WARN';
  if (n <= THRESHOLDS.INFO) return 'INFO';
  return 'HEALTHY';
}

function fmt(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Scrapers ──────────────────────────────────────────────────────────────

// Play777: reads balance from the `/history/my-balance` page first row's
// balance column (cells[6]). This is the running balance after the most recent
// transaction, which equals the current master balance. Caller must already
// have the page on the my-balance URL and the table loaded.
async function readPlay777FromMyBalance(page) {
  try {
    const value = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      if (rows.length === 0) return null;
      const cells = rows[0].querySelectorAll('td');
      if (cells.length < 7) return null;
      return cells[6]?.innerText?.trim() || null;
    });
    return parseCurrency(value);
  } catch (err) {
    logger.warn('readPlay777FromMyBalance failed', { error: err.message });
    return null;
  }
}

// Play777: reads balance from the main dashboard "Current Balance" headline,
// with a fallback to the my-balance transaction history page. The dashboard
// loads the balance asynchronously and a short wait is not always enough, so
// we poll the page body for up to 10s waiting for "Current Balance" to be
// followed by an actual dollar figure. If that still fails, we fall back to
// the my-balance page whose first row contains the same value in a stable
// table cell. Used by the scheduled sweep when there's no active load
// session to piggyback on.
async function readPlay777FromDashboard(page) {
  try {
    await page.goto('https://pna.play777games.com/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    // The SPA hydrates the balance well after DOMContentLoaded. Wait for
    // network idle so the API call that populates the balance has a chance
    // to settle before we start polling.
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // Networkidle is best-effort — some pages keep long-poll connections
      // open. Polling the body still works regardless.
    }

    // Poll for up to 30s: the balance is rendered async after the label.
    // Bumped from 10s — observed dashboard loads taking 12–20s under load.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const text = await page.evaluate(() => document.body.innerText || '');
      const match = text.match(/Current Balance[^\d$-]*\$?([\d,]+\.?\d*)/i);
      if (match) {
        const n = parseCurrency(match[1]);
        if (n != null && n > 0) return n;
      }
      await page.waitForTimeout(500);
    }

    logger.warn('readPlay777FromDashboard timed out waiting for balance — falling back to my-balance page');
  } catch (err) {
    logger.warn('readPlay777FromDashboard failed', { error: err.message });
  }

  // Fallback: navigate to the my-balance page and read the running balance
  // from the first row's cells[6]. This is the same path the opportunistic
  // capture uses and is known to be reliable.
  // Two attempts: a fresh navigation can race with the SPA's table hydration,
  // so on first miss we reload and wait longer before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt === 0) {
        await page.goto('https://pna.play777games.com/history/my-balance', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
      } catch {}
      try {
        await page
          .locator('table tbody tr')
          .first()
          .waitFor({ state: 'attached', timeout: 45000 });
      } catch {
        if (attempt === 0) {
          logger.warn('readPlay777 fallback: my-balance table did not load — reloading');
          continue;
        }
        logger.warn('readPlay777 fallback: my-balance table did not load');
        return null;
      }
      await page.waitForTimeout(1500);
      return await readPlay777FromMyBalance(page);
    } catch (fbErr) {
      if (attempt === 0) {
        logger.warn('readPlay777 fallback errored — retrying once', { error: fbErr.message });
        continue;
      }
      logger.warn('readPlay777 fallback failed', { error: fbErr.message });
      return null;
    }
  }
  return null;
}

// iConnect: reads "Your balance: NNN usd" from the `/agent/show` page banner.
// Caller must already have the page logged in and on `/agent/show`.
async function readIconnectFromAgentShow(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText || '');
    const match = text.match(/Your balance[:\s]+([\d.,\s]+)\s*usd/i);
    if (!match) return null;
    return parseCurrency(match[1]);
  } catch (err) {
    logger.warn('readIconnectFromAgentShow failed', { error: err.message });
    return null;
  }
}

function parseCurrency(raw) {
  if (!raw) return null;
  // Handles "$5,803.57", "36 170.41", "5803.57", "-1,234.56", etc.
  const cleaned = String(raw).replace(/[^\d.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ── Persistence + state transition alerting ──────────────────────────────

async function getLatestBalance(platform) {
  return prisma.masterBalance.findFirst({
    where: { platform },
    orderBy: { checkedAt: 'desc' },
  });
}

// Persists a new balance reading and fires admin-only Telegram if the tier
// changed since the last reading. Returns the new row + whether block-on-critical
// logic should run.
async function recordBalance(platform, balance, source = 'opportunistic') {
  if (balance == null || !Number.isFinite(Number(balance))) {
    logger.warn('recordBalance called with invalid balance', { platform, balance });
    return null;
  }

  const previous = await getLatestBalance(platform);
  const newTier = tierFor(balance);

  const row = await prisma.masterBalance.create({
    data: {
      platform,
      balance: String(balance),
      tier: newTier,
      source,
    },
  });

  logger.info('Master balance recorded', {
    platform,
    balance,
    tier: newTier,
    source,
    previousTier: previous?.tier || null,
  });

  // Alert only on tier transitions, not every reading. This prevents spam
  // when the balance is sitting just below a threshold and drifts up/down by
  // cents within the same tier.
  if (previous && previous.tier !== newTier) {
    await sendTierTransitionAlert(platform, newTier, Number(balance), previous.tier);
  } else if (!previous && newTier !== 'HEALTHY') {
    // First-ever reading and we're already below a threshold → alert once.
    await sendTierTransitionAlert(platform, newTier, Number(balance), null);
  }

  return row;
}

async function sendTierTransitionAlert(platform, newTier, balance, previousTier) {
  const master = MASTERS[platform];
  const label = master?.label || platform;
  const platformName = platform === 'PLAY777' ? 'Play777' : 'iConnect';

  const emoji =
    newTier === 'CRITICAL' ? '🚨' :
    newTier === 'WARN' ? '⚠️' :
    newTier === 'INFO' ? '📉' :
    '✅';

  const suffix =
    newTier === 'CRITICAL' ? '\n\nNew loads are BLOCKED until refilled. Refill and the blocked invoices will auto-resume on the next scheduled check.' :
    newTier === 'WARN' ? '\n\nRefill soon — a few more loads will cross into CRITICAL.' :
    newTier === 'INFO' ? '\n\nFYI — balance is getting light. Plan a refill in the next day or two.' :
    newTier === 'HEALTHY' && previousTier && previousTier !== 'HEALTHY' ? '\n\nBack to healthy. Any blocked invoices will resume on the next sweep.' :
    '';

  const msg = `${emoji} ${platformName} master balance ${newTier}

Account: ${label}
Balance: ${fmt(balance)}
${previousTier ? `Previous tier: ${previousTier}` : 'First recorded reading'}${suffix}`;

  try {
    await telegram.bot.sendMessage(ADMIN_CHAT_ID, msg);
  } catch (err) {
    logger.error('Failed to send tier transition alert', { error: err.message, platform, newTier });
  }
}

// ── Block-on-critical gating ─────────────────────────────────────────────

// Tier-based check — retained for tier transition alerts and the auto-resume
// floor. NOT used by the webhook processor to gate individual invoices
// anymore; use canLoadInvoice() for that.
async function isCritical(platform) {
  const latest = await getLatestBalance(platform);
  if (!latest) return false;
  return latest.tier === 'CRITICAL';
}

// Credit-aware per-invoice blocking. Sums the credits needed from each
// platform (not dollars — Play777 master balance is denominated in credits,
// the "$" on the dashboard is cosmetic) and compares to the latest stored
// balance for each involved platform. Returns a structured decision with
// per-platform required vs available so the webhook processor can build an
// informative admin alert.
//
// Safety buffer: 10% headroom over the literal required amount, to absorb
// rate conversion inaccuracies and race conditions between the last balance
// reading and the actual load.
//
// Behavior: fail-open if we have NO balance reading for a platform (don't
// block the first invoice ever processed before the scheduled sweep has
// populated the table). Fail-closed once we have any reading.
async function canLoadInvoice(invoice) {
  const SAFETY_BUFFER = 1.10;

  const allocations = invoice.allocations || [];
  const perPlatform = {};
  for (const a of allocations) {
    const platform = a.vendorAccount?.platform;
    if (!platform) continue;
    if (a.credits <= 0) continue;
    perPlatform[platform] = (perPlatform[platform] || 0) + a.credits;
  }

  const checks = [];
  let canLoad = true;

  for (const [platform, requiredCredits] of Object.entries(perPlatform)) {
    const latest = await getLatestBalance(platform);
    const requiredWithBuffer = Math.ceil(requiredCredits * SAFETY_BUFFER);

    if (!latest) {
      checks.push({
        platform,
        required: requiredCredits,
        requiredWithBuffer,
        available: null,
        sufficient: true,
        reason: 'no_reading_yet',
      });
      continue;
    }

    const available = Number(latest.balance);
    const sufficient = available >= requiredWithBuffer;
    if (!sufficient) canLoad = false;

    checks.push({
      platform,
      required: requiredCredits,
      requiredWithBuffer,
      available,
      sufficient,
      tier: latest.tier,
      lastCheckedAt: latest.checkedAt,
      reason: sufficient ? 'ok' : 'insufficient',
    });
  }

  return { canLoad, checks };
}

// ── Auto-resume ──────────────────────────────────────────────────────────

// Called by the scheduled sweep after a new reading is recorded. If the
// latest reading shows sufficient credits to cover a previously-blocked
// invoice, flip it back to PAID and requeue into the autoloader. Uses the
// same credit-aware check as the webhook blocker, so an invoice only
// auto-resumes when we actually have enough credits for it — not just when
// the tier crosses some arbitrary threshold.
async function maybeAutoResume(platform) {
  const latest = await getLatestBalance(platform);
  if (!latest) return { resumed: 0 };

  // Lazy-require to avoid a circular dep (autoloader → masterBalance → autoloader).
  const autoloader = require('./autoloader');

  const blocked = await prisma.invoice.findMany({
    where: { status: 'BLOCKED_LOW_MASTER' },
    include: { vendor: true, allocations: { include: { vendorAccount: true } } },
    orderBy: { submittedAt: 'asc' },
  });

  const toResume = [];
  for (const inv of blocked) {
    // Check if this invoice involves the platform we just got a reading for.
    const platforms = new Set(
      inv.allocations
        .filter((a) => a.credits > 0)
        .map((a) => a.vendorAccount?.platform)
        .filter(Boolean)
    );
    if (!platforms.has(platform)) continue;

    // Credit-aware check: only resume if current balance actually covers the
    // invoice's credit requirement (with safety buffer). This is the same
    // check the webhook uses to block, so an invoice resumes precisely when
    // it would no longer be blocked.
    const decision = await canLoadInvoice(inv);
    if (decision.canLoad) toResume.push(inv);
  }

  if (toResume.length === 0) return { resumed: 0 };

  for (const inv of toResume) {
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { status: 'PAID' },
    });
    autoloader.processInvoice(inv.id).catch((err) => {
      logger.error('Auto-resume autoloader failed', { invoiceId: inv.id, error: err.message });
    });
    logger.info('Auto-resumed blocked invoice', { invoiceId: inv.id, vendorId: inv.vendorId });
  }

  try {
    const lines = toResume
      .map((i) => `• #${i.id} — ${i.vendor.name} — ${fmt(i.totalAmount)}`)
      .join('\n');
    await telegram.bot.sendMessage(
      ADMIN_CHAT_ID,
      `▶️ Auto-resumed ${toResume.length} blocked invoice${toResume.length === 1 ? '' : 's'} (${platform} back above critical)\n\n${lines}`
    );
  } catch {}

  return { resumed: toResume.length, invoiceIds: toResume.map((i) => i.id) };
}

// ── History (for dashboard card + digest) ────────────────────────────────

async function getRecentHistory(platform, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return prisma.masterBalance.findMany({
    where: { platform, checkedAt: { gte: since } },
    orderBy: { checkedAt: 'asc' },
  });
}

// ── Scheduled sweep ──────────────────────────────────────────────────────

// Opens a browser session for each platform, reads the current master balance,
// records it, and fires auto-resume if applicable. Sequential (not parallel)
// to respect the Play777 rate limit and avoid AdsPower profile contention with
// a concurrent autoload.
// Retry wrapper for sweeps. AdsPower CDP drops mid-flow have ~30% per-attempt
// failure rate observed in live testing; without retry, a transient blip means
// stale balance data for the full 2h until the next scheduled sweep, which
// breaks BLOCKED_LOW_MASTER gating. Two attempts with a 30s backoff covers
// the typical drop without busting the Play777 portal rate-limit window.
async function withSweepRetry(name, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fn();
      if (result != null) return result;
      logger.warn(`${name} sweep returned null`, { attempt });
    } catch (err) {
      logger.error(`${name} sweep failed`, { attempt, error: err.message });
    }
    if (attempt === 1) {
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
  return null;
}

async function runScheduledSweep() {
  const results = { play777: null, iconnect: null };
  results.play777 = await withSweepRetry('Play777', sweepPlay777);
  results.iconnect = await withSweepRetry('iConnect', sweepIconnect);

  // Auto-resume check happens after both sweeps so blocked invoices with
  // allocations on both platforms can resume in one pass.
  try {
    await maybeAutoResume('PLAY777');
    await maybeAutoResume('ICONNECT');
  } catch (err) {
    logger.error('Auto-resume check failed', { error: err.message });
  }

  return results;
}

async function sweepPlay777() {
  // Lazy-require to avoid pulling the browser/playwright chain at module load.
  const { getBrowserContext, closeBrowser, humanDelay } = require('./browser');
  const { restoreSession, saveSession } = require('./browserSession');
  const play777 = require('./play777');

  let session;
  try {
    session = await getBrowserContext('play777');
    await restoreSession(session.context, 'play777');

    const pages = session.context.pages();
    const page = pages.length > 0 ? pages[0] : await session.context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    await play777.ensureLoggedIn(page);
    await saveSession(session.context, 'play777');

    const balance = await readPlay777FromDashboard(page);
    if (balance == null) {
      logger.warn('Play777 scheduled sweep: could not read balance');
      return null;
    }

    await recordBalance('PLAY777', balance, 'scheduled');
    return balance;
  } finally {
    if (session) await closeBrowser(session);
  }
}

async function sweepIconnect() {
  const { getBrowserContext, closeBrowser } = require('./browser');
  const { restoreSession, saveSession } = require('./browserSession');
  const iconnect = require('./iconnect');

  let session;
  try {
    session = await getBrowserContext('iconnect');
    await restoreSession(session.context, 'iconnect');

    const existingPages = session.context.pages();
    for (const p of existingPages.slice(1)) {
      await p.close().catch(() => {});
    }
    const page = existingPages[0] || await session.context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    await iconnect.ensureLoggedIn(page);
    await saveSession(session.context, 'iconnect');

    if (!page.url().includes('/agent/show')) {
      await page.goto('https://river-pay.com/agent/show', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(2000);
    }

    const balance = await readIconnectFromAgentShow(page);
    if (balance == null) {
      logger.warn('iConnect scheduled sweep: could not read balance');
      return null;
    }

    await recordBalance('ICONNECT', balance, 'scheduled');
    return balance;
  } finally {
    if (session) await closeBrowser(session);
  }
}

async function getSnapshot() {
  const [p777, iconnect] = await Promise.all([
    getLatestBalance('PLAY777'),
    getLatestBalance('ICONNECT'),
  ]);
  return {
    play777: p777 ? { balance: Number(p777.balance), tier: p777.tier, checkedAt: p777.checkedAt } : null,
    iconnect: iconnect ? { balance: Number(iconnect.balance), tier: iconnect.tier, checkedAt: iconnect.checkedAt } : null,
    thresholds: THRESHOLDS,
  };
}

module.exports = {
  THRESHOLDS,
  MASTERS,
  tierFor,
  parseCurrency,
  readPlay777FromMyBalance,
  readPlay777FromDashboard,
  readIconnectFromAgentShow,
  recordBalance,
  getLatestBalance,
  isCritical,
  canLoadInvoice,
  maybeAutoResume,
  runScheduledSweep,
  sweepPlay777,
  sweepIconnect,
  getRecentHistory,
  getSnapshot,
};
