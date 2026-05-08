const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const prisma = require('./db/client');
const formRoutes = require('./routes/forms');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const creditLineRoutes = require('./routes/creditLine');
const { startWebhookProcessor } = require('./services/webhookProcessor');
const { startHealthChecks } = require('./services/healthDigest');
const { resumeOrphanedLoads } = require('./services/loadResumption');
const { logger } = require('./services/logger');
const { requireAdmin } = require('./middleware/auth');

const app = express();
// Behind nginx/Cloudflare — trust the first proxy hop so X-Forwarded-For works.
// Required for express-rate-limit to bucket per real client IP, not per proxy.
app.set('trust proxy', 1);

// Security headers. CSP is permissive on script-src because the SPA bundle is
// served from same-origin and inlines a tiny bootstrap. Tighten if/when we
// move to nonce-based CSP.
app.use(helmet({
  contentSecurityPolicy: false, // SPA + inline styles from Tailwind would need a custom policy
  crossOriginEmbedderPolicy: false, // would block our own /api/uploads images otherwise
}));

// CORS: in prod the SPA is same-origin (served by this backend), so CORS is
// only needed for dev. Lock to known origins; reject everything else with the
// implicit no-CORS-headers response (browsers will block).
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'https://load.wokeavr.com,http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // No origin = same-origin or curl/healthcheck — allow.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
}));
app.use(express.json({
  verify: (req, res, buf) => {
    // Preserve raw body for QB webhook HMAC verification
    if (req.originalUrl === '/api/qb-webhook') {
      req.rawBody = buf.toString('utf8');
    }
  },
}));

// Make prisma available to routes
app.set('prisma', prisma);

// ── Routes ──
app.get('/api/vendors/:slug', async (req, res) => {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { slug: req.params.slug },
      include: { accounts: true, creditLine: true },
    });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    // Map to API format
    res.json({
      id: vendor.id,
      slug: vendor.slug,
      name: vendor.name,
      businessName: vendor.businessName,
      email: vendor.email,
      qbCustomerName: vendor.qbCustomerId,
      telegramChatId: vendor.telegramChatId,
      cashAllowed: vendor.cashAllowed,
      accounts: vendor.accounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        username: a.username,
        operatorId: a.operatorId,
        rate: a.rate.toString(),
        loadType: a.loadType,
        chainToAccId: a.chainToAccId,
        parentVendorAccId: a.parentVendorAccId,
      })),
      creditLine: vendor.creditLine ? {
        capAmount: Number(vendor.creditLine.capAmount),
        usedAmount: Number(vendor.creditLine.usedAmount),
        availableAmount: Number(vendor.creditLine.capAmount) - Number(vendor.creditLine.usedAmount),
      } : null,
    });
  } catch (err) {
    logger.error('Vendor lookup error', { error: err });
    res.status(500).json({ error: 'Failed to load vendor' });
  }
});

// OAuth flow for QuickBooks
app.get('/api/qb-auth', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.QB_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: 'https://load.wokeavr.com/api/qb-callback',
    state: 'wokeavr',
  });
  res.redirect(`https://appcenter.intuit.com/connect/oauth2?${params}`);
});

app.get('/api/qb-callback', async (req, res) => {
  const { code, realmId } = req.query;
  if (!code) return res.status(400).send('No auth code received');

  try {
    const auth = Buffer.from(
      process.env.QB_CLIENT_ID + ':' + process.env.QB_CLIENT_SECRET
    ).toString('base64');

    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + auth,
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=https://load.wokeavr.com/api/qb-callback`,
    });

    const data = await tokenRes.json();
    if (!data.refresh_token) {
      return res.status(500).send('Token exchange failed: ' + JSON.stringify(data));
    }

    // Save to DB
    process.env.QB_REFRESH_TOKEN = data.refresh_token;
    process.env.QB_REALM_ID = realmId;
    await prisma.setting.upsert({
      where: { key: 'qb_refresh_token' },
      update: { value: data.refresh_token },
      create: { key: 'qb_refresh_token', value: data.refresh_token },
    });
    await prisma.setting.upsert({
      where: { key: 'qb_realm_id' },
      update: { value: realmId },
      create: { key: 'qb_realm_id', value: realmId },
    });

    logger.info('QB OAuth complete — refresh token and realm ID saved to DB');
    res.send('QuickBooks connected successfully! Tokens saved. You can close this tab.');
  } catch (err) {
    logger.error('QB OAuth error', { error: err });
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

app.use('/api', formRoutes);
app.use('/api', creditLineRoutes);
app.use('/api', webhookRoutes);
app.use('/api/admin', adminRoutes);

// Serve failure screenshots for admin dashboard
// requireAdmin accepts ?token= as fallback so <a href> direct opens work
app.use('/api/screenshots', requireAdmin, express.static('/var/log/creditloader/failures'));

// Serve wire receipt uploads for admin dashboard
// Now auth-gated. Filenames also moved to crypto.randomBytes for new uploads
// (legacy wire-${Date.now()}.pdf still served — they were previously public,
// no benefit to renaming retroactively without a separate migration).
app.use('/api/uploads', requireAdmin, express.static(path.join(__dirname, '..', 'uploads')));

// Serve frontend static files
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Expire stale REQUESTED invoices older than 7 days
async function expireStaleInvoices() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const expired = await prisma.invoice.updateMany({
      where: { status: 'REQUESTED', submittedAt: { lt: cutoff } },
      data: { status: 'FAILED' },
    });
    if (expired.count > 0) {
      logger.info('Expired stale REQUESTED invoices', { count: expired.count });
    }
  } catch (err) {
    logger.error('Invoice expiry check failed', { error: err });
  }
}

async function waitForAdsPower() {
  const ADSPOWER_API = process.env.ADSPOWER_API_URL || 'http://127.0.0.1:50325';
  const ADSPOWER_TOKEN = process.env.ADSPOWER_API_KEY;
  const MAX_RETRIES = 20;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${ADSPOWER_API}/api/v1/user/list?page_size=1`, {
        headers: { Authorization: `Bearer ${ADSPOWER_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (data.code === 0) {
        logger.info('AdsPower is ready', { attempt });
        return;
      }
      logger.warn('AdsPower responded but returned non-zero code', { attempt, code: data.code });
    } catch (err) {
      logger.warn('AdsPower not reachable, retrying in 30s', { attempt, maxRetries: MAX_RETRIES, error: err.message });
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }

  logger.warn('AdsPower did not become ready after max retries — starting anyway', { maxRetries: MAX_RETRIES });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info('Backend running', { port: PORT });
  await waitForAdsPower();
  expireStaleInvoices(); // Check on startup
  setInterval(expireStaleInvoices, 60 * 60 * 1000); // Check every hour
  // Re-queue any invoices left in LOADING state when the previous process
  // died (deploy, OOM, crash). Without this, those invoices stay LOADING
  // forever — silently dropped.
  resumeOrphanedLoads().catch((err) => logger.error('Load resumption failed', { error: err.message }));
  startWebhookProcessor();
  startHealthChecks();
});
