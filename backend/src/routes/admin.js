const express = require('express');
const router = express.Router();
const telegram = require('../services/telegram');
const prisma = require('../db/client');

// Get all invoices with allocations
router.get('/invoices', async (req, res) => {
  try {
    const invoices = await prisma.invoice.findMany({
      include: {
        vendor: true,
        allocations: {
          include: { vendorAccount: true },
        },
      },
      orderBy: { submittedAt: 'desc' },
    });

    const formatted = invoices.map((inv) => ({
      invoice: {
        id: inv.id,
        vendorSlug: inv.vendor.slug,
        qbInvoiceId: inv.qbInvoiceId,
        method: inv.method,
        baseAmount: Number(inv.baseAmount),
        feeAmount: Number(inv.feeAmount),
        totalAmount: Number(inv.totalAmount),
        status: inv.status,
        submittedAt: inv.submittedAt,
        paidAt: inv.paidAt,
        loadedAt: inv.loadedAt,
      },
      allocations: inv.allocations.map((a) => ({
        accountId: a.vendorAccountId,
        dollarAmount: Number(a.dollarAmount),
        credits: a.credits,
        platform: a.vendorAccount.platform,
        username: a.vendorAccount.username,
        operatorId: a.vendorAccount.operatorId,
      })),
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Get invoices error:', err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// Confirm wire received
router.post('/invoices/:id/confirm-wire', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        vendor: true,
        allocations: { include: { vendorAccount: true } },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.method !== 'Wire') return res.status(400).json({ error: 'Not a wire invoice' });
    if (invoice.status !== 'PENDING') return res.status(400).json({ error: 'Invoice not in PENDING status' });

    // TODO Phase 5: trigger auto-loader. For now mark as LOADED.
    const updated = await prisma.invoice.update({
      where: { id },
      data: { status: 'LOADED', paidAt: new Date(), loadedAt: new Date() },
    });

    const vendorData = {
      name: invoice.vendor.name,
      businessName: invoice.vendor.businessName,
      email: invoice.vendor.email,
      telegramChatId: invoice.vendor.telegramChatId,
    };

    const invoiceData = {
      id: invoice.id,
      qbInvoiceId: invoice.qbInvoiceId,
      method: invoice.method,
      baseAmount: Number(invoice.baseAmount),
    };

    const allocations = invoice.allocations.map((a) => ({
      dollarAmount: Number(a.dollarAmount),
      credits: a.credits,
      platform: a.vendorAccount.platform,
      username: a.vendorAccount.username,
      operatorId: a.vendorAccount.operatorId,
    }));

    try {
      await telegram.sendLoaded(vendorData, invoiceData, allocations);
    } catch (err) {
      console.error('Telegram loaded notification failed:', err.message);
    }

    res.json({ success: true, invoice: updated });
  } catch (err) {
    console.error('Confirm wire error:', err);
    res.status(500).json({ error: 'Failed to confirm wire' });
  }
});

// Manual load trigger
router.post('/invoices/:id/trigger-load', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        vendor: true,
        allocations: { include: { vendorAccount: true } },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // TODO Phase 5: trigger auto-loader. For now mark as LOADED.
    const updated = await prisma.invoice.update({
      where: { id },
      data: { status: 'LOADED', loadedAt: new Date() },
    });

    const vendorData = {
      name: invoice.vendor.name,
      businessName: invoice.vendor.businessName,
      email: invoice.vendor.email,
      telegramChatId: invoice.vendor.telegramChatId,
    };

    const invoiceData = {
      id: invoice.id,
      qbInvoiceId: invoice.qbInvoiceId,
      method: invoice.method,
      baseAmount: Number(invoice.baseAmount),
    };

    const allocations = invoice.allocations.map((a) => ({
      dollarAmount: Number(a.dollarAmount),
      credits: a.credits,
      platform: a.vendorAccount.platform,
      username: a.vendorAccount.username,
      operatorId: a.vendorAccount.operatorId,
    }));

    try {
      await telegram.sendLoaded(vendorData, invoiceData, allocations);
    } catch (err) {
      console.error('Telegram loaded notification failed:', err.message);
    }

    res.json({ success: true, invoice: updated });
  } catch (err) {
    console.error('Trigger load error:', err);
    res.status(500).json({ error: 'Failed to trigger load' });
  }
});

module.exports = router;
