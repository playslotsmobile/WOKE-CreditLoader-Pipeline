const prisma = require('../db/client');
const { logger } = require('./logger');

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
  const value = serializeCookies(cookies);
  try {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    logger.info('Session cookies saved', { platform, cookieCount: cookies.length });
  } catch (err) {
    logger.error('Failed to save cookies', { platform, error: err });
  }
}

async function loadCookies(platform) {
  const key = `${platform}_cookies`;
  try {
    const setting = await prisma.setting.findUnique({ where: { key } });
    if (!setting) return [];
    const cookies = deserializeCookies(setting.value);
    logger.info('Session cookies loaded', { platform, cookieCount: cookies.length });
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
