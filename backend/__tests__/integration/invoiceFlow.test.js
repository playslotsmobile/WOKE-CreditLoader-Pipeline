const { validateInvoice, validateCorrection } = require('../../src/services/validator');

describe('Invoice submission flow', () => {
  const vendor = {
    id: 1,
    accounts: [
      { id: 10, platform: 'PLAY777', rate: '0.35', loadType: 'vendor', username: 'M12345' },
      { id: 11, platform: 'ICONNECT', rate: '0.15', loadType: 'vendor', username: 'Mikee' },
      { id: 12, platform: 'PLAY777', rate: '0.35', loadType: 'correction', username: 'DSilva777' },
      { id: 13, platform: 'PLAY777', rate: '0.50', loadType: 'operator', username: 'CTrejo' },
    ],
  };

  describe('Wire invoice validation', () => {
    test('valid wire invoice with single allocation', () => {
      const result = validateInvoice({
        vendor, method: 'Wire', baseAmount: 2000, feeAmount: 0, totalAmount: 2000,
        allocations: [{ accountId: 10, dollarAmount: 2000, credits: 5714 }],
      });
      expect(result.valid).toBe(true);
    });

    test('valid wire with split allocations across platforms', () => {
      const result = validateInvoice({
        vendor, method: 'Wire', baseAmount: 3000, feeAmount: 0, totalAmount: 3000,
        allocations: [
          { accountId: 10, dollarAmount: 2000, credits: 5714 },
          { accountId: 11, dollarAmount: 1000, credits: 6666 },
        ],
      });
      expect(result.valid).toBe(true);
    });

    test('wire allows amounts below $1000', () => {
      const result = validateInvoice({
        vendor, method: 'Wire', baseAmount: 500, feeAmount: 0, totalAmount: 500,
        allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('ACH invoice validation', () => {
    test('rejects ACH below $1000', () => {
      const result = validateInvoice({
        vendor, method: 'ACH (1%)', baseAmount: 999, feeAmount: 9.99, totalAmount: 1008.99,
        allocations: [{ accountId: 10, dollarAmount: 999, credits: 2854 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/minimum/i);
    });

    test('valid ACH at exactly $1000', () => {
      const result = validateInvoice({
        vendor, method: 'ACH (1%)', baseAmount: 1000, feeAmount: 10, totalAmount: 1010,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2857 }],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('Credit card invoice validation', () => {
    test('rejects card below $1000', () => {
      const result = validateInvoice({
        vendor, method: 'Credit/Debit (3%)', baseAmount: 500, feeAmount: 15, totalAmount: 515,
        allocations: [{ accountId: 10, dollarAmount: 500, credits: 1428 }],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('Account ownership', () => {
    test('rejects account from different vendor', () => {
      const result = validateInvoice({
        vendor, method: 'Wire', baseAmount: 1000, feeAmount: 0, totalAmount: 1000,
        allocations: [{ accountId: 999, dollarAmount: 1000, credits: 2857 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/does not belong/i);
    });

    test('rejects correction account in regular invoice', () => {
      const result = validateInvoice({
        vendor, method: 'Wire', baseAmount: 1000, feeAmount: 0, totalAmount: 1000,
        allocations: [{ accountId: 12, dollarAmount: 1000, credits: 2857 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/correction/i);
    });

    test('allows operator account in regular invoice', () => {
      const result = validateInvoice({
        vendor, method: 'Wire', baseAmount: 1000, feeAmount: 0, totalAmount: 1000,
        allocations: [{ accountId: 13, dollarAmount: 1000, credits: 2000 }],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('Credit calculations', () => {
    test('rejects wildly wrong credits', () => {
      const result = validateInvoice({
        vendor, method: 'Wire', baseAmount: 1000, feeAmount: 0, totalAmount: 1000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 100000 }],
      });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/mismatch/i);
    });

    test('allows credits within ±1 tolerance', () => {
      const r1 = validateInvoice({
        vendor, method: 'Wire', baseAmount: 1000, feeAmount: 0, totalAmount: 1000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2857 }],
      });
      expect(r1.valid).toBe(true);

      const r2 = validateInvoice({
        vendor, method: 'Wire', baseAmount: 1000, feeAmount: 0, totalAmount: 1000,
        allocations: [{ accountId: 10, dollarAmount: 1000, credits: 2858 }],
      });
      expect(r2.valid).toBe(true);
    });
  });

  describe('Correction validation', () => {
    test('valid correction to correction account', () => {
      const result = validateCorrection({
        vendor, sourceAccountId: 10, corrections: [{ accountId: 12, credits: 500 }],
      });
      expect(result.valid).toBe(true);
    });

    test('rejects correction to vendor account', () => {
      const result = validateCorrection({
        vendor, sourceAccountId: 10, corrections: [{ accountId: 10, credits: 500 }],
      });
      expect(result.valid).toBe(false);
    });

    test('rejects correction with zero total credits', () => {
      const result = validateCorrection({
        vendor, sourceAccountId: 10, corrections: [{ accountId: 12, credits: 0 }],
      });
      expect(result.valid).toBe(false);
    });

    test('rejects source account not belonging to vendor', () => {
      const result = validateCorrection({
        vendor, sourceAccountId: 999, corrections: [{ accountId: 12, credits: 100 }],
      });
      expect(result.valid).toBe(false);
    });
  });
});
