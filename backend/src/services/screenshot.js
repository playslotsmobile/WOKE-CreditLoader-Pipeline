const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const FAILURE_DIR = '/var/log/creditloader/failures';

function buildScreenshotPath(invoiceOrJobId, step) {
  const sanitized = step.replace(/[^a-zA-Z0-9_-]/g, '-');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(FAILURE_DIR, `${invoiceOrJobId}-${sanitized}-${ts}.png`);
}

async function captureFailure(page, invoiceOrJobId, step) {
  try {
    fs.mkdirSync(FAILURE_DIR, { recursive: true });

    const screenshotPath = buildScreenshotPath(invoiceOrJobId, step);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Also save HTML
    const htmlPath = screenshotPath.replace('.png', '.html');
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);

    logger.info('Failure screenshot captured', {
      screenshotPath,
      step,
      url: page.url(),
    });

    return screenshotPath;
  } catch (err) {
    logger.error('Failed to capture screenshot', { error: err, step });
    return null;
  }
}

module.exports = { buildScreenshotPath, captureFailure, FAILURE_DIR };
