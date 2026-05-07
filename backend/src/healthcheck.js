require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

const ADSPOWER_API = 'http://local.adspower.net:50325';
const ADSPOWER_TOKEN = process.env.ADSPOWER_API_KEY;

const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err.message });
  }
}

async function run() {
  console.log(`[${new Date().toISOString()}] Health check starting...`);

  // 1. Backend API
  await check('Backend API', async () => {
    const res = await fetch('http://localhost:3000/api/vendors/mike');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  // 2. QuickBooks OAuth — uses CompanyInfo (always exists, can't be deleted)
  // instead of a specific customer name which would break this if renamed.
  await check('QuickBooks API', async () => {
    const qb = require('./services/quickbooks');
    await qb.qbRequest('GET', 'query?query=SELECT * FROM CompanyInfo');
  });

  // 3. Database
  await check('Database', async () => {
    const prisma = require('./db/client');
    await prisma.vendor.count();
  });

  // 4. SSL / External access
  await check('External HTTPS', async () => {
    const res = await fetch('https://load.wokeavr.com/api/vendors/mike', {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  // 5. AdsPower API
  await check('AdsPower API', async () => {
    const res = await fetch(`${ADSPOWER_API}/api/v1/user/list?page_size=1`, {
      headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.msg);
  });

  // Report
  const failed = checks.filter((c) => !c.ok);
  const passed = checks.filter((c) => c.ok);

  console.log(`\nResults: ${passed.length}/${checks.length} passed`);
  checks.forEach((c) => {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.error ? ' — ' + c.error : ''}`);
  });

  if (failed.length > 0) {
    const failList = failed.map((f) => `❌ ${f.name}: ${f.error}`).join('\n');
    const msg = `🚨 HEALTH CHECK FAILED\n\n${failList}\n\n✅ ${passed.length}/${checks.length} passed\n⏰ ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}`;

    try {
      await bot.sendMessage(ADMIN_CHAT_ID, msg);
      console.log('\nTelegram alert sent.');
    } catch (err) {
      console.error('Failed to send Telegram alert:', err.message);
    }
  } else {
    console.log('\nAll checks passed — no alert needed.');
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

run();
