const crypto = require('crypto');
const prisma = require('../db/client');
const { logger } = require('./logger');

/**
 * Lightweight idempotency layer for invoice/credit-line submission endpoints.
 * Stores the first response for an Idempotency-Key under a Setting row keyed
 * `idem:<key>` with TTL ~24h. Subsequent calls within the window replay the
 * stored response instead of re-creating the invoice / re-drawing.
 *
 * Compromise: uses Setting kv (already-running) as the cache. A future Redis
 * or dedicated table would be cleaner, but Setting is fine for the modest
 * volume (vendors submit a few invoices a week).
 */
const TTL_MS = 24 * 60 * 60 * 1000;

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

async function check(key, payload) {
  if (!key) return null;
  const settingKey = `idem:${key}`;
  const row = await prisma.setting.findUnique({ where: { key: settingKey } });
  if (!row) return null;
  let parsed;
  try { parsed = JSON.parse(row.value); } catch { return null; }
  if (!parsed || !parsed.expiresAt || Date.parse(parsed.expiresAt) < Date.now()) {
    await prisma.setting.deleteMany({ where: { key: settingKey } });
    return null;
  }
  // Soft-fingerprint check: if the payload changed under the same key,
  // refuse the replay (likely a key reuse bug, not an idempotent retry).
  const fp = fingerprint(payload);
  if (parsed.fp && parsed.fp !== fp) {
    logger.warn('Idempotency key reused with different payload — rejecting', { key });
    return { conflict: true };
  }
  return { hit: true, response: parsed.response };
}

async function record(key, payload, response) {
  if (!key) return;
  const settingKey = `idem:${key}`;
  const value = JSON.stringify({
    fp: fingerprint(payload),
    response,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  });
  try {
    await prisma.setting.upsert({
      where: { key: settingKey },
      update: { value },
      create: { key: settingKey, value },
    });
  } catch (err) {
    logger.warn('Idempotency record failed (non-fatal)', { key, error: err.message });
  }
}

module.exports = { check, record };
