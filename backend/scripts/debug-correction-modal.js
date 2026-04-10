require('dotenv').config();
const { getBrowserContext, closeBrowser, humanDelay } = require('./src/services/browser');
const { ensureLoggedIn } = require('./src/services/play777');

const VENDORS_URL = 'https://pna.play777games.com/vendors-overview';

async function debugCorrectionModal() {
  let session;
  try {
    session = await getBrowserContext('play777');
    const context = session.context;
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) throw new Error('Not logged in');

    // Go to vendors page
    await page.goto(VENDORS_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await humanDelay(5000, 6000);

    // Find CR1234 row
    const row = page.locator('tr:has(a[onclick="return showAgentDrawer(1114)"])');
    await row.waitFor({ state: 'attached', timeout: 30000 });
    await row.scrollIntoViewIfNeeded();
    await humanDelay(500, 1000);

    // Click $ button
    const actionButtons = await row.locator('td').last().locator('button.btn-icon').all();
    await actionButtons[1].click();
    await humanDelay(2000, 3000);

    // Screenshot: default deposit modal
    await page.screenshot({ path: '/tmp/modal-deposit.png', fullPage: false });
    console.log('Screenshot 1: deposit modal saved');

    // Now switch to Correction
    const form = page.locator('#app-form-agent-balance');
    await form.waitFor({ state: 'attached', timeout: 10000 });

    const txTypeSelect = form.locator('.multiselect').nth(0);
    await txTypeSelect.click();
    await humanDelay(500, 1000);

    // Screenshot with dropdown open
    await page.screenshot({ path: '/tmp/modal-txtype-dropdown.png', fullPage: false });
    console.log('Screenshot 2: transaction type dropdown saved');

    const correctionOption = form.locator('li[aria-label="Correction"]');
    await correctionOption.waitFor({ state: 'attached', timeout: 5000 });
    await correctionOption.click();
    await humanDelay(2000, 3000);

    // Screenshot: correction modal
    await page.screenshot({ path: '/tmp/modal-correction.png', fullPage: false });
    console.log('Screenshot 3: correction modal saved');

    // Log all inputs visible
    const inputs = await form.locator('input').all();
    console.log(`Input count: ${inputs.length}`);
    for (let i = 0; i < inputs.length; i++) {
      const type = await inputs[i].getAttribute('type');
      const cls = await inputs[i].getAttribute('class');
      const disabled = await inputs[i].getAttribute('disabled');
      const placeholder = await inputs[i].getAttribute('placeholder');
      console.log(`  input[${i}]: type="${type}" class="${cls}" disabled=${disabled} placeholder="${placeholder}"`);
    }

    // Fill credits input to see what happens
    const creditsInput = form.locator('input[type="number"]').nth(1);
    await creditsInput.click();
    await creditsInput.fill('1');
    await humanDelay(1000, 2000);

    // Screenshot after filling
    await page.screenshot({ path: '/tmp/modal-correction-filled.png', fullPage: false });
    console.log('Screenshot 4: correction filled saved');

    // Log modal footer
    const modal = page.locator('.modal.show').first();
    const footerHtml = await modal.locator('.modal-footer').innerHTML().catch(() => 'NO FOOTER');
    console.log('\nModal footer HTML:\n', footerHtml);

    // Log all buttons in modal
    const buttons = await modal.locator('button').all();
    console.log(`\nButton count in modal: ${buttons.length}`);
    for (let i = 0; i < buttons.length; i++) {
      const text = await buttons[i].textContent();
      const cls = await buttons[i].getAttribute('class');
      console.log(`  button[${i}]: "${text.trim()}" class="${cls}"`);
    }

    // Log full form HTML
    const formHtml = await form.innerHTML();
    console.log('\nForm HTML:\n', formHtml);

    // Close modal
    await page.keyboard.press('Escape');
    await humanDelay(500, 1000);
    await page.close();
  } catch (err) {
    console.error('Debug error:', err.message);
  } finally {
    if (session) await closeBrowser(session);
  }
}

debugCorrectionModal();
