const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const quickbooks = require('../services/quickbooks');
const autoloader = require('../services/autoloader');
const telegram = require('../services/telegram');
const prisma = require('../db/client');

// Verify QB webhook signature
function verifySignature(payload, signature) {
  const webhookToken = process.env.QB_WEBHOOK_TOKEN;
  if (!webhookToken) return true; // Skip verification if no token configured

  const hash = crypto
    .createHmac('sha256', webhookToken)
    .update(payload)
    .digest('base64');

  return hash === signature;
}

router.post('/qb-webhook', async (req, res) => {
  // Verify signature using raw body preserved by express.json verify callback
  const signature = req.headers['intuit-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (signature && !verifySignature(rawBody, signature)) {
    console.error('QB webhook: invalid signature');
    return res.status(401).send('Invalid signature');
  }

  // Respond immediately — QB requires fast response
  res.status(200).send('OK');

  try {
    const events = req.body?.eventNotifications || [];

    for (const notification of events) {
      const entities = notification?.dataChangeEvent?.entities || [];

      for (const entity of entities) {
        if (entity.name === 'Payment') {
          await handlePayment(entity.id);
        }
      }
    }
  } catch (err) {
    console.error('QB webhook processing error:', err);
  }
});

async function handlePayment(paymentId) {
  console.log(`QB webhook: Payment received — ID ${paymentId}`);

  // Idempotency check — skip if already processed
  const existing = await prisma.processedWebhook.findUnique({
    where: { paymentId: String(paymentId) },
  });
  if (existing) {
    console.log(`QB webhook: Payment ${paymentId} already processed — skipping`);
    return;
  }

  // Fetch the full payment from QB to get linked invoices
  let payment;
  try {
    payment = await quickbooks.getPayment(paymentId);
  } catch (err) {
    console.error(`QB webhook: Failed to fetch payment ${paymentId}:`, err.message);
    return;
  }

  // Extract invoice references from the payment's Line items
  const invoiceRefs = (payment.Line || [])
    .filter((line) => line.LinkedTxn)
    .flatMap((line) => line.LinkedTxn)
    .filter((txn) => txn.TxnType === 'Invoice')
    .map((txn) => txn.TxnId);

  if (invoiceRefs.length === 0) {
    console.log(`QB webhook: Payment ${paymentId} has no linked invoices — skipping`);
    return;
  }

  for (const qbInvoiceId of invoiceRefs) {
    // Look up our invoice by the QB invoice ID (could be DocNumber or Id)
    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [
          { qbInvoiceId: qbInvoiceId },
          { qbInvoiceId: String(qbInvoiceId) },
        ],
      },
      include: { vendor: true },
    });

    if (!invoice) {
      // Also try matching by fetching the QB invoice's DocNumber
      try {
        const qbInvoice = await quickbooks.getInvoice(qbInvoiceId);
        const docNumber = qbInvoice?.DocNumber;
        if (docNumber) {
          const byDocNum = await prisma.invoice.findFirst({
            where: { qbInvoiceId: docNumber },
            include: { vendor: true },
          });
          if (byDocNum) {
            await processPaymentForInvoice(byDocNum, paymentId);
            continue;
          }
        }
      } catch (err) {
        console.error(`QB webhook: Failed to resolve invoice ${qbInvoiceId}:`, err.message);
      }

      console.log(`QB webhook: No matching invoice for QB ID ${qbInvoiceId}`);
      continue;
    }

    await processPaymentForInvoice(invoice, paymentId);
  }
}

async function processPaymentForInvoice(invoice, paymentId) {
  // Only process invoices that are waiting for payment
  if (invoice.status !== 'REQUESTED') {
    console.log(`QB webhook: Invoice ${invoice.id} is ${invoice.status}, not REQUESTED — skipping`);
    return;
  }

  // Record this webhook as processed
  await prisma.processedWebhook.create({
    data: { paymentId: String(paymentId), invoiceId: invoice.id },
  }).catch(() => {}); // Ignore if duplicate (race condition guard)

  console.log(`QB webhook: Invoice ${invoice.id} (${invoice.vendor.name}) — marking PAID, triggering auto-load`);

  // Mark as PAID
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'PAID', paidAt: new Date() },
  });

  // Trigger auto-loader in background
  autoloader.processInvoice(invoice.id).catch(async (err) => {
    console.error(`QB webhook: Auto-loader failed for invoice ${invoice.id}:`, err.message);

    try {
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `🚨 AUTO-LOAD FAILED 🚨\n\nInvoice #${invoice.id}\nVendor: ${invoice.vendor.name}\nPayment ID: ${paymentId}\nError: ${err.message}\n\nUse the admin dashboard to retry.`
      );
    } catch (tgErr) {
      console.error('Telegram failure alert failed:', tgErr.message);
    }
  });
}

module.exports = router;
