const TelegramBot = require('node-telegram-bot-api');
const { logger } = require('./logger');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

function fmt(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function vendorLine(acct) {
  const id = acct.operatorId ? ` (${acct.operatorId})` : '';
  return `Vendor: ${acct.username}${id}`;
}

function platformLine(acct) {
  return `Platform: ${acct.platform === 'PLAY777' ? '777' : 'IConnect'}`;
}

function allocationBlocks(allocations) {
  return allocations
    .filter((a) => a.dollarAmount > 0)
    .map((a) => `${vendorLine(a)}\n${platformLine(a)}\nAmount: ${fmt(a.dollarAmount)}\nCredits: ${a.credits.toLocaleString()}`)
    .join('\n\n');
}

function allocationBlocksCreditsOnly(allocations) {
  return allocations
    .filter((a) => a.dollarAmount > 0)
    .map((a) => `${vendorLine(a)}\n${platformLine(a)}\nCredits: ${a.credits.toLocaleString()}`)
    .join('\n\n');
}

// ── Wire Submitted ──

async function sendWireSubmitted(vendor, invoice, allocations) {
  const mainMsg = `📩 Wire Submitted

${vendor.name}

Invoice ID: ${invoice.id}
Method: Wire
Amount: ${fmt(invoice.baseAmount)}

${allocationBlocks(allocations)}

📎 Wire receipt attached

🔒 PENDING WIRE CONFIRMATION 🔒`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    const vendorMsg = `📩 Wire Submission Received

Your wire form for ${fmt(invoice.baseAmount)} has been submitted. Credits will be loaded once the wire is confirmed.`;

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
}

// ── Invoice Sent (Card/ACH) ──

async function sendInvoiceSent(vendor, invoice, allocations) {
  const mainMsg = `📩 Invoice Sent

${vendor.name}

Invoice ID: ${invoice.qbInvoiceId || invoice.id}
Method: ${invoice.method}
Amount: ${fmt(invoice.baseAmount)}
Amount w/ Fee: ${fmt(invoice.totalAmount)}

${allocationBlocks(allocations)}

❌ DO NOT LOAD ❌`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    const vendorMsg = `📩 Invoice Sent

Your invoice for ${fmt(invoice.totalAmount)} has been sent to ${vendor.email}.

Method: ${invoice.method}
Amount: ${fmt(invoice.baseAmount)} + ${fmt(invoice.feeAmount)} fee`;

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
}

// ── Credits Loaded ──

async function sendLoaded(vendor, invoice, allocations) {
  const isCorrection = invoice.method === 'Correction';

  if (isCorrection) {
    const targets = allocations
      .filter((a) => a.credits > 0)
      .map((a) => `${a.username} (${a.operatorId}) — ${a.credits.toLocaleString()} credits`)
      .join('\n');

    const mainMsg = `📋 CORRECTION COMPLETE 📋

${vendor.name}

Invoice ID: ${invoice.id}

${targets}`;

    await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

    if (vendor.telegramChatId) {
      await bot.sendMessage(vendor.telegramChatId, `📋 CORRECTION COMPLETE 📋\n\nCredits have been moved.\n\n${targets}`);
    }
    return;
  }

  // Check if this invoice has a credit line repayment allocation
  const creditLineRepayment = allocations.find((a) => a.isCreditLineRepayment);
  const loadAllocations = allocations.filter((a) => !a.isCreditLineRepayment);

  let mainMsg = `✅ LOADED ✅

${vendor.name}

Invoice ID: ${invoice.qbInvoiceId || invoice.id}

${allocationBlocks(loadAllocations)}`;

  if (creditLineRepayment) {
    mainMsg += `\n\n💳 Credit Line Repayment — ${fmt(creditLineRepayment.dollarAmount)}`;
    if (creditLineRepayment.creditLineBalance) {
      mainMsg += `\n  Balance: ${fmt(creditLineRepayment.creditLineBalance.usedAmount)} / ${fmt(creditLineRepayment.creditLineBalance.capAmount)} used`;
    }
  }

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    let vendorMsg = `✅ LOADED ✅

Credits have been loaded.

${allocationBlocksCreditsOnly(loadAllocations)}`;

    if (creditLineRepayment) {
      vendorMsg += `\n\n💳 Credit Line Repayment — ${fmt(creditLineRepayment.dollarAmount)}`;
    }

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
}

async function sendVendorPaid(vendor, invoice) {
  if (!vendor.telegramChatId) return;
  try {
    await bot.sendMessage(
      vendor.telegramChatId,
      `💰 Payment Received\n\nYour payment of ${fmt(invoice.totalAmount)} has been received. Credits are being loaded.`
    );
  } catch (err) {
    logger.error('Telegram vendor paid notification failed', { error: err });
  }
}

// DEPRECATED: do not call. Vendor silence rule — vendors must never be told
// about loading failures. The fingerprint of a master-balance depletion and a
// generic load failure are indistinguishable at the moment of failure, so we
// never signal vendors either way. Kept as a no-op to avoid breaking any stale
// call sites; any caller will be logged loudly so it can be removed.
async function sendVendorFailed(vendor, invoice) {
  logger.warn('sendVendorFailed called — suppressed per vendor-silence rule', {
    invoiceId: invoice?.id,
    hasChatId: !!vendor?.telegramChatId,
  });
}

// ── Credit Line Draw ──

async function sendCreditLineDraw(vendor, invoice, allocations, creditLineBalance) {
  const allocLines = allocations
    .filter((a) => a.dollarAmount > 0)
    .map((a) => {
      const p = a.platform === 'PLAY777' ? '777' : 'IConnect';
      return `${a.username} (${p}) — ${a.credits.toLocaleString()} credits (${fmt(a.dollarAmount)})`;
    })
    .join('\n');

  const mainMsg = `💳 Credit Line Request

${vendor.name}

Amount: ${fmt(invoice.baseAmount)}

${allocLines}

Balance: ${fmt(creditLineBalance.usedAmount)} / ${fmt(creditLineBalance.capAmount)} used`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    const vendorMsg = `💳 Credit Line Request Received

Your credit line request for ${fmt(invoice.baseAmount)} has been submitted. Credits will be loaded shortly.

${allocLines}`;

    await bot.sendMessage(vendor.telegramChatId, vendorMsg);
  }
}

// ── Credit Line Repayment ──

async function sendCreditLineRepayment(vendor, repaymentAmount, creditLineBalance) {
  const mainMsg = `💳 Credit Line Repayment

${vendor.name}

Repaid: ${fmt(repaymentAmount)}
Balance: ${fmt(creditLineBalance.usedAmount)} / ${fmt(creditLineBalance.capAmount)} used`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);
}

module.exports = {
  bot,
  sendWireSubmitted,
  sendInvoiceSent,
  sendLoaded,
  sendVendorPaid,
  sendVendorFailed,
  sendCreditLineDraw,
  sendCreditLineRepayment,
};
