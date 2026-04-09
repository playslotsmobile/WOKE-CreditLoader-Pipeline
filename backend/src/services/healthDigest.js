const prisma = require('../db/client');
const telegram = require('./telegram');
const { logger } = require('./logger');

const log = logger.child({ service: 'healthDigest' });

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

    const failedWebhooks = await prisma.webhookEvent.count({ where: { status: 'FAILED' } });

    const msg = `📊 Daily Health Digest

Invoices (24h):
✅ Loaded: ${loaded}
❌ Failed: ${failed}

Stuck:
⏳ LOADING: ${stuckLoading}
📋 REQUESTED: ${stuckRequested}

Infrastructure:
${adspowerOk ? '✅' : '❌'} AdsPower API
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
    const data = await quickbooks.qbRequest(
      'GET',
      `query?query=SELECT * FROM Payment WHERE TxnDate >= '${sinceStr}'`
    );
    const payments = data.QueryResponse?.Payment || [];

    for (const payment of payments) {
      const paymentId = String(payment.Id);
      const processed = await prisma.processedWebhook.findUnique({
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
}

module.exports = { sendDailyDigest, checkStaleLoads, startHealthChecks };
