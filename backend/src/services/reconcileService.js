const prisma = require('../db/client');
const quickbooks = require('./quickbooks');
const telegram = require('./telegram');
const { logger } = require('./logger');

const log = logger.child ? logger.child({ service: 'reconcile' }) : logger;

// Singleton kv holding the QB DocNumbers we've already alerted on, so the
// daily check doesn't re-spam the same known discrepancy every morning.
const ALERTED_KEY = 'reconcile_alerted_docs';

async function getAlerted() {
  try {
    const s = await prisma.setting.findUnique({ where: { key: ALERTED_KEY } });
    return new Set(JSON.parse(s?.value || '[]'));
  } catch { return new Set(); }
}
async function saveAlerted(set) {
  const value = JSON.stringify([...set]);
  await prisma.setting.upsert({
    where: { key: ALERTED_KEY },
    update: { value },
    create: { key: ALERTED_KEY, value },
  });
}

/**
 * Reconcile loaded invoices against QuickBooks: confirm every invoice we
 * delivered credits for is actually fully paid in QB. Anything we LOADED that
 * QB shows as still-owing, voided, or missing is a "loaded without paying"
 * red flag — alerted to the MAIN admin group (deduped so a known issue isn't
 * re-alerted daily).
 *
 * Windowed by loadedAt (default 21d) so the daily run is bounded and focuses
 * on recent loads — where a new "loaded without paying" case would appear.
 * Pass a large windowDays for a full historical audit on demand.
 *
 * @returns {Promise<{checked:number, paid:number, discrepancies:Array, newlyAlerted:number}>}
 */
async function reconcileLoadedVsPaid({ windowDays = 21 } = {}) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const loaded = await prisma.invoice.findMany({
    where: { status: 'LOADED', qbInvoiceId: { not: null }, loadedAt: { gte: since } },
    include: { vendor: { select: { name: true } } },
    orderBy: { id: 'desc' },
  });

  const byDoc = {};
  loaded.forEach((i) => { byDoc[i.qbInvoiceId] = i; });
  const docs = Object.keys(byDoc);

  // Batch-query QB balances (40 DocNumbers per query)
  const qbBal = {};
  for (let k = 0; k < docs.length; k += 40) {
    const grp = docs.slice(k, k + 40).map((d) => `'${d}'`).join(',');
    const q = encodeURIComponent(`SELECT DocNumber,TotalAmt,Balance,PrivateNote FROM Invoice WHERE DocNumber IN (${grp}) MAXRESULTS 1000`);
    const r = await quickbooks.qbRequest('GET', 'query?query=' + q);
    for (const qi of (r.QueryResponse?.Invoice || [])) {
      qbBal[qi.DocNumber] = { bal: Number(qi.Balance), total: Number(qi.TotalAmt), note: qi.PrivateNote || '' };
    }
  }

  const discrepancies = [];
  let paid = 0;
  for (const doc of docs) {
    const qb = qbBal[doc];
    const inv = byDoc[doc];
    if (!qb) { discrepancies.push({ doc, id: inv.id, vendor: inv.vendor.name, kind: 'NOT_IN_QB' }); continue; }
    if (/void/i.test(qb.note) || qb.total === 0) { discrepancies.push({ doc, id: inv.id, vendor: inv.vendor.name, kind: 'VOIDED', balance: qb.bal }); continue; }
    if (qb.bal === 0) { paid++; continue; }
    discrepancies.push({ doc, id: inv.id, vendor: inv.vendor.name, kind: 'OWING', balance: qb.bal, total: qb.total });
  }

  // Alert only NEW discrepancies
  const alerted = await getAlerted();
  const fresh = discrepancies.filter((d) => !alerted.has(d.doc));
  if (fresh.length) {
    const lines = fresh.map((d) => {
      if (d.kind === 'OWING') return `• #${d.doc} (${d.vendor}) — loaded, but QB shows *$${d.balance}* of $${d.total} still OWING`;
      if (d.kind === 'VOIDED') return `• #${d.doc} (${d.vendor}) — loaded, but VOIDED in QB`;
      return `• #${d.doc} (${d.vendor}) — loaded, but NOT FOUND in QB`;
    }).join('\n');
    try {
      await telegram.bot.sendMessage(
        process.env.TELEGRAM_ADMIN_CHAT_ID,
        `🛑 *LOADED-WITHOUT-PAYMENT — daily reconciliation*\n\n` +
        `${fresh.length} invoice(s) we delivered credits for are NOT fully paid in QuickBooks:\n\n${lines}\n\n` +
        `Someone may have received credits without paying. Investigate.`,
        { parse_mode: 'Markdown' }
      );
      log.warn('Reconcile discrepancy alert sent', { count: fresh.length, docs: fresh.map((d) => d.doc) });
    } catch (e) {
      log.error('Reconcile alert send failed', { error: e.message });
    }
    fresh.forEach((d) => alerted.add(d.doc));
    await saveAlerted(alerted);
  }

  log.info('Reconciliation complete', { windowDays, checked: docs.length, paid, discrepancies: discrepancies.length, newlyAlerted: fresh.length });
  return { checked: docs.length, paid, discrepancies, newlyAlerted: fresh.length };
}

// Seed the alerted set with known/accepted discrepancies so the daily check
// doesn't re-alert them (idempotent).
async function seedAlerted(docNumbers = []) {
  const alerted = await getAlerted();
  docNumbers.forEach((d) => alerted.add(String(d)));
  await saveAlerted(alerted);
  return [...alerted];
}

module.exports = { reconcileLoadedVsPaid, seedAlerted };
