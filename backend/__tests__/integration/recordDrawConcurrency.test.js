/**
 * Real-DB integration test for credit-line draw race condition.
 * Per feedback_obsidian_protocol: integration tests must hit a real DB.
 *
 * Skips automatically when DATABASE_URL isn't set (CI without DB), so the
 * unit-test suite still runs everywhere. Run with a test DB pointing at:
 *   DATABASE_URL=postgresql://...test_db... npm test
 *
 * Verifies that two concurrent recordDraw calls for the same vendor cannot
 * both succeed past the cap (the optimistic-concurrency fix in Deploy 1 #8).
 */
const skip = !process.env.DATABASE_URL || process.env.SKIP_DB_TESTS === 'true';
const d = skip ? describe.skip : describe;

d('recordDraw concurrency (real DB)', () => {
  let prisma;
  let creditLineService;
  let vendorId;
  let creditLineId;
  const CAP = 1000;

  beforeAll(async () => {
    prisma = require('../../src/db/client');
    creditLineService = require('../../src/services/creditLineService');

    const v = await prisma.vendor.create({
      data: {
        slug: `cltest-${Date.now()}`,
        name: 'CL Test',
        businessName: 'CL Test LLC',
        email: 'cl-test@example.invalid',
        qbCustomerId: 'CL-TEST',
      },
    });
    vendorId = v.id;
    const cl = await prisma.creditLine.create({
      data: { vendorId, capAmount: CAP, usedAmount: 0 },
    });
    creditLineId = cl.id;
  });

  afterAll(async () => {
    if (!vendorId) return;
    await prisma.creditLineTransaction.deleteMany({ where: { creditLineId } });
    await prisma.creditLine.deleteMany({ where: { vendorId } });
    await prisma.invoice.deleteMany({ where: { vendorId } });
    await prisma.vendor.deleteMany({ where: { id: vendorId } });
    await prisma.$disconnect();
  });

  test('concurrent draws past cap: at most one succeeds', async () => {
    // Each draw is 600 — two concurrent must NOT both succeed (would exceed 1000 cap).
    const inv1 = await prisma.invoice.create({
      data: { vendorId, method: 'Credit Line', baseAmount: 600, feeAmount: 0, totalAmount: 600 },
    });
    const inv2 = await prisma.invoice.create({
      data: { vendorId, method: 'Credit Line', baseAmount: 600, feeAmount: 0, totalAmount: 600 },
    });

    const results = await Promise.allSettled([
      creditLineService.recordDraw(vendorId, inv1.id, 600),
      creditLineService.recordDraw(vendorId, inv2.id, 600),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason.message).toMatch(/race|exceed/i);

    const cl = await prisma.creditLine.findUnique({ where: { id: creditLineId } });
    expect(Number(cl.usedAmount)).toBeLessThanOrEqual(CAP);
  });
});
