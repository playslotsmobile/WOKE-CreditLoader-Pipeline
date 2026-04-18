const { validateInvoice, validateCorrection } = require('../src/services/validator');

describe('validateInvoice', () => {
  const makeVendor = () => ({
    id: 1,
    accounts: [
      { id: 10, platform: 'PLAY777', rate: '0.35', loadType: 'vendor', username: 'TestVendor' },
      { id: 11, platform: 'ICONNECT', rate: '0.15', loadType: 'vendor', username: 'TestIC' },
      { id: 12, platform: 'PLAY777', rate: '0.35', loadType: 'correction', username: 'TestCorr' },
    ],
  });

  test('valid invoice passes', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'ACH (1%)',
      baseAmount: 1000,
      feeAmount: 10,
      totalAmount: 1010,
      allocations: [
        { accountId: 10, dollarAmount: 700, credits: 2000 },
        { accountId: 11, dollarAmount: 300, credits: 2000 },
      ],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects when allocation sum != baseAmount', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'ACH (1%)',
      baseAmount: 1000,
      feeAmount: 10,
      totalAmount: 1010,
      allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/allocation.*sum/i);
  });

  test('rejects Card/ACH below $1000 minimum', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Credit/Debit (3%)',
      baseAmount: 500,
      feeAmount: 15,
      totalAmount: 515,
      allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/minimum/i);
  });

  test('rejects negative amounts', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [
        { accountId: 10, dollarAmount: -500, credits: 1428 },
        { accountId: 11, dollarAmount: 1500, credits: 10000 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/negative/i);
  });

  test('rejects account not belonging to vendor', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [{ accountId: 999, dollarAmount: 1000, credits: 2857 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not belong/i);
  });

  test('rejects correction account in invoice submission', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [{ accountId: 12, dollarAmount: 1000, credits: 2857 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/correction account/i);
  });

  test('rejects credits mismatch beyond tolerance', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 1000,
      feeAmount: 0,
      totalAmount: 1000,
      allocations: [{ accountId: 10, dollarAmount: 1000, credits: 9999 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/credits.*mismatch/i);
  });

  test('wire allows below $1000', () => {
    const result = validateInvoice({
      vendor: makeVendor(),
      method: 'Wire',
      baseAmount: 500,
      feeAmount: 0,
      totalAmount: 500,
      allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
    });
    expect(result.valid).toBe(true);
  });

  describe('Cash method', () => {
    const cashVendor = makeVendor();

    test('valid Cash invoice with single allocation', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 2000,
        feeAmount: 0,
        totalAmount: 2000,
        allocations: [{ accountId: 10, dollarAmount: 2000, credits: 5714 }],
      });
      expect(result.valid).toBe(true);
    });

    test('Cash rejects nonzero fee', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 2000,
        feeAmount: 10,
        totalAmount: 2010,
        allocations: [{ accountId: 10, dollarAmount: 2000, credits: 5714 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/cash.*fee/i);
    });

    test('Cash enforces $1000 minimum', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 500,
        feeAmount: 0,
        totalAmount: 500,
        allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/minimum/i);
    });

    test('Cash supports credit-line repayment', () => {
      const result = validateInvoice({
        vendor: cashVendor,
        method: 'Cash',
        baseAmount: 3000,
        feeAmount: 0,
        totalAmount: 3000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2857 }],
        creditLineRepayment: 2000,
      });
      expect(result.valid).toBe(true);
    });
  });
});

describe('validateCorrection', () => {
  const makeVendor = () => ({
    id: 1,
    accounts: [
      { id: 10, platform: 'PLAY777', rate: '0.35', loadType: 'vendor', username: 'TestVendor' },
      { id: 12, platform: 'PLAY777', rate: '0.35', loadType: 'correction', username: 'TestCorr' },
    ],
  });

  test('valid correction passes', () => {
    const result = validateCorrection({
      vendor: makeVendor(),
      sourceAccountId: 10,
      corrections: [{ accountId: 12, credits: 100 }],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects non-correction target account', () => {
    const result = validateCorrection({
      vendor: makeVendor(),
      sourceAccountId: 10,
      corrections: [{ accountId: 10, credits: 100 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/correction account/i);
  });

  test('rejects zero credits', () => {
    const result = validateCorrection({
      vendor: makeVendor(),
      sourceAccountId: 10,
      corrections: [{ accountId: 12, credits: 0 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no credits/i);
  });
});
