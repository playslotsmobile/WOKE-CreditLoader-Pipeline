const prisma = require('../db/client');
const quickbooks = require('./quickbooks');
const returnsService = require('./returnsService');
const { logger } = require('./logger');

const log = logger.child ? logger.child({ service: 'returnsDetector' }) : logger;

// Payment-processor statuses that mean the money came back after we'd already
// been paid (and, usually, already delivered credits). Compared case-insensitively.
const RETURN_STATES = new Set([
  'DISPUTED', 'RETURNED', 'FAILED', 'DECLINED', 'VOIDED',
  'CANCELED', 'CANCELLED', 'REFUNDED', 'CHARGEBACK',
]);

// Default look-back. ACH disputes/returns can surface weeks after payment, so
// we keep re-checking each paid invoice for a while. 90d covers the realistic
// dispute window with margin.
const DEFAULT_WINDOW_DAYS = 90;

// Resolve the QuickBooks Payments transaction id (CCTransId) for one of our
// invoices: invoice (by DocNumber) -> linked Payment -> CreditChargeResponse.
async function resolveCcTransId(qbInvoiceId) {
  const ir = await quickbooks.qbRequest(
    'GET',
    'query?query=' + encodeURIComponent(`SELECT Id, DocNumber, LinkedTxn FROM Invoice WHERE DocNumber='${qbInvoiceId}'`)
  );
  const inv = ir.QueryResponse && ir.QueryResponse.Invoice && ir.QueryResponse.Invoice[0];
  if (!inv || !inv.LinkedTxn || !inv.LinkedTxn.length) return null;
  const payLink = inv.LinkedTxn.find((t) => t.TxnType === 'Payment') || inv.LinkedTxn[0];
  if (!payLink) return null;
  const pr = await quickbooks.qbRequest('GET', `payment/${payLink.TxnId}`);
  const ccr = pr.Payment
    && pr.Payment.CreditCardPayment
    && pr.Payment.CreditCardPayment.CreditChargeResponse;
  return ccr ? ccr.CCTransId : null;
}

/**
 * Scan recently-loaded invoices for payment returns/disputes via the QB
 * Payments API. Any invoice whose payment status is in RETURN_STATES gets
 * recorded (recordReturn dedups on qbInvoiceId and alerts the main group on
 * first detection).
 *
 * Only checks invoices we actually LOADED (delivered credits → a return hurts),
 * that have a QB invoice number, were paid within the window, and aren't
 * already recorded as returns (saves API calls).
 *
 * @returns {Promise<{checked:number, returnsFound:Array, newlyRecorded:number, errors:number}>}
 */
async function scanRecentReturns({ windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Candidate invoices: loaded, card/ACH (has qbInvoiceId), paid in window.
  const candidates = await prisma.invoice.findMany({
    where: {
      status: 'LOADED',
      qbInvoiceId: { not: null },
      paidAt: { gte: since },
    },
    include: { vendor: { select: { name: true } } },
    orderBy: { paidAt: 'desc' },
  });

  // Skip ones already recorded as returns.
  const known = new Set(
    (await prisma.return.findMany({ select: { qbInvoiceId: true } })).map((r) => r.qbInvoiceId)
  );

  const toCheck = candidates.filter((i) => !known.has(i.qbInvoiceId));
  log.info('Returns scan started', { windowDays, candidates: candidates.length, toCheck: toCheck.length });

  const returnsFound = [];
  let checked = 0;
  let newlyRecorded = 0;
  let errors = 0;

  for (const inv of toCheck) {
    try {
      const ccTransId = await resolveCcTransId(inv.qbInvoiceId);
      if (!ccTransId) continue; // cash/wire/credit-line — no processor txn
      const txn = await quickbooks.getPaymentTxnStatus(ccTransId);
      checked += 1;
      if (!txn) continue;
      const status = String(txn.status).toUpperCase();
      if (RETURN_STATES.has(status)) {
        const amount = txn.raw && txn.raw.amount ? Number(txn.raw.amount) : undefined;
        const bank = txn.raw && txn.raw.bankAccount ? txn.raw.bankAccount.name : null;
        const ip = txn.raw && txn.raw.context && txn.raw.context.deviceInfo
          ? txn.raw.context.deviceInfo.ipAddress : null;
        const noteBits = [`${txn.kind} status=${status}`];
        if (bank) noteBits.push(`bank=${bank}`);
        if (ip) noteBits.push(`ip=${ip}`);
        const result = await returnsService.recordReturn({
          qbInvoiceId: inv.qbInvoiceId,
          amountLost: amount,
          returnDate: txn.raw && txn.raw.created ? txn.raw.created : undefined,
          source: 'payments_api',
          note: noteBits.join(' '),
        });
        if (result.isNew) newlyRecorded += 1;
        returnsFound.push({
          qbInvoiceId: inv.qbInvoiceId, vendor: inv.vendor.name,
          status, kind: txn.kind, amount, bank, ip, isNew: result.isNew,
        });
        log.warn('Return detected via Payments API', {
          qbInvoiceId: inv.qbInvoiceId, vendor: inv.vendor.name, status, kind: txn.kind, amount, isNew: result.isNew,
        });
      }
    } catch (err) {
      errors += 1;
      log.error('Returns scan: per-invoice check failed', { qbInvoiceId: inv.qbInvoiceId, error: err.message });
    }
  }

  log.info('Returns scan complete', { checked, returnsFound: returnsFound.length, newlyRecorded, errors });
  return { checked, returnsFound, newlyRecorded, errors };
}

// Schedule: initial run shortly after boot, then every 6h. Returns surface on
// the bank's timeline (days), so 6h polling is ample for "know when it happens".
function startReturnsDetector() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setTimeout(() => {
    scanRecentReturns().catch((e) => log.error('Initial returns scan failed', { error: e.message }));
  }, 3 * 60 * 1000); // 3 min after boot
  setInterval(() => {
    scanRecentReturns().catch((e) => log.error('Scheduled returns scan failed', { error: e.message }));
  }, SIX_HOURS);
  log.info('Returns detector scheduled: first run in 3 min, then every 6h');
}

module.exports = { scanRecentReturns, startReturnsDetector, resolveCcTransId, RETURN_STATES };
