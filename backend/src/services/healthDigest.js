const prisma = require('../db/client');
const telegram = require('./telegram');
const masterBalance = require('./masterBalance');
const { logger } = require('./logger');

const log = logger.child({ service: 'healthDigest' });

function fmtUsd(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tierEmoji(tier) {
  return tier === 'HEALTHY' ? '✅' :
         tier === 'INFO' ? '📉' :
         tier === 'WARN' ? '⚠️' :
         tier === 'CRITICAL' ? '🚨' : '❓';
}

const ADSPOWER_API = process.env.ADSPOWER_API_URL || 'http://127.0.0.1:50325';
const ADSPOWER_TOKEN = process.env.ADSPOWER_API_KEY;

async function sendDailyDigest() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const loaded = await prisma.invoice.count({ where: { status: 'LOADED', loadedAt: { gte: since } } });
    const failed = await prisma.invoice.count({ where: { status: 'FAILED', submittedAt: { gte: since } } });
    const stuckLoading = await prisma.invoice.count({ where: { status: 'LOADING' } });
    const stuckRequested = await prisma.invoice.count({ where: { status: 'REQUESTED' } });

    let adspowerOk = false;
    try {
      const res = await fetch(`${ADSPOWER_API}/api/v1/user/list?page_size=1`, {
        headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      adspowerOk = data.code === 0;
    } catch {}

    // Count AdsPower daemon crashes in the last 24h via journalctl. The
    // crash signature is "GPU process isn't usable. Goodbye." which the
    // adspower systemd unit logs whenever its Electron daemon dies.
    // Healthy baseline: ~1 crash/week. Alert if > 5 in 24h.
    let adspowerCrashes24h = null;
    try {
      const { execSync } = require('child_process');
      const out = execSync(
        `journalctl -u adspower --since "24 hours ago" --no-pager | grep -c "GPU process isn.t usable" || true`,
        { encoding: 'utf8', timeout: 5000 }
      );
      adspowerCrashes24h = parseInt(out.trim(), 10);
    } catch (e) {
      // journalctl not available or permission denied — fine, just skip.
    }

    const quickbooks = require('./quickbooks');
    let qbOk = false;
    try {
      await quickbooks.qbRequest('GET', 'query?query=SELECT * FROM CompanyInfo');
      qbOk = true;
    } catch {}

    const failedWebhooks = await prisma.webhookEvent.count({ where: { status: 'FAILED' } });
    const blockedLowMaster = await prisma.invoice.count({ where: { status: 'BLOCKED_LOW_MASTER' } });

    const snapshot = await masterBalance.getSnapshot();
    const p777Line = snapshot.play777
      ? `${tierEmoji(snapshot.play777.tier)} Play777 (Master715): ${fmtUsd(snapshot.play777.balance)} — ${snapshot.play777.tier}`
      : '❓ Play777: no reading yet';
    const iconnectLine = snapshot.iconnect
      ? `${tierEmoji(snapshot.iconnect.tier)} iConnect (tonydist): ${fmtUsd(snapshot.iconnect.balance)} — ${snapshot.iconnect.tier}`
      : '❓ iConnect: no reading yet';

    const msg = `📊 Daily Health Digest

Invoices (24h):
✅ Loaded: ${loaded}
❌ Failed: ${failed}
${blockedLowMaster > 0 ? `⛔ Blocked (low master): ${blockedLowMaster}\n` : ''}
Stuck:
⏳ LOADING: ${stuckLoading}
📋 REQUESTED: ${stuckRequested}

Master Balances:
${p777Line}
${iconnectLine}

Infrastructure:
${adspowerOk ? '✅' : '❌'} AdsPower API
${adspowerCrashes24h == null
  ? ''
  : adspowerCrashes24h === 0
  ? '✅ AdsPower daemon stable (0 crashes 24h)\n'
  : adspowerCrashes24h <= 2
  ? `📉 AdsPower: ${adspowerCrashes24h} crash(es) 24h\n`
  : `⚠️ AdsPower: ${adspowerCrashes24h} crashes in 24h — investigate\n`}${qbOk ? '✅ QB Token: OK' : '⚠️ QB Token: EXPIRED — manual reauth required'}
${failedWebhooks > 0 ? `⚠️ ${failedWebhooks} failed webhooks` : '✅ Webhooks OK'}

⏰ ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}`;

    await telegram.bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
    log.info('Daily digest sent');

    await reconcileQBPayments(since);
  } catch (err) {
    log.error('Daily digest failed', { error: err });
  }
}

async function reconcileQBPayments(since) {
  try {
    const quickbooks = require('./quickbooks');
    const sinceStr = since.toISOString().split('T')[0];
    // Date string from toISOString().split('T')[0] is always YYYY-MM-DD; assert
    // shape as defense-in-depth in case the input source ever changes.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceStr)) {
      throw new Error(`reconcileQBPayments: invalid date string ${sinceStr}`);
    }
    const data = await quickbooks.qbRequest(
      'GET',
      `query?query=SELECT * FROM Payment WHERE TxnDate >= '${sinceStr}'`
    );
    const payments = data.QueryResponse?.Payment || [];

    for (const payment of payments) {
      const paymentId = String(payment.Id);
      // findFirst (not findUnique) since the unique was relaxed from
      // paymentId alone to (paymentId, invoiceId) in Deploy 3 — for
      // reconciliation we just want to know if this payment was processed
      // for ANY invoice.
      const processed = await prisma.processedWebhook.findFirst({
        where: { paymentId },
      });
      if (!processed) {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ Unprocessed QB Payment\n\nPayment ID: ${paymentId}\nAmount: $${payment.TotalAmt}\nDate: ${payment.TxnDate}\n\nThis payment was not processed via webhook. Manual review needed.`
        );
        log.warn('Unprocessed QB payment found', { paymentId, amount: payment.TotalAmt });
      }
    }
  } catch (err) {
    log.error('QB reconciliation failed', { error: err });
  }
}

// Track which invoices already got a stale alert so we don't spam
const alertedStaleInvoices = new Set();

async function checkStaleLoads() {
  try {
    // Only alert if stuck in LOADING for 15+ minutes since paidAt (not submittedAt)
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    const stale = await prisma.invoice.findMany({
      where: { status: 'LOADING', paidAt: { lt: fifteenMinAgo } },
      include: { vendor: true },
    });

    for (const inv of stale) {
      // Skip if we already alerted for this invoice
      if (alertedStaleInvoices.has(inv.id)) continue;
      alertedStaleInvoices.add(inv.id);

      const mins = Math.floor((Date.now() - new Date(inv.paidAt).getTime()) / 60000);
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ Stale Load Detected\n\nInvoice #${inv.id} (${inv.vendor.name}) has been LOADING for ${mins} minutes since payment. Possible hung process.`
      );
      log.warn('Stale load detected', { invoiceId: inv.id, minutes: mins });
    }

    // Clean up alerts for invoices no longer stuck
    for (const id of alertedStaleInvoices) {
      const inv = await prisma.invoice.findUnique({ where: { id } });
      if (!inv || inv.status !== 'LOADING') {
        alertedStaleInvoices.delete(id);
      }
    }
  } catch (err) {
    log.error('Stale load check failed', { error: err });
  }
}

function startHealthChecks() {
  // Daily digest at 8:00 AM CDT (13:00 UTC)
  const scheduleDigest = () => {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(13, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target.getTime() - now.getTime();
    setTimeout(() => {
      sendDailyDigest();
      setInterval(sendDailyDigest, 24 * 60 * 60 * 1000);
    }, delay);
    log.info(`Daily digest scheduled in ${Math.round(delay / 60000)} minutes`);
  };

  scheduleDigest();
  setInterval(checkStaleLoads, 5 * 60 * 1000);

  // Master balance sweep every 2 hours. First run is delayed 5 minutes after
  // startup so it doesn't collide with any in-flight boot-time load processing.
  const runSweep = async () => {
    try {
      log.info('Running scheduled master balance sweep');
      await masterBalance.runScheduledSweep();
    } catch (err) {
      log.error('Master balance sweep failed', { error: err.message });
    }
  };
  setTimeout(() => {
    runSweep();
    setInterval(runSweep, 2 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);
  log.info('Master balance sweep scheduled: first run in 5 min, then every 2h');
}

module.exports = { sendDailyDigest, checkStaleLoads, startHealthChecks };
