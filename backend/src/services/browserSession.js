const crypto = require('crypto');
const prisma = require('../db/client');
const { logger } = require('./logger');

// AES-256-GCM at-rest encryption for operator-portal session cookies.
// Plaintext cookies in the DB = direct master account compromise if DB ever
// leaks (Railway dashboard, leaked DATABASE_URL, future SQL injection).
// Format: enc:v1:<iv_hex>:<authtag_hex>:<ciphertext_hex>
// Legacy plaintext (raw JSON starting with "[") is auto-detected on read and
// re-encrypted on the next save (no manual migration step needed).
const ENC_PREFIX = 'enc:v1:';

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.COOKIE_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error('COOKIE_ENCRYPTION_KEY must be set (>=32 chars; generate with: openssl rand -hex 32)');
  }
  // Derive 32 bytes via SHA-256 so the env value can be any length/format.
  cachedKey = crypto.createHash('sha256').update(raw).digest();
  return cachedKey;
}

function encryptValue(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decryptValue(blob) {
  if (!blob || typeof blob !== 'string') return null;
  if (!blob.startsWith(ENC_PREFIX)) {
    // Legacy plaintext — return as-is. Will be encrypted on next save.
    return blob;
  }
  const rest = blob.slice(ENC_PREFIX.length);
  const [ivHex, tagHex, ctHex] = rest.split(':');
  if (!ivHex || !tagHex || !ctHex) return null;
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

function serializeCookies(cookies) {
  return JSON.stringify(cookies);
}

function deserializeCookies(json) {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

async function saveCookies(platform, cookies) {
  const key = `${platform}_cookies`;
  let value;
  try {
    value = encryptValue(serializeCookies(cookies));
  } catch (err) {
    logger.error('Failed to encrypt cookies — refusing to save plaintext', { platform, error: err.message });
    return;
  }
  try {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    logger.info('Session cookies saved (encrypted)', { platform, cookieCount: cookies.length });
  } catch (err) {
    logger.error('Failed to save cookies', { platform, error: err });
  }
}

async function loadCookies(platform) {
  const key = `${platform}_cookies`;
  try {
    const setting = await prisma.setting.findUnique({ where: { key } });
    if (!setting) return [];
    let plaintext;
    try {
      plaintext = decryptValue(setting.value);
    } catch (err) {
      logger.error('Cookie decrypt failed — discarding stored value', { platform, error: err.message });
      return [];
    }
    if (plaintext === null) {
      logger.warn('Cookie value malformed — treating as empty', { platform });
      return [];
    }
    const wasLegacy = !setting.value.startsWith(ENC_PREFIX);
    const cookies = deserializeCookies(plaintext);
    logger.info('Session cookies loaded', { platform, cookieCount: cookies.length, legacy: wasLegacy });
    return cookies;
  } catch (err) {
    logger.error('Failed to load cookies', { platform, error: err });
    return [];
  }
}

async function restoreSession(context, platform) {
  const cookies = await loadCookies(platform);
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }
  return cookies.length > 0;
}

async function saveSession(context, platform) {
  const cookies = await context.cookies();
  await saveCookies(platform, cookies);
}

module.exports = {
  serializeCookies,
  deserializeCookies,
  saveCookies,
  loadCookies,
  restoreSession,
  saveSession,
};
