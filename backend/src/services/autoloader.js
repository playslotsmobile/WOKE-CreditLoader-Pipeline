const play777 = require('./play777');
const iconnect = require('./iconnect');
const telegram = require('./telegram');
const prisma = require('../db/client');
const { logger } = require('./logger');
const creditLineService = require('./creditLineService');
const masterBalance = require('./masterBalance');
const blockadeDetector = require('./blockadeDetector');

const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_RETRIES = 3;
const RETRY_DELAYS = [30000, 60000, 120000]; // 30s, 60s, 2min

// If any failed result carries a "Wait Xs before retrying" hint from the
// browser rate-limiter, honor it (plus a small buffer) instead of the fixed
// schedule. Otherwise the retry fires while the rate-limit window is still
// closed and burns an attempt for no reason — which is exactly what happened
// to invoice 243 on May 2/3.
function computeRetryDelay(failedResults, retryCount) {
  const baseDelay = RETRY_DELAYS[retryCount];
  let maxHinted = 0;
  for (const r of failedResults || []) {
    const m = r && r.error && /Wait\s+(\d+)s\s+before retrying/i.exec(r.error);
    if (m) {
      const seconds = parseInt(m[1], 10);
      if (seconds > maxHinted) maxHinted = seconds;
    }
  }
  if (maxHinted > 0) {
    const hintedMs = (maxHinted + 5) * 1000; // 5s buffer past the window
    return Math.max(hintedMs, baseDelay);
  }
  return baseDelay;
}

// Sequential load queue — only one invoice processes at a time
const loadQueue = [];
let processing = false;

