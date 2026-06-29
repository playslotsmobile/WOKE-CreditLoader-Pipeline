// blockadeDetector — classify load failures into actionable "blockade" types so
// the operator gets told WHAT is wrong (and we STOP thrashing) instead of the
// loader silently retrying into a wall.
//
// Born from the 2026-06-23 incident: a Play777 "Update Your Contact" phone modal
// blocked the vendors page, the loader retried 25+ times, tripped Cloudflare's
// hard block, and the operator only found out by looking at the screen. The whole
// point here is: detect human-action-required walls on the FIRST hit, stop, and
// send a specific, actionable alert to the main Telegram group.
//
// See ~/My Brain/Projects/creditloader.md (Lessons Learned 2026-06-23).

const fs = require('fs');
const { logger } = require('./logger');
// telegram is lazy-required inside alertBlockade so this module (and its pure
// classify() logic) can be imported/tested without spinning up the bot.

// Hard blockades = a human must act. We STOP retrying (retrying just burns
// rate-limit slots and escalates Cloudflare from challenge -> hard block).
// Each entry carries the operator-facing action so the alert is self-contained.
const BLOCKADES = [
  {
    type: 'CF_BLOCK',
    emoji: '🛑',
    label: 'Cloudflare hard block',
    // CF blocks are TRANSIENT — they self-clear in minutes (Tony #6451: cleared
    // in 16 min). Unlike the phone/email/captcha walls, this one doesn't need a
    // human; the CF auto-resume sweep retries it on a fresh exit IP after a
    // cooldown. Only escalates to "needs you" if it's still blocked after N tries.
    autoResume: true,
    patterns: [
      /sorry,?\s*you have been blocked/i,
      /attention required.*cloudflare/i,
      /cf-mitigated/i,
      /you are unable to access/i,
      /\bcloudflare\b.*\bblocked\b/i,
    ],
    action:
      'Cloudflare blocked our exit IP (usually after too many rapid requests). STOP hitting the portal — every reload deepens it. It clears in ~30–60 min, or instantly on a fresh exit IP. Then load the invoice manually via the ROOT url (pna.play777games.com/ then click in), not a deep link.',
  },
  {
    type: 'PHONE_VERIFICATION',
    emoji: '📵',
    label: 'Phone verification / "Update Your Contact" modal',
    patterns: [
      /update your contact/i,
      /verify your phone/i,
      /change[-\s]?phone/i,
      /phone[-\s]?verif/i,
      /PHONE_VERIFICATION_REQUIRED/i,
      /please.*update.*phone number/i,
    ],
    action:
      'Play777 is forcing phone re-verification with a modal that sits on top of the vendors page and blocks loading. Open the Play777 admin via VNC, dismiss/complete the "Update Your Contact" modal, then retry the invoice from the dashboard.',
  },
  {
    type: 'EMAIL_VERIFICATION',
    emoji: '📧',
    label: 'Email verification required',
    patterns: [/verify your email/i, /email verification/i, /confirm your email/i, /EMAIL_VERIFICATION_REQUIRED/i],
    action: 'The portal is requiring email verification before it will let us act. Complete it via VNC, then retry the invoice from the dashboard.',
  },
  {
    type: 'CAPTCHA',
    emoji: '🧩',
    label: 'CAPTCHA / human challenge',
    patterns: [/\bcaptcha\b/i, /press and hold/i, /are you (a )?human/i, /verify you are human/i, /hcaptcha|recaptcha|funcaptcha|arkose/i],
    action: 'A CAPTCHA / human challenge is blocking the session. Solve it via VNC, then retry the invoice from the dashboard.',
  },
  {
    type: 'LOGIN_REQUIRED',
    emoji: '🔑',
    label: 'Session expired / login or 2FA needed',
    patterns: [/login failed/i, /still on login page/i, /failed to login/i, /2FA code (was rejected|not received)/i, /session expired/i],
    action: 'The portal session is dead or needs 2FA. Re-login via VNC (the loader will prompt for the 2FA code), then retry the invoice from the dashboard.',
  },
];

// Transient signatures that SHOULD keep retrying — these are not blockades and
// must never short-circuit the retry path (rate-limit windows reopen, AdsPower
// crashes self-heal, network blips pass).
const TRANSIENT = [
  /Rate limit:/i,
  /Network service crashed/i,
  /GPU process isn't usable/i,
  /AdsPower/i,
  /ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND/i,
  /Target closed|Protocol error/i,
];

function isTransient(text) {
  return TRANSIENT.some((re) => re.test(text || ''));
}

