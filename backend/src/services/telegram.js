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

  const mainMsg = `✅ LOADED ✅

${vendor.name}

Invoice ID: ${invoice.qbInvoiceId || invoice.id}

${allocationBlocks(allocations)}`;

  await bot.sendMessage(ADMIN_CHAT_ID, mainMsg);

  if (vendor.telegramChatId) {
    const vendorMsg = `✅ LOADED ✅

Credits have been loaded.

${allocationBlocksCreditsOnly(allocations)}`;

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

async function sendVendorFailed(vendor, invoice) {
  if (!vendor.telegramChatId) return;
  try {
    await bot.sendMessage(
      vendor.telegramChatId,
      `⚠️ Loading Issue\n\nThere was an issue loading your credits for invoice #${invoice.id}. Our team has been notified and will resolve this shortly.`
    );
  } catch (err) {
    logger.error('Telegram vendor failed notification failed', { error: err });
  }
}

module.exports = {
  bot,
  sendWireSubmitted,
  sendInvoiceSent,
  sendLoaded,
  sendVendorPaid,
  sendVendorFailed,
};
