const play777 = require('./play777');
const iconnect = require('./iconnect');
const telegram = require('./telegram');
const prisma = require('../db/client');
const { logger } = require('./logger');

const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_RETRIES = 3;
const RETRY_DELAYS = [30000, 60000, 120000]; // 30s, 60s, 2min

async function emitEvent(loadJobId, step, status, metadata = null, screenshotPath = null) {
  try {
    await prisma.loadEvent.create({
      data: { loadJobId, step, status, metadata, screenshotPath },
    });
  } catch (err) {
    logger.error('Failed to emit LoadEvent', { loadJobId, step, error: err });
  }
}

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
    logger.info('All loads already completed', { invoiceId });
    return { invoiceId, results: [], allSuccess: true };
  }

  for (const job of pendingJobs) {
    await emitEvent(job.id, 'LOAD_STARTED', 'INFO', { invoiceId, creditsAmount: job.creditsAmount });
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

    // Step 1: Correct (deduct) total credits from source account
    const totalCorrectionCredits = pendingJobs.reduce((s, j) => s + j.creditsAmount, 0);
    logger.info('Correction Step 1: Deducting credits from source account', {
      credits: totalCorrectionCredits,
      sourceAccount: source.username,
      operatorId: source.operatorId,
    });

    let deductResult;
    if (DRY_RUN) {
      logger.info('[DRY RUN] Would correct credits from source account', {
        credits: totalCorrectionCredits,
        sourceAccount: source.username,
      });
      deductResult = { success: true };
    } else {
      deductResult = await play777.loadCredits(
        { username: source.username, operatorId: source.operatorId },
        totalCorrectionCredits,
        null,
        'correction'
      );
    }

    if (!deductResult.success) {
      logger.error('Correction failed: Could not deduct from source account', {
        sourceAccount: source.username,
        error: deductResult.error,
      });
      await emitEvent(pendingJobs[0].id, 'CORRECTION_DEDUCT_FAILED', 'FAILED', {
        sourceAccount: source.username,
        credits: totalCorrectionCredits,
        error: deductResult.error,
      });
      await markAllJobsFailed(pendingJobs, `Failed to deduct from ${source.username}: ${deductResult.error}`);
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'FAILED' } });
      return { invoiceId, results: [deductResult], allSuccess: false };
    }

    logger.info('Correction Step 1 complete: credits deducted', {
      credits: totalCorrectionCredits,
      sourceAccount: source.username,
    });
    await emitEvent(pendingJobs[0].id, 'CORRECTION_DEDUCT_OK', 'SUCCESS', {
      sourceAccount: source.username,
      credits: totalCorrectionCredits,
    });
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));

    // Step 2: Deposit credits to each target vendor
    for (const job of pendingJobs) {
      const account = job.vendorAccount;
      logger.info('Correction Step 2: Depositing credits to target account', {
        credits: job.creditsAmount,
        account: account.username,
        operatorId: account.operatorId,
      });

      const result = await executeLoad(job, 'PLAY777', account, job.creditsAmount);
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
      logger.info('Loading Play777 account', {
        account: account.username,
        operatorId: account.operatorId,
        credits: job.creditsAmount,
      });

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

          logger.info('Chain load: depositing credits to operator account', {
            credits: job.creditsAmount,
            account: chainTarget.username,
            operatorId: chainTarget.operatorId,
          });
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
      logger.info('Loading IConnect account', {
        account: account.username,
        credits: job.creditsAmount,
      });

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

    for (const job of pendingJobs) {
      await emitEvent(job.id, 'INVOICE_LOADED', 'SUCCESS', { invoiceId });
    }

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
      logger.error('Telegram loaded notification failed', { error: err.message });
    }

    logger.info('All loads completed successfully', { invoiceId });
  } else {
    const failed = results.filter((r) => !r.success);
    const attempt = retryCount + 1;

    if (attempt < MAX_RETRIES) {
      const delayMs = RETRY_DELAYS[retryCount];
      logger.error('Loads failed, retrying', {
        invoiceId,
        failedCount: failed.length,
        attempt,
        maxRetries: MAX_RETRIES,
        delayMs,
      });

      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'PAID' },
      });

      setTimeout(() => {
        processInvoice(invoiceId, attempt).catch((err) => {
          logger.error('Auto-retry failed', { invoiceId, attempt, error: err.message });
        });
      }, delayMs);
    } else {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'FAILED' },
      });

      for (const job of pendingJobs) {
        await emitEvent(job.id, 'INVOICE_FAILED', 'FAILED', { invoiceId, totalAttempts: MAX_RETRIES });
      }

      logger.error('Loads failed after max retries', {
        invoiceId,
        failedCount: failed.length,
        maxRetries: MAX_RETRIES,
      });

      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `🚨 LOAD FAILED (${MAX_RETRIES} attempts) 🚨\n\nInvoice #${invoiceId}\nVendor: ${invoice.vendor.name}\n\nUse the admin dashboard to retry manually.`
        );
      } catch (err) {
        logger.error('Telegram failure alert failed', { error: err.message });
      }

      try {
        await telegram.sendVendorFailed(
          { telegramChatId: invoice.vendor.telegramChatId },
          { id: invoice.id }
        );
      } catch {}
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
      logger.info('[DRY RUN] Would load credits', { platform, account: account.username, credits });
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

  await emitEvent(job.id, result.success ? 'LOAD_OK' : 'LOAD_FAILED', result.success ? 'SUCCESS' : 'FAILED', {
    platform,
    account: account.username,
    credits,
    error: result.error || null,
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
