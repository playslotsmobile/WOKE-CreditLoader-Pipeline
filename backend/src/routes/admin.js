const express = require('express');
const router = express.Router();
const telegram = require('../services/telegram');
const prisma = require('../db/client');
const autoloader = require('../services/autoloader');

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

    // Mark as paid, then trigger auto-loader
    await prisma.invoice.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    // Respond immediately, process load in background
    res.json({ success: true, message: 'Wire confirmed, loading credits...' });

    // Auto-load in background
    autoloader.processInvoice(id).catch((err) => {
      console.error('Auto-loader failed for wire invoice:', err.message);
    });
  } catch (err) {
    console.error('Confirm wire error:', err);
    res.status(500).json({ error: 'Failed to confirm wire' });
  }
});

// Manual load trigger
router.post('/invoices/:id/trigger-load', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'PAID' && invoice.status !== 'FAILED') {
      return res.status(400).json({ error: `Cannot load — invoice status is ${invoice.status}, must be PAID or FAILED` });
    }

    // Respond immediately, process load in background
    res.json({ success: true, message: 'Loading credits...' });

    // Auto-load in background
    autoloader.processInvoice(id).catch((err) => {
      console.error('Auto-loader failed:', err.message);
    });
  } catch (err) {
    console.error('Trigger load error:', err);
    res.status(500).json({ error: 'Failed to trigger load' });
  }
});

// Vendor stats (real data from DB)
router.get('/vendor-stats', async (req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({
      include: {
        invoices: {
          include: { allocations: true },
        },
      },
    });

    const stats = vendors.map((v) => {
      const loadedInvoices = v.invoices.filter((i) => i.status === 'LOADED');
      const allInvoices = v.invoices.filter((i) => i.method !== 'Correction');
      const totalSpent = allInvoices.reduce((s, i) => s + Number(i.baseAmount), 0);
      const totalCredits = allInvoices.reduce(
        (s, i) => s + i.allocations.reduce((a, al) => a + al.credits, 0),
        0
      );
      const lastInvoice = v.invoices.length > 0
        ? v.invoices.reduce((latest, i) =>
            new Date(i.submittedAt) > new Date(latest.submittedAt) ? i : latest
          )
        : null;

      return {
        slug: v.slug,
        name: v.name,
        business: v.businessName,
        totalSpent,
        totalCredits,
        invoiceCount: allInvoices.length,
        loadedCount: loadedInvoices.length,
        lastActive: lastInvoice?.submittedAt || null,
      };
    })
    .filter((v) => v.invoiceCount > 0)
    .sort((a, b) => b.totalSpent - a.totalSpent);

    res.json(stats);
  } catch (err) {
    console.error('Vendor stats error:', err);
    res.status(500).json({ error: 'Failed to fetch vendor stats' });
  }
});

module.exports = router;
