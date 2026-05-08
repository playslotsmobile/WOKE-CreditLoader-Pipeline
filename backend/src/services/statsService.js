const prisma = require('./../db/client');

/**
 * Vendor leaderboard aggregation. Pushes work into SQL as far as Prisma
 * groupBy supports it, then folds the credit-line balances in JS (different
 * table). This is the slim path: O(invoices) bytes scanned per request, vs
 * the original O(invoices * allocations) JS-side fan-out which OOM'd at scale.
 */
async function computeVendorLeaderboard() {
  // 1. Aggregate invoice $$ + count per vendor + method bucket via SQL.
  const invoiceAgg = await prisma.invoice.groupBy({
    by: ['vendorId', 'method'],
    _sum: { baseAmount: true },
    _count: { _all: true },
    _max: { submittedAt: true },
  });

  // 2. Sum credits per vendor (allocations are on a separate table).
  const credits = await prisma.invoiceAllocation.groupBy({
    by: ['invoiceId'],
    _sum: { credits: true },
  });
  const creditsByInvoice = new Map(credits.map((c) => [c.invoiceId, c._sum.credits || 0]));

  // We still need the invoice-level join to map credits to vendor + method.
  // Fetch only id+vendorId+method (lightweight).
  const invoiceIndex = await prisma.invoice.findMany({
    select: { id: true, vendorId: true, method: true },
  });
  const creditsByVendor = new Map();
  for (const inv of invoiceIndex) {
    if (inv.method === 'Correction') continue;
    const v = creditsByVendor.get(inv.vendorId) || 0;
    creditsByVendor.set(inv.vendorId, v + (creditsByInvoice.get(inv.id) || 0));
  }

  // 3. Vendors + credit lines, both small tables.
  const [vendors, creditLines] = await Promise.all([
    prisma.vendor.findMany({
      select: { id: true, slug: true, name: true, businessName: true },
    }),
    prisma.creditLine.findMany(),
  ]);
  const clByVendor = Object.fromEntries(creditLines.map((cl) => [cl.vendorId, cl]));

  // 4. Fold per-vendor numbers from the SQL aggregations.
  const perVendor = new Map();
  for (const v of vendors) {
    perVendor.set(v.id, {
      slug: v.slug, name: v.name, business: v.businessName,
      totalSpent: 0, totalCreditLine: 0, invoiceCount: 0, creditLineCount: 0,
      lastActive: null,
    });
  }
  for (const row of invoiceAgg) {
    const acc = perVendor.get(row.vendorId);
    if (!acc) continue;
    const sum = Number(row._sum.baseAmount || 0);
    if (row.method === 'Credit Line') {
      acc.totalCreditLine += sum;
      acc.creditLineCount += row._count._all;
    } else if (row.method !== 'Correction') {
      acc.totalSpent += sum;
      acc.invoiceCount += row._count._all;
    }
    if (row._max.submittedAt && (!acc.lastActive || row._max.submittedAt > acc.lastActive)) {
      acc.lastActive = row._max.submittedAt;
    }
  }

  const stats = [];
  for (const [vendorId, acc] of perVendor) {
    const cl = clByVendor[vendorId];
    const creditLineOwed = cl ? Number(cl.usedAmount) : 0;
    const creditLineCap = cl ? Number(cl.capAmount) : 0;
    stats.push({
      ...acc,
      totalCredits: creditsByVendor.get(vendorId) || 0,
      creditLineOwed,
      creditLineCap,
    });
  }

  return stats
    .filter((v) => v.invoiceCount > 0 || v.creditLineCount > 0 || v.creditLineOwed > 0)
    .sort((a, b) => (b.totalSpent + b.totalCreditLine) - (a.totalSpent + a.totalCreditLine));
}

module.exports = { computeVendorLeaderboard };
