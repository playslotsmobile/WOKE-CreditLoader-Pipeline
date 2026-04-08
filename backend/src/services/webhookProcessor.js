const prisma = require('../db/client');
const quickbooks = require('./quickbooks');
const autoloader = require('./autoloader');
const telegram = require('./telegram');
const { logger } = require('./logger');

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
      include: { vendor: true },
    });

    if (!invoice) {
      try {
        const qbInvoice = await quickbooks.getInvoice(qbInvoiceId);
        const docNumber = qbInvoice?.DocNumber;
        if (docNumber) {
          invoice = await prisma.invoice.findFirst({
            where: { qbInvoiceId: docNumber },
            include: { vendor: true },
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

    log.info('Marking invoice PAID and triggering load', { invoiceId: invoice.id, vendorName: invoice.vendor.name });

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt: new Date() },
    });

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
