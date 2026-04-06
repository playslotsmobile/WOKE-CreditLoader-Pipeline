const play777 = require('./play777');
const iconnect = require('./iconnect');
const telegram = require('./telegram');
const prisma = require('../db/client');

const DRY_RUN = process.env.DRY_RUN === 'true';

// Process all load jobs for an invoice
async function processInvoice(invoiceId) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      vendor: true,
      allocations: {
        include: { vendorAccount: true },
      },
    },
  });

  if (!invoice) throw new Error('Invoice not found');

  const isCorrection = invoice.method === 'Correction';

  // Update status to LOADING
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'LOADING' },
  });

  const results = [];

  if (isCorrection) {
    // For corrections, find the source account (the vendor's main Play777 account)
    const sourceAccount = invoice.vendor.accounts
      ? null // We need to fetch it
      : null;

    // Fetch vendor with accounts to find the source
    const vendor = await prisma.vendor.findUnique({
      where: { id: invoice.vendorId },
      include: { accounts: true },
    });

    const source = vendor.accounts.find(
      (a) => a.platform === 'PLAY777' && a.loadType === 'vendor'
    );

    if (!source) {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'FAILED' },
      });
      throw new Error('No source vendor account found for correction');
    }

    // TODO: Check source account balance on Play777 before processing
    // If insufficient, send Telegram alert and abort

    // Process each correction as a "Correction" transaction type
    for (const alloc of invoice.allocations) {
      if (alloc.credits <= 0) continue;
      const account = alloc.vendorAccount;
      console.log(`Correction: ${alloc.credits} credits from ${source.username} to ${account.username}`);

      // Load via Play777 with correction transaction type
      // For operator accounts, pass the parent vendor so loadOperator is used
      let parentVendor = null;
      if (account.loadType === 'operator' && account.parentVendorAccId) {
        const parentAcc = vendor.accounts.find((a) => a.id === account.parentVendorAccId);
        if (parentAcc) {
          parentVendor = { username: parentAcc.username, operatorId: parentAcc.operatorId };
        }
      }

      let result;
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would load correction: ${alloc.credits} credits to ${account.username} (${account.operatorId}) on Play777`);
        result = { success: true, platform: 'PLAY777', account: account.username, credits: alloc.credits, dryRun: true };
      } else {
        result = await play777.loadCredits(
          { username: account.username, operatorId: account.operatorId },
          alloc.credits,
          parentVendor,
          'correction'
        );
      }
      results.push(result);

      if (invoice.allocations.length > 1) {
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
      }
    }
  } else {
    // Regular invoice — group by platform and process

    // Play777 accounts (vendors and chain loads)
    const play777Allocs = invoice.allocations.filter(
      (a) => a.vendorAccount.platform === 'PLAY777' && Number(a.dollarAmount) > 0
    );

    // IConnect accounts
    const iconnectAllocs = invoice.allocations.filter(
      (a) => a.vendorAccount.platform === 'ICONNECT' && Number(a.dollarAmount) > 0
    );

    // Process Play777 — vendors first, then handle chain loads
    for (const alloc of play777Allocs) {
      const account = alloc.vendorAccount;
      console.log(`Loading Play777: ${account.username} (${account.operatorId}) — ${alloc.credits} credits`);

      let result;
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would load Play777: ${alloc.credits} credits to ${account.username} (${account.operatorId})`);
        result = { success: true, platform: 'PLAY777', account: account.username, credits: alloc.credits, dryRun: true };
      } else {
        result = await play777.loadCredits(
          {
            username: account.username,
            operatorId: account.operatorId,
          },
          alloc.credits
        );
      }
      results.push(result);

      // If this account has a chain target (vendor → operator), load the operator too
      if (account.chainToAccId && result.success) {
        const chainTarget = await prisma.vendorAccount.findUnique({
          where: { id: account.chainToAccId },
        });

        if (chainTarget) {
          console.log(`Chain load: ${alloc.credits} credits to operator ${chainTarget.username} (${chainTarget.operatorId})`);

          // Small delay between chain loads
          await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));

          let chainResult;
          if (DRY_RUN) {
            console.log(`[DRY RUN] Would chain-load Play777: ${alloc.credits} credits to operator ${chainTarget.username} (${chainTarget.operatorId}) under vendor ${account.username}`);
            chainResult = { success: true, platform: 'PLAY777', account: chainTarget.username, credits: alloc.credits, dryRun: true };
          } else {
            chainResult = await play777.loadCredits(
              {
                username: chainTarget.username,
                operatorId: chainTarget.operatorId,
              },
              alloc.credits,
              { username: account.username, operatorId: account.operatorId }
            );
          }
          results.push(chainResult);
        }
      }

      if (play777Allocs.length > 1) {
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
      }
    }

    // Process IConnect accounts
    for (const alloc of iconnectAllocs) {
      const account = alloc.vendorAccount;
      console.log(`Loading IConnect: ${account.username} — ${alloc.credits} credits`);

      let result;
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would load IConnect: ${alloc.credits} credits to ${account.username}`);
        result = { success: true, platform: 'ICONNECT', account: account.username, credits: alloc.credits, dryRun: true };
      } else {
        result = await iconnect.loadCredits(
          { username: account.username },
          alloc.credits
        );
      }
      results.push(result);

      if (iconnectAllocs.length > 1) {
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
      }
    }
  }

  // Check results
  const allSuccess = results.every((r) => r.success);

  if (allSuccess) {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'LOADED', loadedAt: new Date() },
    });

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
