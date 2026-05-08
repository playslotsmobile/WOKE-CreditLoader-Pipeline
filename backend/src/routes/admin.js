const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const telegram = require('../services/telegram');
const quickbooks = require('../services/quickbooks');
const prisma = require('../db/client');
const autoloader = require('../services/autoloader');
const creditLineService = require('../services/creditLineService');
const masterBalance = require('../services/masterBalance');
const statsService = require('../services/statsService');
const { requireAdmin, signToken } = require('../middleware/auth');
const { logger } = require('../services/logger');

// Rate limiter for /login: 5 attempts per 15 min per IP. Bcrypt slows attackers
// per-attempt; this stops sustained brute-force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// Login
router.post('/login', loginLimiter, async (req, res) => {
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
    logger.error('Login error', { error: err });
    res.status(500).json({ error: 'Login failed' });
  }
});

// All routes below require auth
router.use(requireAdmin);

// Get invoices with allocations. Paginated: ?limit=N&before=<id> (cursor)
// or ?status=… filter. Default limit 200 covers a few months at current rate.
// Total count returned in X-Total-Count header so dashboard can show "M of N".
router.get('/invoices', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 500));
    const beforeId = req.query.before ? parseInt(req.query.before, 10) : null;
    const status = typeof req.query.status === 'string' ? req.query.status : null;

    const where = {};
    if (beforeId) where.id = { lt: beforeId };
    if (status) where.status = status;

    const [invoices, totalCount] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          vendor: true,
          allocations: { include: { vendorAccount: true } },
          creditLineTransactions: { select: { type: true, amount: true } },
        },
        orderBy: { id: 'desc' },
        take: limit,
      }),
      prisma.invoice.count({ where: status ? { status } : {} }),
    ]);
    res.set('X-Total-Count', String(totalCount));

    const formatted = invoices.map((inv) => {
      const repaymentTxn = inv.creditLineTransactions.find((t) => t.type === 'REPAYMENT');
      return {
      vendor: {
        slug: inv.vendor.slug,
        name: inv.vendor.name,
        businessName: inv.vendor.businessName,
      },
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
        wireReceiptPath: inv.wireReceiptPath,
        creditLineRepayment: repaymentTxn ? Number(repaymentTxn.amount) : null,
      },
      allocations: inv.allocations.map((a) => ({
        accountId: a.vendorAccountId,
        dollarAmount: Number(a.dollarAmount),
        credits: a.credits,
        platform: a.vendorAccount.platform,
        username: a.vendorAccount.username,
        operatorId: a.vendorAccount.operatorId,
      })),
    };
    });

    res.json(formatted);
  } catch (err) {
    logger.error('Get invoices error', { error: err });
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

    // Apply any credit line repayment intent stored at submission time.
    // Safe for non-repayment invoices — no-op when the setting is absent.
    await creditLineService.processRepaymentIntent(invoice);

    // Respond immediately, process load in background
    res.json({ success: true, message: 'Wire confirmed, loading credits...' });

    // Auto-load in background
    autoloader.processInvoice(id).catch((err) => {
      logger.error('Auto-loader failed for wire invoice', { invoiceId: id, error: err.message });
    });
  } catch (err) {
    logger.error('Confirm wire error', { error: err });
    res.status(500).json({ error: 'Failed to confirm wire' });
  }
});

// Admin confirms cash was received — flips PENDING Cash → PAID and triggers autoload.
router.post('/invoices/:id/confirm-cash', async (req, res) => {
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
    if (invoice.method !== 'Cash') return res.status(400).json({ error: 'Not a cash invoice' });
    if (invoice.status !== 'PENDING') return res.status(400).json({ error: 'Invoice not in PENDING status' });

    await prisma.invoice.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
    });

    await creditLineService.processRepaymentIntent(invoice);

    res.json({ success: true, message: 'Cash confirmed, loading credits...' });

    autoloader.processInvoice(id).catch((err) => {
      logger.error('Auto-loader failed for cash invoice', { invoiceId: id, error: err.message });
    });
  } catch (err) {
    logger.error('Confirm cash error', { error: err });
    res.status(500).json({ error: 'Failed to confirm cash' });
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
      logger.error('Auto-loader failed', { invoiceId: id, error: err.message });
    });
  } catch (err) {
    logger.error('Trigger load error', { error: err });
    res.status(500).json({ error: 'Failed to trigger load' });
  }
});

