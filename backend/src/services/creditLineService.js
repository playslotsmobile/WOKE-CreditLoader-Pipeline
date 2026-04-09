const prisma = require('../db/client');
const { logger } = require('./logger');

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

  const [transaction] = await prisma.$transaction([
    prisma.creditLineTransaction.create({
      data: {
        creditLineId: cl.id,
        invoiceId,
        type: 'DRAW',
        amount,
        balanceBefore,
        balanceAfter,
      },
    }),
    prisma.creditLine.update({
      where: { id: cl.id },
      data: { usedAmount: balanceAfter },
    }),
  ]);

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

  const [transaction] = await prisma.$transaction([
    prisma.creditLineTransaction.create({
      data: {
        creditLineId: cl.id,
        invoiceId,
        type: 'REPAYMENT',
        amount,
        balanceBefore,
        balanceAfter,
      },
    }),
    prisma.creditLine.update({
      where: { id: cl.id },
      data: { usedAmount: balanceAfter },
    }),
  ]);

  logger.info('Credit line repayment recorded', {
    vendorId, invoiceId, amount, balanceBefore, balanceAfter,
  });

  return transaction;
}

module.exports = {
  getCreditLine,
  checkDrawAvailable,
  recordDraw,
  recordRepayment,
};
