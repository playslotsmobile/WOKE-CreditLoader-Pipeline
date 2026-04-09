const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const telegram = require('../services/telegram');
const quickbooks = require('../services/quickbooks');
const prisma = require('../db/client');
const autoloader = require('../services/autoloader');
const { requireAdmin, signToken } = require('../middleware/auth');
const { logger } = require('../services/logger');

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

// Recent corrections
router.get('/corrections', async (req, res) => {
  try {
    const corrections = await prisma.invoice.findMany({
      where: { method: 'Correction' },
      include: {
        vendor: true,
        allocations: { include: { vendorAccount: true } },
      },
      orderBy: { submittedAt: 'desc' },
      take: 50,
    });

    const formatted = corrections.map((c) => ({
      id: c.id,
      vendor: c.vendor.name,
      vendorSlug: c.vendor.slug,
      status: c.status,
      submittedAt: c.submittedAt,
      loadedAt: c.loadedAt,
      allocations: c.allocations.map((a) => ({
        username: a.vendorAccount.username,
        operatorId: a.vendorAccount.operatorId,
        credits: a.credits,
      })),
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Corrections error:', err);
    res.status(500).json({ error: 'Failed to fetch corrections' });
  }
});

// Load events for an invoice (timeline view)
router.get('/invoices/:id/events', async (req, res) => {
  try {
    const invoiceId = parseInt(req.params.id);

    const loadJobs = await prisma.loadJob.findMany({
      where: { invoiceId },
      select: { id: true },
    });
    const jobIds = loadJobs.map((j) => j.id);

    const events = await prisma.loadEvent.findMany({
      where: { loadJobId: { in: jobIds } },
      orderBy: { createdAt: 'asc' },
      include: {
        loadJob: {
          select: {
            vendorAccount: {
              select: { username: true, platform: true },
            },
          },
        },
      },
    });

    const formatted = events.map((e) => ({
      id: e.id,
      step: e.step,
      status: e.status,
      metadata: e.metadata,
      screenshotPath: e.screenshotPath,
      account: e.loadJob?.vendorAccount?.username,
      platform: e.loadJob?.vendorAccount?.platform,
      createdAt: e.createdAt,
    }));

    res.json(formatted);
  } catch (err) {
    logger.error('Get events error', { error: err });
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Submit 2FA code for Play777 login
router.post('/2fa-code', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });

    await prisma.setting.upsert({
      where: { key: 'play777_2fa_code' },
      update: { value: String(code) },
      create: { key: 'play777_2fa_code', value: String(code) },
    });

    logger.info('2FA code submitted via dashboard', { codeLength: code.length });
    res.json({ success: true, message: '2FA code submitted — browser will pick it up within 5 seconds' });
  } catch (err) {
    logger.error('2FA code submission failed', { error: err });
    res.status(500).json({ error: 'Failed to submit 2FA code' });
  }
});

// Check if 2FA is currently needed
router.get('/2fa-status', async (req, res) => {
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'play777_2fa_code' } });
    res.json({ needed: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check 2FA status' });
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

    // Get credit line balances
    const creditLines = await prisma.creditLine.findMany();
    const clByVendor = Object.fromEntries(creditLines.map((cl) => [cl.vendorId, cl]));

    const stats = vendors.map((v) => {
      const paidInvoices = v.invoices.filter((i) => i.method !== 'Correction' && i.method !== 'Credit Line');
      const creditLineInvoices = v.invoices.filter((i) => i.method === 'Credit Line');
      const allNonCorrection = v.invoices.filter((i) => i.method !== 'Correction');

      const totalRevenue = paidInvoices.reduce((s, i) => s + Number(i.baseAmount), 0);
      const totalCreditLineDrawn = creditLineInvoices.reduce((s, i) => s + Number(i.baseAmount), 0);
      const totalCredits = allNonCorrection.reduce(
        (s, i) => s + i.allocations.reduce((a, al) => a + al.credits, 0),
        0
      );
      const lastInvoice = v.invoices.length > 0
        ? v.invoices.reduce((latest, i) =>
            new Date(i.submittedAt) > new Date(latest.submittedAt) ? i : latest
          )
        : null;

      const cl = clByVendor[v.id];
      const creditLineOwed = cl ? Number(cl.usedAmount) : 0;
      const creditLineCap = cl ? Number(cl.capAmount) : 0;

      return {
        slug: v.slug,
        name: v.name,
        business: v.businessName,
        totalSpent: totalRevenue,
        totalCreditLine: totalCreditLineDrawn,
        creditLineOwed,
        creditLineCap,
        totalCredits,
        invoiceCount: paidInvoices.length,
        creditLineCount: creditLineInvoices.length,
        lastActive: lastInvoice?.submittedAt || null,
      };
    })
    .filter((v) => v.invoiceCount > 0 || v.creditLineCount > 0)
    .sort((a, b) => (b.totalSpent + b.totalCreditLine) - (a.totalSpent + a.totalCreditLine));

    res.json(stats);
  } catch (err) {
    console.error('Vendor stats error:', err);
    res.status(500).json({ error: 'Failed to fetch vendor stats' });
  }
});

