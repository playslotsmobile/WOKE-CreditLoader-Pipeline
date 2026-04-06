const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const prisma = require('./db/client');
const formRoutes = require('./routes/forms');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors());
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
      include: { accounts: true },
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
    });
  } catch (err) {
    console.error('Vendor lookup error:', err);
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

    // Save to .env
    const fs = require('fs');
    const envPath = require('path').join(__dirname, '..', '.env');
    let env = fs.readFileSync(envPath, 'utf8');
    env = env.replace(/QB_REFRESH_TOKEN=.*/, `QB_REFRESH_TOKEN=${data.refresh_token}`);
    env = env.replace(/QB_REALM_ID=.*/, `QB_REALM_ID=${realmId}`);
    fs.writeFileSync(envPath, env);
    process.env.QB_REFRESH_TOKEN = data.refresh_token;
    process.env.QB_REALM_ID = realmId;

    console.log('QB OAuth complete — refresh token and realm ID saved');
    res.send('QuickBooks connected successfully! Refresh token and Realm ID saved. You can close this tab.');
  } catch (err) {
    console.error('QB OAuth error:', err);
    res.status(500).send('OAuth failed: ' + err.message);
  }
});

app.use('/api', formRoutes);
app.use('/api', webhookRoutes);
app.use('/api/admin', adminRoutes);

// Serve frontend static files
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