// Mark invoice as manually loaded (operator deposited credits themselves on the
// platform UI). Flips invoice → LOADED, any PENDING/FAILED loadJobs → SUCCESS,
// and emits a MANUAL_LOAD event on each job for the audit trail. Does NOT
// notify the vendor (operator handles that out-of-band).
router.post('/invoices/:id/mark-loaded', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const allowedFrom = ['FAILED', 'PAID', 'BLOCKED_LOW_MASTER'];
    if (!allowedFrom.includes(invoice.status)) {
      return res.status(400).json({ error: `Cannot mark loaded — invoice status is ${invoice.status}` });
    }

    const now = new Date();
    const openJobs = await prisma.loadJob.findMany({
      where: { invoiceId: id, status: { in: ['PENDING', 'FAILED'] } },
    });

    await prisma.$transaction([
      ...openJobs.map((j) =>
        prisma.loadJob.update({
          where: { id: j.id },
          data: { status: 'SUCCESS', errorMessage: null, completedAt: now },
        })
      ),
      prisma.invoice.update({
        where: { id },
        data: { status: 'LOADED', loadedAt: now },
      }),
      ...openJobs.map((j) =>
        prisma.loadEvent.create({
          data: {
            loadJobId: j.id,
            step: 'MANUAL_LOAD',
            status: 'SUCCESS',
            metadata: { note: 'Marked loaded manually by admin', invoiceId: id, credits: j.creditsAmount },
          },
        })
      ),
    ]);

    logger.info('Invoice marked as loaded manually', { invoiceId: id, jobsUpdated: openJobs.length });
    res.json({ success: true, message: `Invoice ${id} marked as loaded`, jobsUpdated: openJobs.length });
  } catch (err) {
    logger.error('Mark loaded error', { error: err });
    res.status(500).json({ error: 'Failed to mark as loaded' });
  }
});

