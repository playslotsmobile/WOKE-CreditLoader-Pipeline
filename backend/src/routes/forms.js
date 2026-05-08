const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const quickbooks = require('../services/quickbooks');
const telegram = require('../services/telegram');
const autoloader = require('../services/autoloader');
const { validateInvoice, validateCorrection } = require('../services/validator');
const prisma = require('../db/client');
const creditLineService = require('../services/creditLineService');
const { resolveTargetAccountId } = require('../services/allocationHelpers');
const idempotency = require('../services/idempotency');
const { logger } = require('../services/logger');

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      // Cryptographically-random filename so /api/uploads URLs aren't
      // enumerable. Sanitize the extension to a small allowlist.
      const rawExt = path.extname(file.originalname).toLowerCase();
      const safeExt = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif'].includes(rawExt) ? rawExt : '';
      const random = crypto.randomBytes(16).toString('hex');
      cb(null, `wire-${random}${safeExt}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okMime = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif))$/.test(file.mimetype);
    cb(okMime ? null : new Error('Unsupported file type'), okMime);
  },
});

router.post('/submit-invoice', upload.single('wireReceipt'), async (req, res) => {
  try {
    // Wire submissions send data as JSON string in 'data' field
    let body = req.body;
    if (body.data) {
      body = JSON.parse(body.data);
    }
    const { vendorSlug, method, baseAmount, feeAmount, totalAmount, allocations } = body;
    const clRepayment = body.creditLineRepayment ? Number(body.creditLineRepayment) : 0;

    // Idempotency: if the client provides an Idempotency-Key header (e.g., on
    // double-submit retry), replay the previous response instead of creating
    // a second invoice + QB doc + credit-line draw.
    const idemKey = req.get('Idempotency-Key');
    if (idemKey) {
      const cached = await idempotency.check(idemKey, body);
      if (cached?.conflict) {
        return res.status(409).json({ error: 'Idempotency key reused with different payload' });
      }
      if (cached?.hit) {
        logger.info('Idempotency replay (submit-invoice)', { idemKey });
        return res.json(cached.response);
      }
    }

    const vendor = await prisma.vendor.findUnique({
      where: { slug: vendorSlug },
      include: { accounts: true },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    if (method === 'Cash' && !vendor.cashAllowed) {
      return res.status(403).json({ error: 'Cash not enabled for this vendor' });
    }

    const isWire = method === 'Wire';
    const isCash = method === 'Cash';
    const isOffline = isWire || isCash;
    let methodLabel;
    if (isWire) methodLabel = 'Wire';
    else if (isCash) methodLabel = 'Cash';
    else if (method === 'ACH') methodLabel = 'ACH (1%)';
    else methodLabel = 'Credit/Debit (3%)';

    const validation = validateInvoice({
      vendor,
      method: methodLabel,
      baseAmount: Number(baseAmount),
      feeAmount: Number(feeAmount),
      totalAmount: Number(totalAmount),
      allocations: allocations.map((a) => ({ accountId: a.accountId, dollarAmount: Number(a.dollarAmount), credits: a.credits })),
      creditLineRepayment: clRepayment,
    });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Validate credit line repayment before creating invoice
    if (clRepayment > 0) {
      const cl = await creditLineService.getCreditLine(vendor.id);
      if (!cl) {
        return res.status(400).json({ error: 'Vendor does not have a credit line' });
      }
      if (Number(cl.usedAmount) <= 0) {
        return res.status(400).json({ error: 'Credit line has no outstanding balance to repay' });
      }
    }

    // Create invoice in DB. Repayment intent stored as a typed column on the
    // Invoice itself instead of a Setting kv (used to be keyed
    // credit_line_repayment_<id> — moved to the column for type safety + atomicity).
    const invoice = await prisma.invoice.create({
      data: {
        vendorId: vendor.id,
        method: methodLabel,
        baseAmount,
        feeAmount,
        totalAmount,
        status: isOffline ? 'PENDING' : 'REQUESTED',
        wireReceiptPath: req.file ? req.file.filename : null,
        creditLineRepaymentIntent: clRepayment > 0 ? clRepayment : null,
      },
    });

    // Create allocations in DB
    const enrichedAllocations = [];
    for (const a of allocations) {
      if (a.dollarAmount <= 0) continue;

      // If this is an operator account with a parent vendor, swap to the parent
      // so the chain load works (parent → operator)
      const targetAccountId = await resolveTargetAccountId(a.accountId);

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

    // (Repayment intent now lives on the Invoice row above — no separate
    // Setting write needed.)

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

    // Backup wire receipt to secondary storage
    if (req.file) {
      logger.info('Wire receipt saved to DB', { filename: req.file.filename, invoiceId: invoice.id });
      // Backup wire receipt
      const backupDir = '/var/backups/creditloader/receipts';
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(req.file.path, path.join(backupDir, req.file.filename));
      } catch (backupErr) {
        logger.error('Wire receipt backup failed', { error: backupErr });
      }
    }

    if (isCash) {
      try {
        await telegram.sendCashSubmitted(vendorData, invoiceData, enrichedAllocations);
      } catch (err) {
        logger.error('Telegram cash notification failed', { error: err });
      }
    } else if (isWire) {
      try {
        await telegram.sendWireSubmitted(vendorData, invoiceData, enrichedAllocations, req.file ? req.file.path : null);
      } catch (err) {
        logger.error('Telegram wire notification failed', { error: err });
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
        logger.error('QB invoice creation failed', { error: err });
        invoiceData.qbInvoiceId = 'QB-PENDING';
      }

      try {
        await telegram.sendInvoiceSent(vendorData, invoiceData, enrichedAllocations);
      } catch (err) {
        logger.error('Telegram invoice notification failed', { error: err });
      }
    }

    logger.info('Invoice saved', { invoiceId: invoice.id });
    const response = { success: true, invoiceId: invoice.id, qbInvoiceId: invoiceData.qbInvoiceId };
    if (idemKey) await idempotency.record(idemKey, body, response);
    res.json(response);
  } catch (err) {
    logger.error('Submit invoice error', { error: err });
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

    const validation = validateCorrection({ vendor, sourceAccountId, corrections });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    const totalCredits = corrections.reduce((sum, c) => sum + c.credits, 0);

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
      logger.error('Telegram correction notification failed', { error: err });
    }

    logger.info('Correction saved', { invoiceId: invoice.id });
    res.json({ success: true, invoiceId: invoice.id });

    // Auto-trigger correction load immediately
    autoloader.processInvoice(invoice.id).catch((err) => {
      logger.error('Correction auto-load failed', { error: err });
    });
  } catch (err) {
    logger.error('Submit correction error', { error: err });
    res.status(500).json({ error: 'Failed to submit correction' });
  }
});

module.exports = router;
