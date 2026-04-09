function validateInvoice({ vendor, method, baseAmount, feeAmount, totalAmount, allocations, creditLineRepayment = 0 }) {
  if (baseAmount <= 0) return { valid: false, error: 'Base amount must be positive' };

  if (method !== 'Wire' && method !== 'Credit Line' && baseAmount < 1000) {
    return { valid: false, error: `$1,000 minimum required for ${method}` };
  }

  for (const a of allocations) {
    if (a.dollarAmount < 0) {
      return { valid: false, error: 'Negative dollar amounts not allowed' };
    }
  }

  const allocSum = allocations.reduce((s, a) => s + Number(a.dollarAmount), 0) + creditLineRepayment;
  if (Math.abs(allocSum - Number(baseAmount)) > 0.01) {
    return { valid: false, error: `Allocation sum ($${allocSum.toFixed(2)}) does not match base amount ($${Number(baseAmount).toFixed(2)})` };
  }

  const vendorAccountIds = new Set(vendor.accounts.map((a) => a.id));
  const accountMap = Object.fromEntries(vendor.accounts.map((a) => [a.id, a]));

  for (const a of allocations) {
    if (!vendorAccountIds.has(a.accountId)) {
      return { valid: false, error: `Account ${a.accountId} does not belong to this vendor` };
    }
    const acct = accountMap[a.accountId];
    if (acct.loadType === 'correction') {
      return { valid: false, error: `Cannot use correction account ${acct.username} in invoice submission` };
    }
  }

  for (const a of allocations) {
    if (a.dollarAmount <= 0) continue;
    const acct = accountMap[a.accountId];
    const expectedCredits = Math.floor(Number(a.dollarAmount) / Number(acct.rate));
    if (Math.abs(expectedCredits - a.credits) > 1) {
      return { valid: false, error: `Credits mismatch for ${acct.username}: expected ~${expectedCredits}, got ${a.credits}` };
    }
  }

  return { valid: true };
}

function validateCorrection({ vendor, sourceAccountId, corrections }) {
  const source = vendor.accounts.find((a) => a.id === sourceAccountId);
  if (!source) {
    return { valid: false, error: 'Source account does not belong to this vendor' };
  }

  const totalCredits = corrections.reduce((s, c) => s + (c.credits || 0), 0);
  if (totalCredits <= 0) {
    return { valid: false, error: 'No credits to correct' };
  }

  const vendorAccountIds = new Set(vendor.accounts.map((a) => a.id));
  const accountMap = Object.fromEntries(vendor.accounts.map((a) => [a.id, a]));

  for (const c of corrections) {
    if (c.credits <= 0) continue;
    if (!vendorAccountIds.has(c.accountId)) {
      return { valid: false, error: `Account ${c.accountId} does not belong to this vendor` };
    }
    const acct = accountMap[c.accountId];
    if (acct.loadType !== 'correction') {
      return { valid: false, error: `Account ${acct.username} is not a correction account` };
    }
  }

  return { valid: true };
}

module.exports = { validateInvoice, validateCorrection };
