const prisma = require('../db/client');
const quickbooks = require('./quickbooks');
const autoloader = require('./autoloader');
const telegram = require('./telegram');
const masterBalance = require('./masterBalance');
const { logger } = require('./logger');
const creditLineService = require('./creditLineService');

const MAX_ATTEMPTS = 3;

async function processWebhookEvent(event) {
  const log = logger.child({ webhookEventId: event.id, source: event.source });

  try {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', attempts: event.attempts + 1 },
    });

    const payload = event.payload;
    const notifications = payload?.eventNotifications || [];

    for (const notification of notifications) {
      const entities = notification?.dataChangeEvent?.entities || [];
      for (const entity of entities) {
        if (entity.name === 'Payment') {
          await handlePayment(entity.id, log);
        }
      }
    }

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    log.info('Webhook event processed');
  } catch (err) {
    log.error('Webhook processing failed', { error: err });
    const newAttempts = event.attempts + 1;
    const status = newAttempts >= MAX_ATTEMPTS ? 'FAILED' : 'RECEIVED';

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status, error: err.message, attempts: newAttempts },
    });

    if (status === 'FAILED') {
      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `🚨 Webhook processing FAILED after ${MAX_ATTEMPTS} attempts\n\nEvent #${event.id}\nSource: ${event.source}\nError: ${err.message}`
        );
      } catch {}
    }
  }
}

async function handlePayment(paymentId, log) {
  log.info('Processing payment', { paymentId });

  const existing = await prisma.processedWebhook.findUnique({
    where: { paymentId: String(paymentId) },
  });
  if (existing) {
    log.info('Payment already processed — skipping', { paymentId });
    return;
  }

  let payment;
  try {
    payment = await quickbooks.getPayment(paymentId);
  } catch (err) {
    log.error('Failed to fetch payment from QB', { paymentId, error: err });
    throw err;
  }

  const invoiceRefs = (payment.Line || [])
    .filter((line) => line.LinkedTxn)
    .flatMap((line) => line.LinkedTxn)
    .filter((txn) => txn.TxnType === 'Invoice')
    .map((txn) => txn.TxnId);

  if (invoiceRefs.length === 0) {
    log.info('Payment has no linked invoices', { paymentId });
    return;
  }

  for (const qbInvoiceId of invoiceRefs) {
    let invoice = await prisma.invoice.findFirst({
      where: {
        OR: [
          { qbInvoiceId: qbInvoiceId },
          { qbInvoiceId: String(qbInvoiceId) },
        ],
      },
      include: {
        vendor: true,
        allocations: { include: { vendorAccount: true } },
      },
    });

    if (!invoice) {
      try {
        const qbInvoice = await quickbooks.getInvoice(qbInvoiceId);
        const docNumber = qbInvoice?.DocNumber;
        if (docNumber) {
          invoice = await prisma.invoice.findFirst({
            where: { qbInvoiceId: docNumber },
            include: {
              vendor: true,
              allocations: { include: { vendorAccount: true } },
            },
          });
        }
      } catch (err) {
        log.error('Failed to resolve QB invoice', { qbInvoiceId, error: err });
      }
    }

    if (!invoice) {
      log.warn('No matching local invoice for QB ID', { qbInvoiceId });
      continue;
    }

    if (invoice.status !== 'REQUESTED') {
      log.info('Invoice not in REQUESTED status — skipping', { invoiceId: invoice.id, status: invoice.status });
      continue;
    }

    await prisma.processedWebhook.create({
      data: { paymentId: String(paymentId), invoiceId: invoice.id },
    }).catch(() => {});

    // Credit-aware block check. Compares this invoice's actual credit
    // requirement per platform to the latest stored master balance. If any
    // platform can't cover the invoice's credits (with a 10% safety buffer),
    // we flip to BLOCKED_LOW_MASTER instead of PAID and skip the autoloader.
    // The vendor still gets the normal "Payment Received" message so their
    // experience looks like normal processing latency — per
    // feedback_vendor_silence_on_master_low, vendors must NEVER be told about
    // master balance issues.
    const blockDecision = await masterBalance.canLoadInvoice(invoice);

    if (!blockDecision.canLoad) {
      const insufficient = blockDecision.checks.filter((c) => !c.sufficient);
      log.warn('Blocking invoice — insufficient master credits', {
        invoiceId: invoice.id,
        vendorName: invoice.vendor.name,
        checks: blockDecision.checks,
      });

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'BLOCKED_LOW_MASTER', paidAt: new Date() },
      });

      // Vendor silence: still send the normal innocuous "Payment Received"
      // message so the vendor thinks processing is under way. Never mention
      // the block reason.
      try {
        await telegram.sendVendorPaid(
          { telegramChatId: invoice.vendor.telegramChatId },
          { totalAmount: invoice.totalAmount, id: invoice.id }
        );
      } catch {}

      // Admin-only alert with full context including per-platform credit
      // math so the admin knows exactly how short we are and how much to refill.
      try {
        const lines = insufficient
          .map((c) => {
            const platformLabel =
              c.platform === 'PLAY777' ? 'Play777 (Master715)' : 'iConnect (tonydial)';
            const shortfall = c.requiredWithBuffer - c.available;
            return `• ${platformLabel}\n  Needs: ${c.required.toLocaleString()} credits (${c.requiredWithBuffer.toLocaleString()} w/ buffer)\n  Has:   ${c.available.toLocaleString()} credits\n  Short: ${shortfall.toLocaleString()} credits`;
          })
          .join('\n\n');
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `⛔ Invoice BLOCKED — insufficient master credits\n\nInvoice #${invoice.id}\nVendor: ${invoice.vendor.name}\nAmount: $${Number(invoice.totalAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}\nPayment ID: ${paymentId}\n\n${lines}\n\nRefill the master and the invoice will auto-resume on the next balance sweep (every 2h) — or hit "Force Sweep" in admin to trigger immediately. Vendor was NOT told about this.`
        );
      } catch {}

      // Still check for credit line repayment — repayment allocation is
      // separate from the load, so it should still happen even if the load
      // is blocked.
      await maybeProcessCreditLineRepayment(invoice, log);
      continue;
    }

    log.info('Marking invoice PAID and triggering load', { invoiceId: invoice.id, vendorName: invoice.vendor.name });

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    try {
      await telegram.sendVendorPaid(
        { telegramChatId: invoice.vendor.telegramChatId },
        { totalAmount: invoice.totalAmount, id: invoice.id }
      );
    } catch {}

    await maybeProcessCreditLineRepayment(invoice, log);

    autoloader.processInvoice(invoice.id).catch(async (err) => {
      log.error('Auto-loader failed', { invoiceId: invoice.id, error: err });
      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `🚨 AUTO-LOAD FAILED 🚨\n\nInvoice #${invoice.id}\nVendor: ${invoice.vendor.name}\nPayment ID: ${paymentId}\nError: ${err.message}\n\nUse the admin dashboard to retry.`
        );
      } catch {}
    });
  }
}

