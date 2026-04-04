const express = require('express');
const router = express.Router();
const quickbooks = require('../services/quickbooks');
const telegram = require('../services/telegram');
const prisma = require('../db/client');

router.post('/submit-invoice', async (req, res) => {
  try {
    const { vendorSlug, method, baseAmount, feeAmount, totalAmount, allocations } = req.body;

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

module.exports = router;