// Delete invoice
router.delete('/invoices/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { vendor: true },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Don't allow deleting invoices that are currently loading
    if (invoice.status === 'LOADING') {
      return res.status(400).json({ error: 'Cannot delete — invoice is currently loading' });
    }

    // Void the QB invoice if one exists (card/ACH invoices)
    let qbVoided = false;
    if (invoice.qbInvoiceId) {
      try {
        await quickbooks.voidInvoice(invoice.qbInvoiceId);
        qbVoided = true;
        logger.info('QB invoice voided', { invoiceId: id, qbInvoiceId: invoice.qbInvoiceId });
      } catch (err) {
        logger.error('QB void failed — proceeding with delete', { invoiceId: id, error: err.message });
      }
    }

    // Delete related records first (FK constraints)
    await prisma.loadEvent.deleteMany({
      where: { loadJob: { invoiceId: id } },
    });
    await prisma.loadJob.deleteMany({ where: { invoiceId: id } });
    await prisma.invoiceAllocation.deleteMany({ where: { invoiceId: id } });
    await prisma.creditLineTransaction.deleteMany({ where: { invoiceId: id } });
    await prisma.invoice.delete({ where: { id } });

    // Clean up credit line repayment setting if exists
    await prisma.setting.deleteMany({ where: { key: `credit_line_repayment_${id}` } });

    res.json({ success: true, message: `Invoice ${id} deleted` });
  } catch (err) {
    logger.error('Delete invoice error', { error: err });
    res.status(500).json({ error: 'Failed to delete invoice' });
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
    logger.error('Resend email error', { error: err });
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
    logger.error('Corrections error', { error: err });
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

    const path = require('path');
    const formatted = events.map((e) => ({
      id: e.id,
      step: e.step,
      status: e.status,
      metadata: e.metadata,
      // Strip absolute disk path → basename so the frontend can build the
      // proper URL via the auth-gated /api/screenshots/<basename> static mount.
      screenshotPath: e.screenshotPath ? path.basename(e.screenshotPath) : null,
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

// Vendor stats — moved to statsService (extracted aggregator). Keeps the
// route thin and makes the SQL boundary easy to swap when the JS aggregation
// hits its scaling limits.
router.get('/vendor-stats', async (req, res) => {
  try {
    const stats = await statsService.computeVendorLeaderboard();
    res.json(stats);
  } catch (err) {
    logger.error('Vendor stats error', { error: err });
    res.status(500).json({ error: 'Failed to fetch vendor stats' });
  }
});

// Time-filtered stats (anchored on paidAt). Credit-line balances excluded
// (those are point-in-time, not flow over a date range).
router.get('/stats', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = { paidAt: { not: null } };
    if (from || to) {
      where.paidAt = {};
      if (from) where.paidAt.gte = new Date(from);
      if (to) where.paidAt.lte = new Date(to);
    }

    const invoices = await prisma.invoice.findMany({
      where,
      include: { allocations: true, vendor: { select: { id: true, name: true, slug: true } } },
    });

    const nonCorrection = invoices.filter((i) => i.method !== 'Correction');
    const revenueInvoices = nonCorrection.filter((i) => i.method !== 'Credit Line');

    const totalRevenue = revenueInvoices.reduce((s, i) => s + Number(i.baseAmount), 0);
    const totalFees = revenueInvoices.reduce((s, i) => s + Number(i.feeAmount), 0);
    const totalCredits = nonCorrection.reduce(
      (s, i) => s + i.allocations.reduce((a, al) => a + al.credits, 0),
      0
    );
    const invoiceCount = revenueInvoices.length;
    const avgTicket = invoiceCount > 0 ? totalRevenue / invoiceCount : 0;
    const activeVendors = new Set(revenueInvoices.map((i) => i.vendor.id)).size;

    const byMethod = {};
    for (const i of revenueInvoices) {
      const k = i.method || 'unknown';
      if (!byMethod[k]) byMethod[k] = { count: 0, revenue: 0 };
      byMethod[k].count += 1;
      byMethod[k].revenue += Number(i.baseAmount);
    }

    // Per-vendor breakdown for leaderboard (same range)
    const vendorMap = {};
    for (const i of revenueInvoices) {
      const k = i.vendor.id;
      if (!vendorMap[k]) {
        vendorMap[k] = {
          slug: i.vendor.slug,
          name: i.vendor.name,
          revenue: 0,
          credits: 0,
          count: 0,
          lastActive: null,
        };
      }
      vendorMap[k].revenue += Number(i.baseAmount);
      vendorMap[k].credits += i.allocations.reduce((a, al) => a + al.credits, 0);
      vendorMap[k].count += 1;
      const paid = i.paidAt ? new Date(i.paidAt) : null;
      if (paid && (!vendorMap[k].lastActive || paid > new Date(vendorMap[k].lastActive))) {
        vendorMap[k].lastActive = i.paidAt;
      }
    }
    const vendors = Object.values(vendorMap).sort((a, b) => b.revenue - a.revenue);

    res.json({
      range: { from: from || null, to: to || null },
      totals: {
        revenue: totalRevenue,
        fees: totalFees,
        credits: totalCredits,
        invoiceCount,
        avgTicket,
        activeVendors,
      },
      byMethod,
      vendors,
    });
  } catch (err) {
    logger.error('Stats error', { error: err });
    res.status(500).json({ error: 'Failed to fetch stats' });
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

// Master balance snapshot: latest reading per platform + 24h history for the
// dashboard card's sparkline. Also reports blocked invoice count.
router.get('/master-balances', async (req, res) => {
  try {
    const snapshot = await masterBalance.getSnapshot();
    const [p777History, iconnectHistory, blockedCount] = await Promise.all([
      masterBalance.getRecentHistory('PLAY777', 24),
      masterBalance.getRecentHistory('ICONNECT', 24),
      prisma.invoice.count({ where: { status: 'BLOCKED_LOW_MASTER' } }),
    ]);

    res.json({
      thresholds: snapshot.thresholds,
      play777: {
        ...snapshot.play777,
        history: p777History.map((h) => ({
          balance: Number(h.balance),
          tier: h.tier,
          source: h.source,
          checkedAt: h.checkedAt,
        })),
      },
      iconnect: {
        ...snapshot.iconnect,
        history: iconnectHistory.map((h) => ({
          balance: Number(h.balance),
          tier: h.tier,
          source: h.source,
          checkedAt: h.checkedAt,
        })),
      },
      blockedInvoiceCount: blockedCount,
    });
  } catch (err) {
    logger.error('Master balance snapshot error', { error: err });
    res.status(500).json({ error: 'Failed to fetch master balances' });
  }
});

// Manually trigger a master balance sweep (useful after a refill so the admin
// doesn't have to wait up to 2 hours for the scheduled sweep to catch up and
// auto-resume blocked invoices). Returns immediately; sweep runs in background.
router.post('/master-balances/sweep', async (req, res) => {
  res.json({ success: true, message: 'Master balance sweep started in background' });

  masterBalance.runScheduledSweep().catch((err) => {
    logger.error('Manual master balance sweep failed', { error: err.message });
  });
});

module.exports = router;
