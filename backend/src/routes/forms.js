const express = require('express');
const router = express.Router();
const multer = require('multer');
const quickbooks = require('../services/quickbooks');
const telegram = require('../services/telegram');
const prisma = require('../db/client');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/submit-invoice', upload.single('wireReceipt'), async (req, res) => {
  try {
    // Wire submissions send data as JSON string in 'data' field
    let body = req.body;
    if (body.data) {
      body = JSON.parse(body.data);
    }
    const { vendorSlug, method, baseAmount, feeAmount, totalAmount, allocations } = body;

    const vendor = await prisma.vendor.findUnique({
      where: { slug: vendorSlug },
      include: { accounts: true },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const isWire = method === 'Wire';
    const methodLabel = isWire ? 'Wire' : method === 'ACH' ? 'ACH (1%)' : 'Credit/Debit (3%)';

    // Create invoice in DB
    const invoice = await prisma.invoice.create({
      data: {
        vendorId: vendor.id,
        method: methodLabel,
        baseAmount,
        feeAmount,
        totalAmount,
        status: isWire ? 'PENDING' : 'REQUESTED',
      },
    });

    // Create allocations in DB
    const enrichedAllocations = [];
    for (const a of allocations) {
      if (a.dollarAmount <= 0) continue;
      const alloc = await prisma.invoiceAllocation.create({
        data: {
          invoiceId: invoice.id,
          vendorAccountId: a.accountId,
          dollarAmount: a.dollarAmount,
          credits: a.credits,
        },
        include: { vendorAccount: true },
      });
      enrichedAllocations.push({
        ...a,
        platform: alloc.vendorAccount.platform,
        username: alloc.vendorAccount.username,
        operatorId: alloc.vendorAccount.operatorId,
      });
    }

    // Format vendor for telegram
    const vendorData = {
      name: vendor.name,
      businessName: vendor.businessName,
      email: vendor.email,
      telegramChatId: vendor.telegramChatId,
      qbCustomerName: vendor.qbCustomerId,
    };

    const invoiceData = {
      id: invoice.id,
      qbInvoiceId: invoice.qbInvoiceId,
      method: methodLabel,
      baseAmount,
      feeAmount,
      totalAmount,
    };

    if (isWire) {
      try {
        await telegram.sendWireSubmitted(vendorData, invoiceData, enrichedAllocations);
      } catch (err) {
        console.error('Telegram wire notification failed:', err.message);
      }
    } else {
      // Create QB invoice
      try {
        const qbInvoice = await quickbooks.createInvoice(vendorData, invoiceData, enrichedAllocations);
        const qbId = qbInvoice.DocNumber || String(qbInvoice.Id);
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { qbInvoiceId: qbId },
        });
        invoiceData.qbInvoiceId = qbId;
      } catch (err) {
        console.error('QB invoice creation failed:', err.message);
        invoiceData.qbInvoiceId = 'QB-PENDING';
      }

      try {
        await telegram.sendInvoiceSent(vendorData, invoiceData, enrichedAllocations);
      } catch (err) {
        console.error('Telegram invoice notification failed:', err.message);
      }
    }

    console.log('Invoice saved:', invoice.id);
    res.json({ success: true, invoiceId: invoice.id, qbInvoiceId: invoiceData.qbInvoiceId });
  } catch (err) {
    console.error('Submit invoice error:', err);
    res.status(500).json({ error: 'Failed to submit invoice' });
  }
});

// Submit a correction — moves credits FROM a source vendor to target accounts
router.post('/submit-correction', async (req, res) => {
  try {
    const { vendorSlug, sourceAccountId, corrections } = req.body;

    const vendor = await prisma.vendor.findUnique({
      where: { slug: vendorSlug },
      include: { accounts: true },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const sourceAccount = vendor.accounts.find((a) => a.id === sourceAccountId);
    if (!sourceAccount) {
      return res.status(400).json({ error: 'Source account not found' });
    }

    // Calculate total credits needed
    const totalCredits = corrections.reduce((sum, c) => sum + c.credits, 0);
    if (totalCredits <= 0) {
      return res.status(400).json({ error: 'No credits to correct' });
    }

    // Create invoice record for the correction
    const invoice = await prisma.invoice.create({
      data: {
        vendorId: vendor.id,
        method: 'Correction',
        baseAmount: 0,
        feeAmount: 0,
        totalAmount: 0,
        status: 'REQUESTED',
      },
    });

    // Create allocations
    for (const c of corrections) {
      if (c.credits <= 0) continue;
      await prisma.invoiceAllocation.create({
        data: {
          invoiceId: invoice.id,
          vendorAccountId: c.accountId,
          dollarAmount: 0,
          credits: c.credits,
        },
      });
    }

    // Send Telegram notification
    try {
      const vendorData = {
        name: vendor.name,
        businessName: vendor.businessName,
        telegramChatId: vendor.telegramChatId,
      };

      const correctionDetails = corrections
        .filter((c) => c.credits > 0)
        .map((c) => `${c.username}: ${c.credits} credits`)
        .join('\n');

      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `📋 Correction Request from ${vendor.name}\n\nSource: ${sourceAccount.username} (${sourceAccount.operatorId})\n\n${correctionDetails}\n\nTotal: ${totalCredits} credits\nInvoice #${invoice.id}`
      );
    } catch (err) {
      console.error('Telegram correction notification failed:', err.message);
    }

    console.log('Correction saved:', invoice.id);
    res.json({ success: true, invoiceId: invoice.id });
  } catch (err) {
    console.error('Submit correction error:', err);
    res.status(500).json({ error: 'Failed to submit correction' });
  }
});

module.exports = router;
