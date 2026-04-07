const play777 = require('./play777');
const iconnect = require('./iconnect');
const telegram = require('./telegram');
const prisma = require('../db/client');

const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_RETRIES = 3;
const RETRY_DELAYS = [30000, 60000, 120000]; // 30s, 60s, 2min

// Process all load jobs for an invoice
async function processInvoice(invoiceId, retryCount = 0) {
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

  // Create or fetch LoadJob records for each allocation
  await ensureLoadJobs(invoice);

  // Get only PENDING load jobs (skip already SUCCESS ones on retry)
  const pendingJobs = await prisma.loadJob.findMany({
    where: { invoiceId, status: 'PENDING' },
    include: { vendorAccount: true },
  });

  if (pendingJobs.length === 0) {
    // All jobs already succeeded (edge case)
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'LOADED', loadedAt: new Date() },
    });
    console.log(`Invoice ${invoiceId}: All loads already completed`);
    return { invoiceId, results: [], allSuccess: true };
  }

  const results = [];

  if (isCorrection) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: invoice.vendorId },
      include: { accounts: true },
    });

    const source = vendor.accounts.find(
      (a) => a.platform === 'PLAY777' && a.loadType === 'vendor'
    );

    if (!source) {
      await markAllJobsFailed(pendingJobs, 'No source vendor account found');
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'FAILED' },
      });
      throw new Error('No source vendor account found for correction');
    }

    for (const job of pendingJobs) {
      const account = job.vendorAccount;
      console.log(`Correction: ${job.creditsAmount} credits from ${source.username} to ${account.username}`);

      let parentVendor = null;
      if (account.loadType === 'operator' && account.parentVendorAccId) {
        const parentAcc = vendor.accounts.find((a) => a.id === account.parentVendorAccId);
        if (parentAcc) {
          parentVendor = { username: parentAcc.username, operatorId: parentAcc.operatorId };
        }
      }

      const result = await executeLoad(job, 'PLAY777', account, job.creditsAmount, parentVendor);
      results.push(result);

      if (pendingJobs.length > 1) {
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
      }
    }
  } else {
    // Regular invoice — split by platform
    const play777Jobs = pendingJobs.filter((j) => j.vendorAccount.platform === 'PLAY777');
    const iconnectJobs = pendingJobs.filter((j) => j.vendorAccount.platform === 'ICONNECT');

    // Process Play777
    for (const job of play777Jobs) {
      const account = job.vendorAccount;
      console.log(`Loading Play777: ${account.username} (${account.operatorId}) — ${job.creditsAmount} credits`);

      const result = await executeLoad(job, 'PLAY777', account, job.creditsAmount);
      results.push(result);

      // Handle chain loads
      if (account.chainToAccId && result.success) {
        const chainTarget = await prisma.vendorAccount.findUnique({
          where: { id: account.chainToAccId },
        });

        if (chainTarget) {
          // Find or create chain load job
          let chainJob = await prisma.loadJob.findFirst({
            where: { invoiceId, vendorAccountId: chainTarget.id, status: 'PENDING' },
          });

          if (!chainJob) {
            chainJob = await prisma.loadJob.create({
              data: {
                invoiceId,
                vendorAccountId: chainTarget.id,
                creditsAmount: job.creditsAmount,
                status: 'PENDING',
              },
            });
          }

          console.log(`Chain load: ${job.creditsAmount} credits to operator ${chainTarget.username} (${chainTarget.operatorId})`);
          await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));

          const chainResult = await executeLoad(
            chainJob, 'PLAY777', chainTarget, job.creditsAmount,
            { username: account.username, operatorId: account.operatorId }
          );
          results.push(chainResult);
        }
      }

      if (play777Jobs.length > 1) {
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
      }
    }

    // Process IConnect
    for (const job of iconnectJobs) {
      const account = job.vendorAccount;
      console.log(`Loading IConnect: ${account.username} — ${job.creditsAmount} credits`);

      const result = await executeLoad(job, 'ICONNECT', account, job.creditsAmount);
      results.push(result);

      if (iconnectJobs.length > 1) {
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
    const attempt = retryCount + 1;

    if (attempt < MAX_RETRIES) {
      const delayMs = RETRY_DELAYS[retryCount];
      console.error(`Invoice ${invoiceId}: ${failed.length} loads failed — retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);

      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'PAID' },
      });

      setTimeout(() => {
        processInvoice(invoiceId, attempt).catch((err) => {
          console.error(`Invoice ${invoiceId}: Auto-retry ${attempt} failed:`, err.message);
        });
      }, delayMs);
    } else {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'FAILED' },
      });

      console.error(`Invoice ${invoiceId}: ${failed.length} loads failed after ${MAX_RETRIES} attempts`);

      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `🚨 LOAD FAILED (${MAX_RETRIES} attempts) 🚨\n\nInvoice #${invoiceId}\nVendor: ${invoice.vendor.name}\n\nUse the admin dashboard to retry manually.`
        );
      } catch (err) {
        console.error('Telegram failure alert failed:', err.message);
      }
    }
  }

  return { invoiceId, results, allSuccess };
}

// Create LoadJob records for allocations that don't have them yet
async function ensureLoadJobs(invoice) {
  for (const alloc of invoice.allocations) {
    if (alloc.credits <= 0 && Number(alloc.dollarAmount) <= 0) continue;

    const existing = await prisma.loadJob.findFirst({
      where: { invoiceId: invoice.id, vendorAccountId: alloc.vendorAccountId },
    });

    if (!existing) {
      await prisma.loadJob.create({
        data: {
          invoiceId: invoice.id,
          vendorAccountId: alloc.vendorAccountId,
          creditsAmount: alloc.credits,
          status: 'PENDING',
        },
      });
    }
  }
}

// Execute a single load and update the LoadJob record
async function executeLoad(job, platform, account, credits, parentVendor, transactionType) {
  let result;

  try {
    if (DRY_RUN) {
      console.log(`[DRY RUN] Would load ${platform}: ${credits} credits to ${account.username}`);
      result = { success: true, platform, account: account.username, credits, dryRun: true };
    } else if (platform === 'PLAY777') {
      result = await play777.loadCredits(
        { username: account.username, operatorId: account.operatorId },
        credits,
        parentVendor,
        transactionType
      );
    } else {
      result = await iconnect.loadCredits(
        { username: account.username },
        credits
      );
    }
  } catch (err) {
    result = { success: false, error: err.message, platform, account: account.username };
  }

  // Update LoadJob record
  await prisma.loadJob.update({
    where: { id: job.id },
    data: {
      status: result.success ? 'SUCCESS' : 'FAILED',
      attempts: { increment: 1 },
      errorMessage: result.success ? null : (result.error || 'Unknown error'),
      completedAt: result.success ? new Date() : null,
    },
  });

  // Reset to PENDING if failed (so retry picks it up)
  if (!result.success) {
    await prisma.loadJob.update({
      where: { id: job.id },
      data: { status: 'PENDING' },
    });
  }

  return result;
}

async function markAllJobsFailed(jobs, errorMessage) {
  for (const job of jobs) {
    await prisma.loadJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', errorMessage, attempts: { increment: 1 } },
    });
  }
}

module.exports = { processInvoice };
