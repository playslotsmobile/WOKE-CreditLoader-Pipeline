const prisma = require('../db/client');

/**
 * If `accountId` is an operator account that has a parent vendor account,
 * return the parent vendor account ID (so the chain load works: parent → operator).
 * Otherwise return the original account ID.
 *
 * Extracted from duplicate logic in routes/forms.js and routes/creditLine.js.
 */
async function resolveTargetAccountId(accountId) {
  const acct = await prisma.vendorAccount.findUnique({ where: { id: accountId } });
  if (acct && acct.parentVendorAccId) return acct.parentVendorAccId;
  return accountId;
}

module.exports = { resolveTargetAccountId };
