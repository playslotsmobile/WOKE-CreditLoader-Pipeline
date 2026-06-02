const prisma = require('../db/client');
const { logger } = require('./logger');
const telegram = require('./telegram');

const log = logger.child ? logger.child({ service: 'returns' }) : logger;

function fmtMoney(n) {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Record a payment return / chargeback.
 *
 * Idempotent on qbInvoiceId — calling twice for the same QB invoice updates
 * the existing row and does NOT re-alert. The Telegram alert (to the MAIN
 * admin group, never a vendor group) fires only on the first insert.
 *
 * Enrichment order for vendor / amount / credits:
 *   1. Our pipeline invoice matched by qbInvoiceId (gives vendor, method,
 *      totalAmount, and the credits we actually delivered via SUCCESS jobs).
 *   2. Caller-provided overrides (amountLost, vendorName) — needed for returns
 *      that predate our DB (e.g. QB #5796).
 *
 * @param {object} args
 * @param {string} args.qbInvoiceId   QB DocNumber (required)
 * @param {number} [args.amountLost]  Override cash lost (defaults to invoice total)
 * @param {string} [args.vendorName]  Override vendor name (for legacy/unmapped)
 * @param {Date|string} [args.returnDate]
 * @param {string} [args.source]      'manual' | 'qbo_scrape' | 'payments_api'
 * @param {string} [args.note]
 * @returns {Promise<{ record: object, isNew: boolean, priorCount: number, totalVendorLost: number }>}
 */
async function recordReturn({ qbInvoiceId, amountLost, vendorName, returnDate, source = 'manual', note } = {}) {
  if (!qbInvoiceId) throw new Error('recordReturn requires qbInvoiceId');
  qbInvoiceId = String(qbInvoiceId);

  // 1. Enrich from our pipeline
  const invoice = await prisma.invoice.findFirst({
    where: { qbInvoiceId },
    include: {
      vendor: true,
      loadJobs: { include: { vendorAccount: true } },
    },
    orderBy: { id: 'desc' },
  });

  const creditsLost = invoice
    ? invoice.loadJobs.filter((j) => j.status === 'SUCCESS').reduce((s, j) => s + j.creditsAmount, 0)
    : 0;
  const creditTargets = invoice
    ? invoice.loadJobs.filter((j) => j.status === 'SUCCESS').map((j) => `${j.vendorAccount.username}(${j.creditsAmount})`)
    : [];

  const resolvedAmount = amountLost != null
    ? Number(amountLost)
    : (invoice ? Number(invoice.totalAmount) : null);
  if (resolvedAmount == null) {
    throw new Error(`recordReturn: amountLost required for QB #${qbInvoiceId} (no matching pipeline invoice to infer it)`);
  }

  const resolvedVendorName = invoice?.vendor?.name || vendorName || 'UNKNOWN';

  // 2. Upsert (idempotent). Detect new-vs-existing for alert gating.
  const existing = await prisma.return.findUnique({ where: { qbInvoiceId } });

  const data = {
    invoiceId: invoice?.id ?? null,
    vendorId: invoice?.vendorId ?? null,
    vendorName: resolvedVendorName,
    businessName: invoice?.vendor?.businessName ?? null,
    amountLost: resolvedAmount.toFixed(2),
    creditsLost,
    method: invoice?.method ?? null,
    returnDate: returnDate ? new Date(returnDate) : null,
    source,
    note: note ?? null,
  };

  const record = existing
    ? await prisma.return.update({ where: { qbInvoiceId }, data })
    : await prisma.return.create({ data: { qbInvoiceId, ...data } });

  // 3. Repeat-offender stats (by vendorId when mapped, else by vendorName)
  const vendorWhere = record.vendorId
    ? { vendorId: record.vendorId }
    : { vendorName: record.vendorName };
  const vendorReturns = await prisma.return.findMany({ where: vendorWhere });
  const priorCount = vendorReturns.length; // includes this one
  const totalVendorLost = vendorReturns.reduce((s, r) => s + Number(r.amountLost), 0);

  const isNew = !existing;

  // 4. Alert the MAIN admin group on first detection only.
  if (isNew) {
    try {
      const creditsLine = creditsLost > 0
        ? `Credits delivered (unrecoverable): *-${creditsLost.toLocaleString('en-US')}*${creditTargets.length ? ` → ${creditTargets.join(', ')}` : ''}`
        : `Credits delivered: _none recorded in pipeline_`;
      const repeatLine = priorCount > 1
        ? `\n\n🔁 *REPEAT OFFENDER* — return #${priorCount} from this vendor. Total clawed back: *${fmtMoney(totalVendorLost)}*.`
        : '';
      const businessLine = record.businessName && record.businessName !== record.vendorName
        ? ` (${record.businessName})`
        : '';
      const msg =
        `🚨 *PAYMENT RETURN — money clawed back*\n\n` +
        `Vendor: *${record.vendorName}*${businessLine}\n` +
        `QB Invoice: *#${qbInvoiceId}*\n` +
        `Cash lost: *-${fmtMoney(resolvedAmount)}*\n` +
        `${creditsLine}\n` +
        (record.method ? `Method: ${record.method}\n` : '') +
        repeatLine +
        `\n\nGo after this one.`;
      await telegram.bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, msg, { parse_mode: 'Markdown' });
      log.warn('Return recorded + alerted', { qbInvoiceId, vendor: record.vendorName, amountLost: resolvedAmount, creditsLost, priorCount });
    } catch (alertErr) {
      log.error('Return Telegram alert failed', { qbInvoiceId, error: alertErr.message });
    }
  }

  return { record, isNew, priorCount, totalVendorLost };
}

/**
 * List all returns with dashboard aggregates: total cash lost, total credits
 * lost, and a per-vendor ranking (worst offenders first).
 */
async function listReturns() {
  const rows = await prisma.return.findMany({ orderBy: { detectedAt: 'desc' } });

  const totalCashLost = rows.reduce((s, r) => s + Number(r.amountLost), 0);
  const totalCreditsLost = rows.reduce((s, r) => s + r.creditsLost, 0);

  const byVendorMap = new Map();
  for (const r of rows) {
    const key = r.vendorId != null ? `v${r.vendorId}` : `n:${r.vendorName}`;
    const agg = byVendorMap.get(key) || {
      vendorId: r.vendorId, vendorName: r.vendorName, businessName: r.businessName,
      count: 0, cashLost: 0, creditsLost: 0,
    };
    agg.count += 1;
    agg.cashLost += Number(r.amountLost);
    agg.creditsLost += r.creditsLost;
    byVendorMap.set(key, agg);
  }
  const byVendor = [...byVendorMap.values()].sort((a, b) => b.cashLost - a.cashLost);

  return {
    returns: rows,
    totals: { count: rows.length, totalCashLost, totalCreditsLost },
    byVendor,
  };
}

module.exports = { recordReturn, listReturns };
