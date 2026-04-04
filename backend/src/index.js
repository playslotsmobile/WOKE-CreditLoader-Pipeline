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
app.use(express.json());

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
      })),
    });
  } catch (err) {
    console.error('Vendor lookup error:', err);
    res.status(500).json({ error: 'Failed to load vendor' });
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
