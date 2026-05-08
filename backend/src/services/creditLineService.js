const prisma = require('../db/client');
const { logger } = require('./logger');
const telegram = require('./telegram');

/**
 * Get credit line for a vendor. Returns null if vendor has no credit line.
 */
async function getCreditLine(vendorId) {
  return prisma.creditLine.findUnique({
    where: { vendorId },
  });
}

/**
 * Check if a draw amount is available.
 * Returns { available: true, remaining } or { available: false, remaining, error }.
 */
async function checkDrawAvailable(vendorId, amount) {
  const cl = await getCreditLine(vendorId);
  if (!cl) {
    return { available: false, remaining: 0, error: 'No credit line for this vendor' };
  }

  const remaining = Number(cl.capAmount) - Number(cl.usedAmount);
  if (amount > remaining) {
    return {
      available: false,
      remaining,
      error: `Requested $${amount.toLocaleString()} exceeds available credit line of $${remaining.toLocaleString()}`,
    };
  }

  return { available: true, remaining };
}

/**
 * Record a draw (credit line request). Increases usedAmount.
 * Returns the created transaction.
 */
async function recordDraw(vendorId, invoiceId, amount) {
  const cl = await getCreditLine(vendorId);
  if (!cl) throw new Error('No credit line for this vendor');

  const balanceBefore = Number(cl.usedAmount);
  const balanceAfter = balanceBefore + amount;

  if (balanceAfter > Number(cl.capAmount)) {
    throw new Error(`Draw of $${amount} would exceed cap of $${cl.capAmount}`);
  }

  // Optimistic concurrency: only succeed if usedAmount is still what we read.
  // If a concurrent draw raced ahead, the conditional update affects 0 rows
  // and we abort instead of double-spending past the cap.
  const transaction = await prisma.$transaction(async (tx) => {
    const updated = await tx.creditLine.updateMany({
      where: { id: cl.id, usedAmount: balanceBefore },
      data: { usedAmount: balanceAfter },
    });
    if (updated.count !== 1) {
      throw new Error('Credit line draw race detected — please retry');
    }
    return tx.creditLineTransaction.create({
      data: {
        creditLineId: cl.id,
        invoiceId,
        type: 'DRAW',
        amount,
        balanceBefore,
        balanceAfter,
      },
    });
  });

  logger.info('Credit line draw recorded', {
    vendorId, invoiceId, amount, balanceBefore, balanceAfter,
  });

  return transaction;
}

/**
 * Record a repayment. Decreases usedAmount.
 * Returns the created transaction.
 */
async function recordRepayment(vendorId, invoiceId, amount) {
  const cl = await getCreditLine(vendorId);
  if (!cl) throw new Error('No credit line for this vendor');

  const balanceBefore = Number(cl.usedAmount);
  const balanceAfter = Math.max(0, balanceBefore - amount);

  // Same optimistic concurrency as recordDraw — repayment vs draw races
  // would otherwise lose one of the writes.
  const transaction = await prisma.$transaction(async (tx) => {
    const updated = await tx.creditLine.updateMany({
      where: { id: cl.id, usedAmount: balanceBefore },
      data: { usedAmount: balanceAfter },
    });
    if (updated.count !== 1) {
      throw new Error('Credit line repayment race detected — please retry');
    }
    return tx.creditLineTransaction.create({
      data: {
        creditLineId: cl.id,
        invoiceId,
        type: 'REPAYMENT',
        amount,
        balanceBefore,
        balanceAfter,
      },
    });
  });

  logger.info('Credit line repayment recorded', {
    vendorId, invoiceId, amount, balanceBefore, balanceAfter,
  });

  return transaction;
}

/**
 * Processes a pending credit line repayment intent for an invoice. Does
 * nothing if no repayment setting exists. Idempotent — the setting is
 * deleted after processing, so repeat calls are safe.
 *
 * Called from:
 *   - webhookProcessor (QB card/ACH payment confirmed)
 *   - admin /confirm-wire and /confirm-cash (offline payment confirmed)
 *
 * invoice must include { id, vendorId, vendor: { name, telegramChatId } }.
 */
async function processRepaymentIntent(invoice) {
  try {
    // Read intent from Invoice column (post-migration). Fall back to legacy
    // Setting kv if column is null and Setting still exists — covers a
    // brief window where rows pre-date the typed-column migration.
    let repaymentAmount = invoice.creditLineRepaymentIntent != null
      ? Number(invoice.creditLineRepaymentIntent)
      : 0;

    if (!repaymentAmount) {
      const legacy = await prisma.setting.findUnique({
        where: { key: `credit_line_repayment_${invoice.id}` },
      });
      if (legacy) repaymentAmount = Number(legacy.value);
    }
    if (!repaymentAmount || repaymentAmount <= 0) return;

    await recordRepayment(invoice.vendorId, invoice.id, repaymentAmount);
    const cl = await getCreditLine(invoice.vendorId);

    await telegram.sendCreditLineRepayment(
      { name: invoice.vendor.name, telegramChatId: invoice.vendor.telegramChatId },
      repaymentAmount,
      { usedAmount: Number(cl.usedAmount), capAmount: Number(cl.capAmount) }
    );

    // Clear intent on the Invoice (idempotent for re-runs) and remove any
    // legacy Setting row.
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { creditLineRepaymentIntent: null },
    }).catch(() => {});
    await prisma.setting.deleteMany({ where: { key: `credit_line_repayment_${invoice.id}` } });

    logger.info('Credit line repayment processed', {
      invoiceId: invoice.id,
      vendorId: invoice.vendorId,
      repaymentAmount,
    });
  } catch (err) {
    logger.error('Credit line repayment processing failed', { error: err, invoiceId: invoice.id });
  }
}

module.exports = {
  getCreditLine,
  checkDrawAvailable,
  recordDraw,
  recordRepayment,
  processRepaymentIntent,
};