function enqueueInvoice(invoiceId, retryCount = 0) {
  return new Promise((resolve, reject) => {
    loadQueue.push({ invoiceId, retryCount, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing || loadQueue.length === 0) return;
  processing = true;

  const { invoiceId, retryCount, resolve, reject } = loadQueue.shift();
  try {
    const result = await processInvoiceInternal(invoiceId, retryCount);
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    processing = false;
    if (loadQueue.length > 0) {
      // Small delay between queued invoices
      setTimeout(processQueue, 3000);
    }
  }
}

async function emitEvent(loadJobId, step, status, metadata = null, screenshotPath = null) {
  try {
    await prisma.loadEvent.create({
      data: { loadJobId, step, status, metadata, screenshotPath },
    });
  } catch (err) {
    logger.error('Failed to emit LoadEvent', { loadJobId, step, error: err });
  }
}

// Public entry point — queues invoices for sequential processing
async function processInvoice(invoiceId, retryCount = 0) {
  return enqueueInvoice(invoiceId, retryCount);
}

// Internal processor — only called from the queue
async function processInvoiceInternal(invoiceId, retryCount = 0) {
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

  // Re-check credit line balance before loading (race condition guard)
  if (invoice.method === 'Credit Line') {
    const cl = await creditLineService.getCreditLine(invoice.vendorId);
    if (!cl) {
      logger.error('Credit line not found for credit line invoice', { invoiceId });
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'FAILED' } });
      return;
    }
    // The draw was already recorded, so we just verify usedAmount hasn't exceeded cap
    if (Number(cl.usedAmount) > Number(cl.capAmount)) {
      logger.error('Credit line over-drawn, blocking load', {
        invoiceId,
        usedAmount: Number(cl.usedAmount),
        capAmount: Number(cl.capAmount),
      });
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'FAILED' } });
      return;
    }
  }

  const isCorrection = invoice.method === 'Correction';

  // Retry entry: reset any FAILED LoadJob rows back to PENDING so this
  // attempt actually re-tries them. Two entry paths need this:
  //
  //   1) Manual retry on a FAILED invoice (admin trigger-load) — invoice
  //      status is 'FAILED' on entry.
  //   2) Autoloader auto-retry after a previous attempt's results had
  //      failures — invoice status was flipped to 'PAID' in the retry
  //      scheduler, but the LoadJob rows are still FAILED from the
  //      previous attempt. retryCount > 0 identifies this path.
  //
  // Without this reset, the pendingJobs query below returns [] and the
  // defensive guard (added 2026-05-16) correctly identifies an all-FAILED
  // state and keeps the invoice FAILED — but that defeats the auto-retry's
  // purpose. Bug shape was first observed on invoice 347 (2026-05-15) and
  // again surfaced on invoice 365's smoke test (2026-05-16).
  //
  // Risk note: re-running a FAILED deposit could double-load if the
  // platform actually delivered credits but our verifier missed it (see
  // feedback_verify_iconnect_before_retry.md). Same risk as the prior
  // behavior — the proper fix is verify-before-retry, deferred.
  if (invoice.status === 'FAILED' || retryCount > 0) {
    const reset = await prisma.loadJob.updateMany({
      where: { invoiceId, status: 'FAILED' },
      data: { status: 'PENDING', errorMessage: null },
    });
    if (reset.count > 0) {
      logger.info('Reset FAILED loadJobs to PENDING for retry', {
        invoiceId, count: reset.count, retryCount, fromStatus: invoice.status,
      });
    }
  }

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
    // No PENDING jobs at this point can mean three things:
    //   A) All jobs SUCCESS, no FAILED  → invoice complete  → LOADED
    //   B) Zero allocations / zero jobs total (pure-repayment Invoice
    //      with creditLineRepaymentIntent applied; the repayment was
    //      recorded in processRepaymentIntent and there's no actual
    //      credit-load work to do)  → effectively complete  → LOADED
    //   C) Some jobs FAILED, no PENDING (retries exhausted, or partial
    //      failure with no live retries scheduled)  → keep FAILED
    //
    // The bug we're guarding against (added 2026-05-16, surfaced on
    // invoice 365): an invoice with ALL jobs FAILED used to fall into
    // the original "all done" branch and get marked LOADED with zero
    // credits actually delivered. The rule is `failedCount === 0`.
    //
    // Subtle: the earlier fix tightened this to `successCount > 0 &&
    // failedCount === 0`, which broke case B (pure-repayment invoices)
    // by lumping them with case C. Regression caught 2026-05-22 on
    // Alex Noz's 5 ACH repayments. The right rule is just
    // `failedCount === 0` — covers A and B, excludes C.
    const successCount = await prisma.loadJob.count({ where: { invoiceId, status: 'SUCCESS' } });
    const failedCount = await prisma.loadJob.count({ where: { invoiceId, status: 'FAILED' } });
    if (failedCount === 0) {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'LOADED', loadedAt: new Date() },
      });
      logger.info('No pending work — invoice marked LOADED', {
        invoiceId, successCount, failedCount,
        note: successCount === 0 ? 'pure-repayment / zero-allocation' : 'all jobs previously succeeded',
      });
      return { invoiceId, results: [], allSuccess: true };
    }
    // No PENDING + some FAILED → real failure, keep FAILED.
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'FAILED' },
    });
    logger.warn('No PENDING jobs and at least one FAILED — invoice stays FAILED', {
      invoiceId, successCount, failedCount,
    });
    return { invoiceId, results: [], allSuccess: false };
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

    const totalCorrectionCredits = pendingJobs.reduce((s, j) => s + j.creditsAmount, 0);

    // Step 1 idempotency guard: if a prior attempt already succeeded in
    // deducting from the source account, skip the deduct on this retry.
    // Step 1 has no LoadJob row of its own (only Step 2 deposits do), so
    // the only persistent trace of a successful deduct is the
    // CORRECTION_DEDUCT_OK LoadEvent. Without this check, a partial
    // failure on Step 2 would trigger a retry that re-runs Step 1 and
    // double-deducts the source account.
    const allInvoiceLoadJobIds = (
      await prisma.loadJob.findMany({
        where: { invoiceId },
        select: { id: true },
      })
    ).map((j) => j.id);
    const priorDeductOk = await prisma.loadEvent.findFirst({
      where: {
        loadJobId: { in: allInvoiceLoadJobIds },
        step: 'CORRECTION_DEDUCT_OK',
        status: 'SUCCESS',
      },
    });

    if (priorDeductOk) {
      logger.warn('Correction Step 1 already completed on prior attempt — runCorrection will skip deduct', {
        invoiceId,
        credits: totalCorrectionCredits,
        sourceAccount: source.username,
        priorEventId: priorDeductOk.id,
        priorEventAt: priorDeductOk.createdAt,
      });
    }

    // Single-session refactor: deduct + all deposits in ONE AdsPower
    // profile launch. Halves rate-limit-slot usage per correction,
    // eliminates the cf_clearance cold start between Step 1 and Step 2,
    // and meaningfully shrinks the partial-success window.
    logger.info('Running correction in single AdsPower session', {
      invoiceId,
      skipDeduct: !!priorDeductOk,
      sourceAccount: source.username,
      totalCorrectionCredits,
      targetCount: pendingJobs.length,
    });

    let correctionResult;
    if (DRY_RUN) {
      logger.info('[DRY RUN] Would runCorrection', {
        sourceAccount: source.username,
        totalCorrectionCredits,
        targets: pendingJobs.map((j) => j.vendorAccount.username),
      });
      correctionResult = {
        deduct: { ran: !priorDeductOk, success: true, verified: false, credits: totalCorrectionCredits },
        deposits: pendingJobs.map((j) => ({
          jobId: j.id, account: j.vendorAccount.username, credits: j.creditsAmount,
          success: true, verified: false,
        })),
      };
    } else {
      correctionResult = await play777.runCorrection(
        { username: source.username, operatorId: source.operatorId },
        pendingJobs.map((j) => ({
          account: { username: j.vendorAccount.username, operatorId: j.vendorAccount.operatorId },
          credits: j.creditsAmount,
          jobId: j.id,
        })),
        pendingJobs[0].id,
        { skipDeduct: !!priorDeductOk }
      );
    }

    // Deduct outcome (only relevant if we actually ran Step 1 this attempt)
    if (correctionResult.deduct.ran) {
      if (correctionResult.deduct.success) {
        logger.info('Correction Step 1 complete: credits deducted', {
          credits: correctionResult.deduct.credits,
          sourceAccount: source.username,
          verified: correctionResult.deduct.verified,
        });
        await emitEvent(pendingJobs[0].id, 'CORRECTION_DEDUCT_OK', 'SUCCESS', {
          sourceAccount: source.username,
          credits: correctionResult.deduct.credits,
          verified: correctionResult.deduct.verified,
          transactionId: correctionResult.deduct.transactionId,
        });
      } else {
        logger.error('Correction failed: Could not deduct from source account', {
          sourceAccount: source.username,
          error: correctionResult.deduct.error,
        });
        await emitEvent(pendingJobs[0].id, 'CORRECTION_DEDUCT_FAILED', 'FAILED', {
          sourceAccount: source.username,
          credits: correctionResult.deduct.credits,
          error: correctionResult.deduct.error,
        });

        // Telegram operator alert on FIRST Step 1 failure for this invoice.
        // Deduped via CORRECTION_DEDUCT_FAIL_ALERT_SENT sentinel event so
        // subsequent retries don't spam. Previously the system emitted ZERO
        // notification on Step 1 deduct failure — sir had to find FAILED
        // corrections by manually scanning the dashboard (surfaced
        // 2026-06-01 on Cesar's #499 which sat silently for 2 days).
        try {
          const alreadyAlerted = await prisma.loadEvent.findFirst({
            where: { loadJobId: { in: allInvoiceLoadJobIds }, step: 'CORRECTION_DEDUCT_FAIL_ALERT_SENT' },
          });
          if (!alreadyAlerted) {
            await telegram.bot.sendMessage(
              process.env.TELEGRAM_ADMIN_CHAT_ID,
              `⚠️ *Correction Step 1 failed — operator may need to act*\n\n` +
              `Invoice #${invoiceId} (${invoice.vendor.name}) — correction → ${pendingJobs.map((j) => j.vendorAccount.username).join(', ')}\n` +
              `Step 1 (deduct from ${source.username}) failed: \`${(correctionResult.deduct.error || 'unknown').slice(0, 200)}\`\n\n` +
              `Autoloader will retry up to ${MAX_RETRIES} times. If all retries fail, the invoice ends in FAILED on the dashboard — \"Mark Loaded Manually\" once you've verified the correction is done on Play777.`,
              { parse_mode: 'Markdown' }
            );
            await emitEvent(pendingJobs[0].id, 'CORRECTION_DEDUCT_FAIL_ALERT_SENT', 'INFO', {
              attemptedSource: source.username,
              error: (correctionResult.deduct.error || '').slice(0, 200),
            });
          }
        } catch (alertErr) {
          logger.error('Correction Step 1 fail-alert send failed', { invoiceId, error: alertErr.message });
        }

        // Mark all pending deposit loadJobs FAILED (Step 2 never ran since
        // Step 1 didn't land). Push failure results into `results` so the
        // standard retry path at the bottom of processInvoiceInternal
        // schedules retries — DO NOT early-return. Previously this branch
        // returned immediately, giving corrections only 1 attempt vs the
        // 3 attempts regular loads get. The c377a3f idempotency guard
        // ensures a retry won't double-deduct (it checks for
        // CORRECTION_DEDUCT_OK, which wasn't emitted here).
        await markAllJobsFailed(pendingJobs, `Failed to deduct from ${source.username}: ${correctionResult.deduct.error}`);
        for (const job of pendingJobs) {
          results.push({
            success: false,
            platform: 'PLAY777',
            account: job.vendorAccount.username,
            credits: job.creditsAmount,
            error: `Failed to deduct from ${source.username}: ${correctionResult.deduct.error}`,
          });
        }
        // Fall through. The Step 2 loop below is a no-op (deposits=[]
        // when Step 1 failed), and the standard retry/final logic at
        // line ~510 handles invoice status + retry scheduling.
      }
    }

    // Step 2 outcomes — apply per-job LoadJob updates + LOAD_OK/LOAD_FAILED
    // events that mirror what executeLoad would have done in the old per-call
    // path. Push into `results` so the outer retry/finalize logic sees them.
    for (const dep of correctionResult.deposits) {
      const job = pendingJobs.find((j) => j.id === dep.jobId);
      if (!job) continue;

      await prisma.loadJob.update({
        where: { id: job.id },
        data: {
          status: dep.success ? 'SUCCESS' : 'FAILED',
          attempts: { increment: 1 },
          errorMessage: dep.success
            ? null
            : (dep.error || '[bug] PLAY777 runCorrection deposit returned success=false with empty .error'),
          completedAt: dep.success ? new Date() : null,
        },
      });

      await emitEvent(job.id, dep.success ? 'LOAD_OK' : 'LOAD_FAILED', dep.success ? 'SUCCESS' : 'FAILED', {
        platform: 'PLAY777',
        account: dep.account,
        credits: dep.credits,
        error: dep.error || null,
      });

      if (dep.success && dep.verified !== undefined) {
        await emitEvent(job.id, dep.verified ? 'VERIFIED' : 'UNVERIFIED', dep.verified ? 'SUCCESS' : 'INFO', {
          platform: 'PLAY777',
          account: dep.account,
          transactionId: dep.transactionId || null,
          verified: dep.verified,
        });
      }

      results.push({
        success: dep.success,
        platform: 'PLAY777',
        account: dep.account,
        credits: dep.credits,
        verified: dep.verified,
        transactionId: dep.transactionId,
        error: dep.error,
      });
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

      let parentVendor = null;
      if (account.loadType === 'operator' && account.parentVendorAccId) {
        const parentAcc = await prisma.vendorAccount.findUnique({ where: { id: account.parentVendorAccId } });
        if (parentAcc) parentVendor = { username: parentAcc.username, operatorId: parentAcc.operatorId };
      }

      const result = await executeLoad(job, 'PLAY777', account, job.creditsAmount, parentVendor);
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

    // BLOCKADE SHORT-CIRCUIT — if any failure is a human-action-required wall
    // (phone/email/contact modal, Cloudflare hard block, CAPTCHA, dead session),
    // STOP. Retrying just burns rate-limit slots and escalates CF from challenge
    // to hard block (exactly what happened 2026-06-23). Flag the invoice as
    // BLOCKED_VERIFICATION (visible in the pipeline) and alert the main group
    // ONCE with the specific reason, screenshot, and the action needed.
    const blockedHit = failed
      .map((r) => ({ r, b: blockadeDetector.classify(r.error) }))
      .find((x) => x.b);
    if (blockedHit) {
      const { b, r } = blockedHit;
      const jobIds = pendingJobs.map((j) => j.id);

      // Master-depletion masquerading as a phone block: Play777 aborts the deposit
      // into the change-phone form when Master715 runs dry, which classifies as
      // PHONE_VERIFICATION (human-required → parks forever). If the master actually
      // can't cover this invoice, it's really low-master — route to BLOCKED_LOW_MASTER
      // so it AUTO-RESUMES on the next refill (existing master sweep) instead of
      // stranding a paid vendor (Claudia #831 sat 1.5d). A genuine "Update Your
      // Contact" phone modal with a HEALTHY master still parks as PHONE_VERIFICATION.
      let lowMaster = false;
      if (b.type === 'PHONE_VERIFICATION') {
        try {
          const decision = await masterBalance.canLoadInvoice(invoice);
          lowMaster = !decision.canLoad;
          if (lowMaster) {
            logger.warn('Phone block is actually master depletion — reclassifying to BLOCKED_LOW_MASTER', { invoiceId, checks: decision.checks });
          }
        } catch (e) {
          logger.error('Low-master reclassify check failed — treating as phone block', { invoiceId, error: e.message });
        }
      }

      if (lowMaster) {
        // Reset the failed leg(s) → PENDING (the change-phone abort never deposited;
        // SUCCESS legs are preserved = no double-load) so the master-refill auto-resume
        // actually re-loads them. Then flag BLOCKED_LOW_MASTER (self-heals on top-up).
        await prisma.loadJob.updateMany({ where: { invoiceId, status: 'FAILED' }, data: { status: 'PENDING', errorMessage: null } });
        await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'BLOCKED_LOW_MASTER' } });
        for (const job of pendingJobs) {
          await emitEvent(job.id, 'BLOCKED_LOW_MASTER', 'FAILED', { invoiceId, reclassifiedFrom: 'PHONE_VERIFICATION' });
        }
        const alreadyLM = jobIds.length
          ? await prisma.loadEvent.findFirst({ where: { loadJobId: { in: jobIds }, step: 'LOW_MASTER_ALERT_SENT' } })
          : null;
        if (!alreadyLM && pendingJobs[0]) {
          try {
            await telegram.bot.sendMessage(
              process.env.TELEGRAM_ADMIN_CHAT_ID,
              `⛔ *LOAD HELD — Play777 master credits low*\n\nInvoice #${invoiceId} — ${invoice.vendor.name}\n\nPlay777 aborted the deposit into the change-phone form because Master715 is depleted. Held as *BLOCKED_LOW_MASTER* — it will *auto-resume* the moment the master is topped up (next balance sweep). Just refill Master715; no manual retry needed.`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {
            logger.error('Low-master alert send failed', { invoiceId, error: e.message });
          }
          await emitEvent(pendingJobs[0].id, 'LOW_MASTER_ALERT_SENT', 'INFO', { invoiceId });
        }
        logger.warn('Load reclassified BLOCKED_LOW_MASTER from phone block', { invoiceId, vendor: invoice.vendor.name });
        return { invoiceId, results, allSuccess: false, blocked: 'BLOCKED_LOW_MASTER' };
      }

      await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'BLOCKED_VERIFICATION' } });
      for (const job of pendingJobs) {
        await emitEvent(job.id, 'BLOCKED_VERIFICATION', 'FAILED', { invoiceId, blockade: b.type });
      }
      const alreadyAlerted = jobIds.length
        ? await prisma.loadEvent.findFirst({ where: { loadJobId: { in: jobIds }, step: 'BLOCKADE_ALERT_SENT' } })
        : null;
      if (!alreadyAlerted) {
        // CF blocks are transient → "held, auto-retrying" wording (the CF resume
        // sweep handles the retry). Everything else genuinely needs a human now.
        await blockadeDetector.alertBlockade(b, {
          invoiceId,
          vendorName: invoice.vendor.name,
          screenshotPath: r.screenshotPath,
          mode: b.autoResume ? 'auto-retry' : 'needs-human',
        });
        if (pendingJobs[0]) {
          await emitEvent(pendingJobs[0].id, 'BLOCKADE_ALERT_SENT', 'INFO', { invoiceId, blockade: b.type });
        }
      }
      logger.error('Load BLOCKED', {
        invoiceId,
        blockade: b.type,
        autoResume: !!b.autoResume,
        vendor: invoice.vendor.name,
      });
      return { invoiceId, results, allSuccess: false, blocked: b.type };
    }

    if (attempt < MAX_RETRIES) {
      const delayMs = computeRetryDelay(failed, retryCount);
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
      // Final disposition after retries exhausted: if the failure was caused
      // by insufficient master credits, mark BLOCKED_LOW_MASTER so it stays
      // visible in the pipeline (vs FAILED which is easy to miss). Auto-resume
      // will pick it back up when the master is refilled.
      //
      // We check the CURRENT stored balance against the invoice's required
      // credits — if we're still short, the cause was almost certainly master
      // shortage and we flip to BLOCKED instead of FAILED. If we have enough
      // credits now and the load still failed, that's a genuine failure
      // (Cloudflare block, UI shift, AdsPower crash, etc) and stays FAILED.
      let finalStatus = 'FAILED';
      try {
        const decision = await masterBalance.canLoadInvoice(invoice);
        if (!decision.canLoad) {
          finalStatus = 'BLOCKED_LOW_MASTER';
          logger.warn('Reclassifying failed invoice as BLOCKED_LOW_MASTER', {
            invoiceId,
            checks: decision.checks,
          });
        }
      } catch (balErr) {
        logger.error('Failed to check master balance for reclassification', {
          invoiceId,
          error: balErr.message,
        });
      }

      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: finalStatus },
      });

      for (const job of pendingJobs) {
        await emitEvent(job.id, 'INVOICE_FAILED', 'FAILED', {
          invoiceId,
          totalAttempts: MAX_RETRIES,
          finalStatus,
        });
      }

      logger.error('Loads failed after max retries', {
        invoiceId,
        failedCount: failed.length,
        maxRetries: MAX_RETRIES,
        finalStatus,
      });

      try {
        const msg =
          finalStatus === 'BLOCKED_LOW_MASTER'
            ? `⛔ LOAD BLOCKED (insufficient master credits) ⛔\n\nInvoice #${invoiceId}\nVendor: ${invoice.vendor.name}\n\nMaster balance was too low after ${MAX_RETRIES} retries. Kept in pipeline as BLOCKED_LOW_MASTER — will auto-resume on next balance sweep once master is refilled.`
            : `🚨 LOAD FAILED (${MAX_RETRIES} attempts) 🚨\n\nInvoice #${invoiceId}\nVendor: ${invoice.vendor.name}\n\nUse the admin dashboard to retry manually.`;
        await telegram.bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, msg);
      } catch (err) {
        logger.error('Telegram failure alert failed', { error: err.message });
      }

      // Vendor silence: never tell the vendor a load failed or was blocked.
      // The failure fingerprint is indistinguishable from master-balance
      // depletion and we must not give vendors any signal that we're having
      // trouble loading. Admin handles retries manually via the dashboard.
      // (previously called telegram.sendVendorFailed — intentionally removed)
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
        transactionType,
        job.id
      );
    } else {
      result = await iconnect.loadCredits(
        { username: account.username },
        credits,
        job.id
      );
    }
  } catch (err) {
    // Preserve a pre-identified blockade + its screenshot so the failure path
    // can stop-and-alert with the real reason instead of a generic retry.
    result = { success: false, error: err.message, platform, account: account.username, screenshotPath: err.screenshotPath };
  }

  // Update LoadJob record
  const updatedJob = await prisma.loadJob.update({
    where: { id: job.id },
    data: {
      status: result.success ? 'SUCCESS' : 'FAILED',
      attempts: { increment: 1 },
      // No 'Unknown error' fallback — if a driver fails without a message,
      // surface that as a bug locator instead of swallowing it (per the
      // no-unknown-errors rule).
      errorMessage: result.success
        ? null
        : (result.error || `[bug] ${result.platform || platform} returned success=false with empty .error`),
      completedAt: result.success ? new Date() : null,
    },
  });

  await emitEvent(job.id, result.success ? 'LOAD_OK' : 'LOAD_FAILED', result.success ? 'SUCCESS' : 'FAILED', {
    platform,
    account: account.username,
    credits,
    error: result.error || null,
  });

  // Thrash detection: a healthy load completes within ~3 attempts. Anything
  // beyond that means we're stuck (rate-limit cascades, CF wall, depleted
  // master swallowed silently, etc). Send a Telegram alert once per loadJob
  // when attempts cross the threshold so the operator gets a real signal
  // instead of the loop grinding silently for hours (as happened to
  // loadJob 436 today — 48 attempts before it finally landed).
  const THRASH_ATTEMPTS_THRESHOLD = 6;
  if (!result.success && updatedJob.attempts >= THRASH_ATTEMPTS_THRESHOLD) {
    try {
      // Dedupe: only fire once per loadJob via a sentinel event.
      const alreadyAlerted = await prisma.loadEvent.findFirst({
        where: { loadJobId: job.id, step: 'LOAD_THRASH_ALERT_SENT' },
      });
      if (!alreadyAlerted) {
        // Fetch invoice + vendor for the alert text
        const inv = await prisma.invoice.findUnique({
          where: { id: job.invoiceId },
          include: { vendor: { select: { name: true } } },
        });
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `🌀 *LOAD THRASHING — operator action recommended*\n\n` +
          `Invoice #${job.invoiceId} (${inv?.vendor?.name || 'unknown vendor'}) → ${account.username} on ${platform}\n` +
          `LoadJob #${job.id} has hit *${updatedJob.attempts} attempts* without succeeding.\n\n` +
          `Latest error: \`${(result.error || 'unknown').slice(0, 200)}\`\n\n` +
          `*Likely causes:* rate-limit window saturated, CF block, master depleted, or session needs phone re-verification. Check Play777 admin via VNC and decide whether to wait it out, restart creditloader to clear in-memory retry state, or escalate.`,
          { parse_mode: 'Markdown' }
        );
        await emitEvent(job.id, 'LOAD_THRASH_ALERT_SENT', 'INFO', {
          attempts: updatedJob.attempts,
          threshold: THRASH_ATTEMPTS_THRESHOLD,
          latestError: (result.error || '').slice(0, 200),
        });
        logger.warn('Thrash alert sent to admin Telegram', {
          jobId: job.id, invoiceId: job.invoiceId, attempts: updatedJob.attempts,
        });
      }
    } catch (alertErr) {
      logger.error('Thrash-alert pipeline failed', { jobId: job.id, error: alertErr.message });
      // Never throw from the alert path — the load already happened, we
      // don't want to confuse downstream by failing here.
    }
  }

  // Log verification result if available
  if (result.success && result.verified !== undefined) {
    await emitEvent(job.id, result.verified ? 'VERIFIED' : 'UNVERIFIED', result.verified ? 'SUCCESS' : 'INFO', {
      platform,
      account: account.username,
      transactionId: result.transactionId || null,
      verified: result.verified,
    });
  }

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