// Update vendor account rate
router.post('/accounts/:id/rate', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rate } = req.body;

    if (rate === undefined || rate === null || typeof rate !== 'number' || rate < 0 || rate > 1) {
      return res.status(400).json({ error: 'rate must be a number between 0 and 1' });
    }

    const account = await prisma.vendorAccount.findUnique({ where: { id } });
    if (!account) return res.status(404).json({ error: 'Vendor account not found' });

    const updated = await prisma.vendorAccount.update({
      where: { id },
      data: { rate },
    });

    logger.info('Vendor account rate updated', { accountId: id, oldRate: account.rate, newRate: rate });
    res.json(updated);
  } catch (err) {
    logger.error('Update account rate error', { error: err });
    res.status(500).json({ error: 'Failed to update account rate' });
  }
});

// Credit Line overview (all vendors)
router.get('/credit-lines', async (req, res) => {
  try {
    const creditLines = await prisma.creditLine.findMany({
      include: {
        vendor: { select: { slug: true, name: true, businessName: true } },
      },
    });

    const formatted = creditLines.map((cl) => ({
      id: cl.id,
      vendorSlug: cl.vendor.slug,
      vendorName: cl.vendor.name,
      businessName: cl.vendor.businessName,
      capAmount: Number(cl.capAmount),
      usedAmount: Number(cl.usedAmount),
      availableAmount: Number(cl.capAmount) - Number(cl.usedAmount),
      updatedAt: cl.updatedAt,
    }));

    res.json(formatted);
  } catch (err) {
    logger.error('Credit lines overview error', { error: err });
    res.status(500).json({ error: 'Failed to fetch credit lines' });
  }
});

// Credit Line transactions (all or filtered by vendor)
router.get('/credit-line-transactions', async (req, res) => {
  try {
    const { vendorSlug, type } = req.query;

    const where = {};
    if (vendorSlug) {
      const vendor = await prisma.vendor.findUnique({ where: { slug: vendorSlug } });
      if (vendor) {
        const cl = await prisma.creditLine.findUnique({ where: { vendorId: vendor.id } });
        if (cl) where.creditLineId = cl.id;
      }
    }
    if (type) where.type = type;

    const transactions = await prisma.creditLineTransaction.findMany({
      where,
      include: {
        creditLine: {
          include: { vendor: { select: { slug: true, name: true } } },
        },
        invoice: { select: { id: true, method: true, baseAmount: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const formatted = transactions.map((t) => ({
      id: t.id,
      vendorSlug: t.creditLine.vendor.slug,
      vendorName: t.creditLine.vendor.name,
      type: t.type,
      amount: Number(t.amount),
      balanceBefore: Number(t.balanceBefore),
      balanceAfter: Number(t.balanceAfter),
      invoiceId: t.invoiceId,
      createdAt: t.createdAt,
    }));

    res.json(formatted);
  } catch (err) {
    logger.error('Credit line transactions error', { error: err });
    res.status(500).json({ error: 'Failed to fetch credit line transactions' });
  }
});

module.exports = router;
