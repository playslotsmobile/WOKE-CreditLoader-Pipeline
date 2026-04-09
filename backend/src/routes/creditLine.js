const express = require('express');
const router = express.Router();
const prisma = require('../db/client');
const creditLineService = require('../services/creditLineService');
const telegram = require('../services/telegram');
const autoloader = require('../services/autoloader');
const { validateInvoice } = require('../services/validator');
const { logger } = require('../services/logger');

// Get credit line balance for a vendor (public — used by vendor form)
router.get('/vendors/:slug/credit-line', async (req, res) => {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { slug: req.params.slug },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const cl = await creditLineService.getCreditLine(vendor.id);
    if (!cl) return res.json({ hasCreditLine: false });

    res.json({
      hasCreditLine: true,
      capAmount: Number(cl.capAmount),
      usedAmount: Number(cl.usedAmount),
      availableAmount: Number(cl.capAmount) - Number(cl.usedAmount),
    });
  } catch (err) {
    logger.error('Credit line balance error', { error: err });
    res.status(500).json({ error: 'Failed to fetch credit line balance' });
  }
});

// Submit credit line draw request
router.post('/submit-credit-line', async (req, res) => {
  try {
    const { vendorSlug, baseAmount, allocations } = req.body;

    const vendor = await prisma.vendor.findUnique({
      where: { slug: vendorSlug },
      include: { accounts: true },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const amount = Number(baseAmount);

    // Check credit line availability
    const check = await creditLineService.checkDrawAvailable(vendor.id, amount);
    if (!check.available) {
      return res.status(400).json({ error: check.error });
    }

    // Validate allocations (reuse invoice validator with no fees)
    const validation = validateInvoice({
      vendor,
      method: 'Credit Line',
      baseAmount: amount,
      feeAmount: 0,
      totalAmount: amount,
      allocations: allocations.map((a) => ({
        accountId: a.accountId,
        dollarAmount: Number(a.dollarAmount),
        credits: a.credits,
      })),
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Create invoice (no QB, no fee)
    const invoice = await prisma.invoice.create({
      data: {
        vendorId: vendor.id,
        method: 'Credit Line',
        baseAmount: amount,
        feeAmount: 0,
        totalAmount: amount,
        status: 'PAID', // Skip REQUESTED/PENDING — goes straight to loading
        paidAt: new Date(),
      },
    });

    // Create allocations
    const enrichedAllocations = [];
    for (const a of allocations) {
      if (a.dollarAmount <= 0) continue;

      let targetAccountId = a.accountId;
      const targetAccount = await prisma.vendorAccount.findUnique({ where: { id: a.accountId } });
      if (targetAccount && targetAccount.parentVendorAccId) {
        targetAccountId = targetAccount.parentVendorAccId;
      }

      const alloc = await prisma.invoiceAllocation.create({
        data: {
          invoiceId: invoice.id,
          vendorAccountId: targetAccountId,
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

    // Record the draw
    await creditLineService.recordDraw(vendor.id, invoice.id, amount);

    // Get updated balance for notifications
    const cl = await creditLineService.getCreditLine(vendor.id);
    const usedAmount = Number(cl.usedAmount);
    const capAmount = Number(cl.capAmount);

    // Send Telegram notification
    try {
      await telegram.sendCreditLineDraw(
        { name: vendor.name, telegramChatId: vendor.telegramChatId },
        { id: invoice.id, baseAmount: amount },
        enrichedAllocations,
        { usedAmount, capAmount }
      );
    } catch (err) {
      logger.error('Telegram credit line notification failed', { error: err });
    }

    logger.info('Credit line draw submitted', { invoiceId: invoice.id, amount });
    res.json({ success: true, invoiceId: invoice.id });

    // Auto-load in background
    autoloader.processInvoice(invoice.id).catch((err) => {
      logger.error('Credit line auto-load failed', { error: err });
    });
  } catch (err) {
    logger.error('Submit credit line error', { error: err });
    res.status(500).json({ error: 'Failed to submit credit line request' });
  }
});

module.exports = router;
