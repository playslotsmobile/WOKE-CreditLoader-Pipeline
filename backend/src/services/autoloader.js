const play777 = require('./play777');
const iconnect = require('./iconnect');
const telegram = require('./telegram');
const prisma = require('../db/client');

// Process all load jobs for an invoice
async function processInvoice(invoiceId) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      vendor: true,
      allocations: { include: { vendorAccount: true } },
    },
  });

  if (!invoice) throw new Error('Invoice not found');

  // Update status to LOADING
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'LOADING' },
  });

  const results = [];

  // Group allocations by platform
  const play777Accounts = invoice.allocations.filter(
    (a) => a.vendorAccount.platform === 'PLAY777' && Number(a.dollarAmount) > 0
  );
  const iconnectAccounts = invoice.allocations.filter(
    (a) => a.vendorAccount.platform === 'ICONNECT' && Number(a.dollarAmount) > 0
  );

  // Sort Play777 accounts: vendors first, then operators (chain order)
  // This ensures parent vendors are loaded before child operators
  play777Accounts.sort((a, b) => {
    const aIsOp = a.vendorAccount.operatorId && a.vendorAccount.operatorId !== a.vendorAccount.operatorId;
    const bIsOp = b.vendorAccount.operatorId && b.vendorAccount.operatorId !== b.vendorAccount.operatorId;
    return aIsOp - bIsOp;
  });

  // Load Play777 accounts sequentially (same browser session, respects chain order)
  for (const alloc of play777Accounts) {
    const account = alloc.vendorAccount;
    console.log(`Loading Play777: ${account.username} (${account.operatorId}) — ${alloc.credits} credits`);

    const result = await play777.loadCredits(
      {
        username: account.username,
        operatorId: account.operatorId,
        loadType: account.loadType || 'vendor',
        parentOperatorId: account.parentOperatorId || null,
      },
      alloc.credits
    );
    results.push(result);

    // Small delay between loads to look natural
    if (play777Accounts.length > 1) {
      await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
    }
  }

  // Load IConnect accounts sequentially
  for (const alloc of iconnectAccounts) {
    const account = alloc.vendorAccount;
    console.log(`Loading IConnect: ${account.username} — ${alloc.credits} credits`);

    const result = await iconnect.loadCredits(
      {
        username: account.username,
        operatorId: account.operatorId,
      },
      alloc.credits
    );
    results.push(result);
  }

  // Check results
  const allSuccess = results.every((r) => r.success);

  if (allSuccess) {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'LOADED', loadedAt: new Date() },
    });

    // Send LOADED telegram messages
    const vendorData = {
      name: invoice.vendor.name,
      businessName: invoice.vendor.businessName,
      email: invoice.vendor.email,
      telegramChatId: invoice.vendor.telegramChatId,
    };

    const invoiceData = {
      id: invoice.id,
      qbInvoiceId: invoice.qbInvoiceId,
      method: invoice.method,
      baseAmount: Number(invoice.baseAmount),
    };

    const allocations = invoice.allocations.map((a) => ({
      dollarAmount: Number(a.dollarAmount),
      credits: a.credits,
      platform: a.vendorAccount.platform,
      username: a.vendorAccount.username,
      operatorId: a.vendorAccount.operatorId,
    }));

    try {
      await telegram.sendLoaded(vendorData, invoiceData, allocations);
    } catch (err) {
      console.error('Telegram loaded notification failed:', err.message);
    }

    console.log(`Invoice ${invoiceId}: All loads completed successfully`);
  } else {
    const failed = results.filter((r) => !r.success);
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'FAILED' },
    });

    console.error(`Invoice ${invoiceId}: ${failed.length} loads failed`);
  }

  return { invoiceId, results, allSuccess };
}

module.exports = { processInvoice };
