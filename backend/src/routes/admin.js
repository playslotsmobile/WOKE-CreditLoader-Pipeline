const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const telegram = require('../services/telegram');
const quickbooks = require('../services/quickbooks');
const prisma = require('../db/client');
const autoloader = require('../services/autoloader');
const { requireAdmin, signToken } = require('../middleware/auth');

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const admin = await prisma.adminUser.findUnique({ where: { username } });
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(admin.id, admin.username);
    res.json({ token, username: admin.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// All routes below require auth
router.use(requireAdmin);

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

// Resend QB invoice email
router.post('/invoices/:id/resend-email', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { vendor: true },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.qbInvoiceId) return res.status(400).json({ error: 'No QB invoice ID — cannot resend' });

    await quickbooks.sendInvoiceEmail(invoice.qbInvoiceId, invoice.vendor.email);
    res.json({ success: true, message: `Invoice email resent to ${invoice.vendor.email}` });
  } catch (err) {
    console.error('Resend email error:', err);
    res.status(500).json({ error: 'Failed to resend invoice email' });
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