// CF auto-resume sweep — re-queue invoices stranded by a *Cloudflare* block.
// CF blocks are transient (Tony #6451 cleared in 16 min) but BLOCKED_VERIFICATION
// has no auto-resume, so without this a paid invoice sits until a human clicks
// Retry (Tony waited ~13h). This runs on an interval and is fully DB-driven, so
// it survives restarts (no fragile in-memory timer). ONLY CF_BLOCK auto-resumes;
// phone/email/captcha/login stay parked for a human. Bounded by MAX_CF_RETRIES,
// after which it escalates to a "needs you" alert and stops.
const CF_RESUME_COOLDOWN_MS = 20 * 60 * 1000; // wait 20 min after a block before retrying
const MAX_CF_RETRIES = 3; // give up (escalate to human) after this many auto-retries

async function resumeCfBlockedInvoices() {
  let resumed = 0;
  try {
    const blocked = await prisma.invoice.findMany({
      where: { status: 'BLOCKED_VERIFICATION' },
      include: { vendor: { select: { name: true } }, loadJobs: { select: { id: true } } },
    });
    for (const inv of blocked) {
      const jobIds = inv.loadJobs.map((j) => j.id);
      if (!jobIds.length) continue;

      // Only CF blocks auto-resume — check the most recent block event's cause.
      const lastBlock = await prisma.loadEvent.findFirst({
        where: { loadJobId: { in: jobIds }, step: 'BLOCKED_VERIFICATION' },
        orderBy: { id: 'desc' },
      });
      const meta = lastBlock && (typeof lastBlock.metadata === 'string' ? JSON.parse(lastBlock.metadata) : lastBlock.metadata);
      if (!meta || meta.blockade !== 'CF_BLOCK') continue;

      // Respect the cooldown — give CF time to release the IP.
      const ageMs = Date.now() - new Date(lastBlock.createdAt).getTime();
      if (ageMs < CF_RESUME_COOLDOWN_MS) continue;

      const cfRetries = await prisma.loadEvent.count({
        where: { loadJobId: { in: jobIds }, step: 'CF_COOLDOWN_RETRY' },
      });
      if (cfRetries >= MAX_CF_RETRIES) {
        // Out of auto-retries — escalate to a human, once.
        const escalated = await prisma.loadEvent.findFirst({
          where: { loadJobId: { in: jobIds }, step: 'CF_EXHAUSTED_ALERT_SENT' },
        });
        if (!escalated) {
          await blockadeDetector.alertBlockade(
            blockadeDetector.BLOCKADES.find((x) => x.type === 'CF_BLOCK'),
            { invoiceId: inv.id, vendorName: inv.vendor.name, mode: 'exhausted', attempts: cfRetries }
          );
          await emitEvent(jobIds[0], 'CF_EXHAUSTED_ALERT_SENT', 'INFO', { invoiceId: inv.id, attempts: cfRetries });
          logger.error('CF auto-resume exhausted — escalated to human', { invoiceId: inv.id, attempts: cfRetries });
        }
        continue;
      }

      // Re-queue: reset FAILED jobs → PENDING (preserves SUCCESS jobs, so no
      // double-load), flip to PAID, and run. A fresh exit IP is rotated per
      // launch by the browser layer, so the retry isn't on the blocked IP.
      await emitEvent(jobIds[0], 'CF_COOLDOWN_RETRY', 'INFO', { invoiceId: inv.id, attempt: cfRetries + 1 });
      await prisma.loadJob.updateMany({
        where: { invoiceId: inv.id, status: 'FAILED' },
        data: { status: 'PENDING', errorMessage: null },
      });
      await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'PAID' } });
      logger.warn('CF auto-resume — re-queuing blocked invoice', {
        invoiceId: inv.id, vendor: inv.vendor.name, attempt: cfRetries + 1,
      });
      processInvoice(inv.id).catch((err) =>
        logger.error('CF auto-resume requeue failed', { invoiceId: inv.id, error: err.message })
      );
      resumed += 1;
    }
  } catch (err) {
    logger.error('CF auto-resume sweep failed', { error: err.message });
  }
  return { resumed };
}

