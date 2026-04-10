require('dotenv').config();
const { getBrowserContext, closeBrowser, humanDelay } = require('./src/services/browser');
const { ensureLoggedIn } = require('./src/services/play777');

(async () => {
  let session;
  try {
    session = await getBrowserContext('play777');
    const page = await session.context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    console.log('Logged in:', loggedIn);

    // Try navigating via the SPA menu instead of direct goto
    // First check if we're already on the dashboard
    console.log('Current URL after login:', page.url());

    // Navigate with commit event (earliest possible)
    await page.goto('https://pna.play777games.com/vendors-overview', { waitUntil: 'commit', timeout: 30000 });
    console.log('Page commit received');

    // Wait and screenshot at intervals to see loading progress
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(5000);
      await page.screenshot({ path: `/tmp/vendors-${i}.png` });
      const rows = await page.locator('tr:has(a[onclick*="showAgentDrawer"])').count();
      console.log(`After ${(i+1)*5}s: ${rows} vendor rows`);
    }
    console.log('Current URL:', page.url());

    await page.screenshot({ path: '/tmp/vendors-page.png' });
    console.log('Screenshot saved');

    // Check for 1288
    const row1288 = await page.locator('tr:has(a[onclick="return showAgentDrawer(1288)"])').count();
    console.log('Rows with 1288:', row1288);

    // Count all vendor rows
    const allRows = await page.locator('tr:has(a[onclick*="showAgentDrawer"])').count();
    console.log('Total vendor rows:', allRows);

    // List vendor IDs
    const ids = await page.evaluate(() => {
      const links = document.querySelectorAll('a[onclick*="showAgentDrawer"]');
      return Array.from(links).slice(0, 30).map(a => {
        const match = a.getAttribute('onclick').match(/showAgentDrawer\((\d+)\)/);
        return match ? match[1] : null;
      });
    });
    console.log('Vendor IDs found:', ids);

    // Check pagination
    const pagination = await page.locator('.pagination, [class*="paginat"]').count();
    console.log('Pagination elements:', pagination);

    await page.close();
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    if (session) await closeBrowser(session);
  }
})();
