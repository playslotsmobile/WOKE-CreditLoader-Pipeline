const prisma = require('../db/client');
const telegram = require('./telegram');
const { logger } = require('./logger');

const log = logger.child({ service: 'healthDigest' });

async function sendDailyDigest() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const loaded = await prisma.invoice.count({ where: { status: 'LOADED', loadedAt: { gte: since } } });
    const failed = await prisma.invoice.count({ where: { status: 'FAILED', submittedAt: { gte: since } } });
    const stuckLoading = await prisma.invoice.count({ where: { status: 'LOADING' } });
    const stuckRequested = await prisma.invoice.count({ where: { status: 'REQUESTED' } });

    const failedWebhooks = await prisma.webhookEvent.count({ where: { status: 'FAILED' } });

    const msg = `📊 Daily Health Digest

Invoices (24h):
✅ Loaded: ${loaded}
❌ Failed: ${failed}

Stuck:
⏳ LOADING: ${stuckLoading}
📋 REQUESTED: ${stuckRequested}

Infrastructure:
✅ Browser: Playwright + Stealth
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

async function checkStaleLoads() {
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stale = await prisma.invoice.findMany({
      where: { status: 'LOADING', submittedAt: { lt: tenMinAgo } },
      include: { vendor: true },
    });

    for (const inv of stale) {
      const mins = Math.floor((Date.now() - new Date(inv.submittedAt).getTime()) / 60000);
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `⚠️ Stale Load Detected\n\nInvoice #${inv.id} (${inv.vendor.name}) has been LOADING for ${mins} minutes. Possible hung process.`
      );
      log.warn('Stale load detected', { invoiceId: inv.id, minutes: mins });
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
  setInterval(checkStaleLoads, 2 * 60 * 1000);
}

module.exports = { sendDailyDigest, checkStaleLoads, startHealthChecks };