// Re-nag sweep for HUMAN-required blockades (phone/email/captcha/login). Those
// park as BLOCKED_VERIFICATION and alert ONCE — but if that single alert is
// missed (Claudia #831's fired at 3 AM and the load sat 1.5 days), nothing ever
// nags again. This re-alerts the main group every RENAG hours, with how long
// it's been waiting, until a human resolves it (status leaves BLOCKED_VERIFICATION).
// CF blocks are skipped here — they auto-resume via resumeCfBlockedInvoices().
const HUMAN_RENAG_INTERVAL_MS = 2 * 60 * 60 * 1000; // re-nag every 2h until resolved

async function renagHumanBlockades() {
  try {
    const blocked = await prisma.invoice.findMany({
      where: { status: 'BLOCKED_VERIFICATION' },
      include: { vendor: { select: { name: true } }, loadJobs: { select: { id: true } } },
    });
    for (const inv of blocked) {
      const jobIds = inv.loadJobs.map((j) => j.id);
      if (!jobIds.length) continue;

      const lastBlock = await prisma.loadEvent.findFirst({
        where: { loadJobId: { in: jobIds }, step: 'BLOCKED_VERIFICATION' },
        orderBy: { id: 'desc' },
      });
      const meta = lastBlock && (typeof lastBlock.metadata === 'string' ? JSON.parse(lastBlock.metadata) : lastBlock.metadata);
      if (!meta) continue;
      if (meta.blockade === 'CF_BLOCK') continue; // CF auto-resumes — not a human's problem

      // Nag interval is measured from the most recent alert (initial or prior re-nag).
      const lastAlert = await prisma.loadEvent.findFirst({
        where: { loadJobId: { in: jobIds }, step: { in: ['BLOCKADE_ALERT_SENT', 'BLOCKADE_RENAG'] } },
        orderBy: { id: 'desc' },
      });
      const lastAlertAt = new Date((lastAlert || lastBlock).createdAt).getTime();
      if (Date.now() - lastAlertAt < HUMAN_RENAG_INTERVAL_MS) continue;

      const hours = Math.floor((Date.now() - new Date(lastBlock.createdAt).getTime()) / 3_600_000);
      const b = blockadeDetector.BLOCKADES.find((x) => x.type === meta.blockade);
      const label = b ? b.label : meta.blockade;
      const action = b ? b.action : 'Resolve it in the platform, then retry the invoice from the dashboard.';
      try {
        await telegram.bot.sendMessage(
          process.env.TELEGRAM_ADMIN_CHAT_ID,
          `⏰ *STILL BLOCKED ~${hours}h — NEEDS YOU* ${b ? b.emoji : ''}\n\n` +
          `Invoice #${inv.id} — ${inv.vendor.name}\n${label}\n\n` +
          `This has been waiting on a human for ~${hours}h and will NOT clear itself.\n\n*Action:* ${action}`,
          { parse_mode: 'Markdown' }
        );
        await emitEvent(jobIds[0], 'BLOCKADE_RENAG', 'INFO', { invoiceId: inv.id, blockade: meta.blockade, hoursBlocked: hours });
        logger.warn('Re-nagged human-required blockade', { invoiceId: inv.id, blockade: meta.blockade, hours });
      } catch (e) {
        logger.error('Blockade re-nag send failed', { invoiceId: inv.id, error: e.message });
      }
    }
  } catch (err) {
    logger.error('Human blockade re-nag sweep failed', { error: err.message });
  }
}

module.exports = { processInvoice, resumeCfBlockedInvoices, renagHumanBlockades };