async function maybeProcessCreditLineRepayment(invoice, log) {
  try {
    const repaymentSetting = await prisma.setting.findUnique({
      where: { key: `credit_line_repayment_${invoice.id}` },
    });
    if (!repaymentSetting) return;
    const repaymentAmount = Number(repaymentSetting.value);
    if (repaymentAmount <= 0) return;

    await creditLineService.recordRepayment(invoice.vendorId, invoice.id, repaymentAmount);
    const cl = await creditLineService.getCreditLine(invoice.vendorId);

    await telegram.sendCreditLineRepayment(
      { name: invoice.vendor.name, telegramChatId: invoice.vendor.telegramChatId },
      repaymentAmount,
      { usedAmount: Number(cl.usedAmount), capAmount: Number(cl.capAmount) }
    );

    await prisma.setting.delete({ where: { key: `credit_line_repayment_${invoice.id}` } });

    log.info('Credit line repayment processed', {
      invoiceId: invoice.id,
      vendorId: invoice.vendorId,
      repaymentAmount,
    });
  } catch (clErr) {
    log.error('Credit line repayment processing failed', { error: clErr, invoiceId: invoice.id });
  }
}

async function startWebhookProcessor() {
  const log = logger.child({ service: 'webhookProcessor' });

  const pending = await prisma.webhookEvent.findMany({
    where: { status: { in: ['RECEIVED', 'PROCESSING'] } },
    orderBy: { receivedAt: 'asc' },
  });
  if (pending.length > 0) {
    log.info(`Found ${pending.length} unprocessed webhook events on startup`);
    for (const event of pending) {
      await processWebhookEvent(event);
    }
  }

  setInterval(async () => {
    try {
      const events = await prisma.webhookEvent.findMany({
        where: { status: 'RECEIVED' },
        orderBy: { receivedAt: 'asc' },
        take: 10,
      });
      for (const event of events) {
        await processWebhookEvent(event);
      }
    } catch (err) {
      log.error('Webhook processor poll failed', { error: err });
    }
  }, 5000);
}

module.exports = { processWebhookEvent, startWebhookProcessor, handlePayment };
