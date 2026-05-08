const prisma = require('../db/client');
const { logger } = require('./logger');

const log = logger.child({ service: 'loadResumption' });

/**
 * On startup, find invoices left in LOADING state from a previous process
 * (deploy, OOM, crash) and re-queue them. Without this they stay LOADING
 * forever and are silently dropped.
 *
 * Strategy:
 *  - LOADING invoices that paused mid-flight: revert to PAID + re-queue.
 *  - Cap a single resumption pass at 50 invoices to avoid a thundering-herd
 *    against the Play777/iConnect portals (autoloader queue is sequential
 *    so they'll process one at a time anyway, but we don't want a 1000-row
 *    backlog all firing into a single 2h window).
 */
async function resumeOrphanedLoads() {
  // Lazy require — autoloader pulls Playwright transitively.
  const autoloader = require('./autoloader');

  const orphans = await prisma.invoice.findMany({
    where: { status: 'LOADING' },
    orderBy: { submittedAt: 'asc' },
    take: 50,
  });

  if (orphans.length === 0) {
    log.info('No orphaned LOADING invoices to resume');
    return { resumed: 0 };
  }

  log.warn(`Found ${orphans.length} orphaned LOADING invoice(s) — reverting to PAID and re-queuing`);

  for (const inv of orphans) {
    try {
      // Revert any PENDING loadJobs back to PENDING (they already are, but
      // be explicit), and the invoice to PAID so the autoloader picks it up.
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'PAID' },
      });
      autoloader.processInvoice(inv.id).catch((err) => {
        log.error('Resumed-invoice autoloader failed', { invoiceId: inv.id, error: err.message });
      });
      log.info('Resumed orphaned invoice', { invoiceId: inv.id, vendorId: inv.vendorId });
    } catch (err) {
      log.error('Failed to resume orphaned invoice', { invoiceId: inv.id, error: err.message });
    }
  }

  return { resumed: orphans.length, invoiceIds: orphans.map((i) => i.id) };
}

module.exports = { resumeOrphanedLoads };