/**
 * Classify an error string (and/or scraped page text) into a hard blockade.
 * Returns the blockade descriptor, or null when it's not a recognized
 * human-action-required wall (i.e. let the normal retry logic handle it).
 *
 * An explicit `BLOCKADE:<TYPE>` tag in the text wins — that's how the platform
 * drivers hand a pre-identified blockade up through layers that re-wrap errors.
 */
function classify(text) {
  const hay = String(text || '');
  const tagged = /BLOCKADE:([A-Z_]+)/.exec(hay);
  if (tagged) {
    const b = BLOCKADES.find((x) => x.type === tagged[1]);
    if (b) return b;
  }
  if (isTransient(hay)) return null;
  for (const b of BLOCKADES) {
    if (b.patterns.some((re) => re.test(hay))) return b;
  }
  return null;
}

/**
 * Scan a live Playwright page for blockade signatures — used when an expected
 * element (e.g. the vendors table) fails to appear, to tell "a modal/CF page
 * blocked us" apart from "the page was just slow". Returns a blockade
 * descriptor or null. Never throws (returns null on any probe error).
 */
async function detectOnPage(page) {
  try {
    const probe = await page.evaluate(() => ({
      txt: ((document.body && document.body.innerText) || '').slice(0, 4000),
      title: document.title || '',
      hasModal: !!document.querySelector('.modal.show, .modal.fade.show, [role="dialog"]'),
      hasPhoneInput: !!document.querySelector('input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i]'),
    }));
    // Cloudflare block/challenge pages put their text in title + body.
    const fromText = classify(`${probe.title}\n${probe.txt}`);
    if (fromText) return fromText;
    // A modal carrying a phone field is the "Update Your Contact" wall.
    if (probe.hasModal && probe.hasPhoneInput) return BLOCKADES.find((b) => b.type === 'PHONE_VERIFICATION');
    return null;
  } catch (err) {
    logger.warn('blockadeDetector.detectOnPage probe failed', { error: err.message });
    return null;
  }
}

/**
 * Send a specific, actionable alert to the MAIN admin Telegram group, with the
 * failure screenshot attached when we have one. Caller is responsible for
 * dedup (don't spam the same invoice). Never throws.
 */
async function alertBlockade(blockade, { invoiceId, vendorName, jobId, screenshotPath, mode = 'needs-human', attempts } = {}) {
  const who = `Invoice #${invoiceId || '?'}${vendorName ? ` — ${vendorName}` : ''}`;
  let body;
  if (mode === 'auto-retry') {
    // Transient (CF) — credits are held and the loader will retry itself on a
    // fresh exit IP after a cooldown. No human action needed yet.
    body =
      `${blockade.emoji} *LOAD HELD — ${blockade.label}*\n\n` +
      `${who}\nType: \`${blockade.type}\`\n\n` +
      `Credits are *held* (not lost) — the loader will *auto-retry* on a fresh IP after a short cooldown. ` +
      `No action needed unless you get an "auto-retry exhausted" alert for this invoice.`;
  } else if (mode === 'exhausted') {
    // CF auto-retries used up — now it genuinely needs a person.
    body =
      `🚨 *LOAD STILL BLOCKED — ${blockade.label}* (auto-retry exhausted)\n\n` +
      `${who}\nType: \`${blockade.type}\`\n\n` +
      `The loader auto-retried ${attempts != null ? attempts : 'several'}× and is *still* CF-blocked. It has stopped — *this one needs you.*\n\n` +
      `*Action:* ${blockade.action}`;
  } else {
    // Human-required wall (phone/email/captcha/login) — stop and wait for a person.
    body =
      `${blockade.emoji} *LOAD BLOCKED — ${blockade.label}*\n\n` +
      `${who}\nType: \`${blockade.type}\`\n\n` +
      `The loader hit a wall that needs a human, so it *STOPPED* — it is not retrying (retrying just trips Cloudflare).\n\n` +
      `*Action:* ${blockade.action}`;
  }
  const caption = body;
  const telegram = require('./telegram');
  try {
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      await telegram.bot.sendPhoto(process.env.TELEGRAM_ADMIN_CHAT_ID, fs.createReadStream(screenshotPath), {
        caption,
        parse_mode: 'Markdown',
      });
    } else {
      await telegram.bot.sendMessage(process.env.TELEGRAM_ADMIN_CHAT_ID, caption, { parse_mode: 'Markdown' });
    }
    logger.warn('Blockade alert sent', { type: blockade.type, invoiceId, jobId });
  } catch (err) {
    logger.error('Blockade alert send failed', { error: err.message, type: blockade.type, invoiceId });
  }
}

module.exports = { classify, detectOnPage, alertBlockade, isTransient, BLOCKADES };
