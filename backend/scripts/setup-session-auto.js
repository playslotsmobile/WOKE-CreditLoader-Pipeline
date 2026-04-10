// Setup session — opens persistent browser profile, waits for dashboard.
// Handles Cloudflare Turnstile — just click the checkbox when prompted.
// Once you reach the dashboard, cookies persist automatically in the profile.

require('dotenv').config();

const { getBrowserContext } = require('./src/services/browser');

async function setupSession() {
  const platform = process.argv[2] || 'play777';
  const urls = {
    play777: 'https://pna.play777games.com/login',
    iconnect: 'https://river-pay.com/office/login',
  };
  const dashboards = {
    play777: '/dashboard',
    iconnect: '/office',
  };

  const url = urls[platform];
  if (!url) {
    console.error('Usage: node setup-session-auto.js [play777|iconnect]');
    process.exit(1);
  }

  console.log(`Opening ${platform}...`);
  console.log('If you see a Cloudflare "Verify you are human" page, click the checkbox.');
  console.log('Then log in manually. Session saves automatically once you reach the dashboard.\n');

  const session = await getBrowserContext(platform);
  // Persistent context opens with a default page — use it or create new
  const pages = session.context.pages();
  const page = pages.length > 0 ? pages[0] : await session.context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  const dashPath = dashboards[platform];
  let attempts = 0;
  const maxAttempts = 300; // 10 minutes

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 2000));
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');

    // Waiting for Cloudflare
    if (title === 'Just a moment...' || title === '') {
      if (attempts % 10 === 0) {
        console.log('Waiting for Cloudflare challenge to be solved...');
      }
      attempts++;
      continue;
    }

    // Reached dashboard
    if (currentUrl.includes(dashPath)) {
      console.log(`\nDetected dashboard: ${currentUrl}`);
      console.log('Session persisted in browser profile. Done!');
      await session.context.close();
      process.exit(0);
    }

    if (attempts % 15 === 0) {
      console.log(`Waiting for login... (current: ${currentUrl})`);
    }
    attempts++;
  }

  console.error('Timed out (10 minutes). Please try again.');
  await session.context.close();
  process.exit(1);
}

setupSession().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
