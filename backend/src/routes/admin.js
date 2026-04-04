const express = require('express');
const router = express.Router();
const telegram = require('../services/telegram');

router.get('/invoices', (req, res) => {
  const { invoices } = require('./forms');
  res.json(invoices);
});

// Confirm wire received — triggers auto-load
router.post('/invoices/:id/confirm-wire', async (req, res) => {
  try {
    const { invoices } = require('./forms');
    const id = parseInt(req.params.id);
    const entry = invoices.find((i) => i.invoice.id === id);

    if (!entry) return res.status(404).json({ error: 'Invoice not found' });
    if (entry.invoice.method !== 'Wire') return res.status(400).json({ error: 'Not a wire invoice' });
    if (entry.invoice.status !== 'PENDING') return res.status(400).json({ error: 'Invoice not in PENDING status' });

    entry.invoice.status = 'PAID';
    entry.invoice.paidAt = new Date().toISOString();

    // TODO Phase 5: trigger auto-loader here
    // For now, mark as LOADED immediately
    entry.invoice.status = 'LOADED';
    entry.invoice.loadedAt = new Date().toISOString();

    const vendors = req.app.get('vendors');
    const vendor = vendors.find((v) => v.slug === entry.invoice.vendorSlug);

    try {
      await telegram.sendLoaded(vendor, entry.invoice, entry.allocations);
    } catch (err) {
      console.error('Telegram loaded notification failed:', err.message);
    }

    res.json({ success: true, invoice: entry.invoice });
  } catch (err) {
    console.error('Confirm wire error:', err);
    res.status(500).json({ error: 'Failed to confirm wire' });
  }
});

// Manual load trigger (for retries or manual override)
router.post('/invoices/:id/trigger-load', async (req, res) => {
  try {
    const { invoices } = require('./forms');
    const id = parseInt(req.params.id);
    const entry = invoices.find((i) => i.invoice.id === id);

    if (!entry) return res.status(404).json({ error: 'Invoice not found' });

    entry.invoice.status = 'LOADING';

    // TODO Phase 5: trigger auto-loader here
    // For now, mark as LOADED immediately
    entry.invoice.status = 'LOADED';
    entry.invoice.loadedAt = new Date().toISOString();

    const vendors = req.app.get('vendors');
    const vendor = vendors.find((v) => v.slug === entry.invoice.vendorSlug);

    try {
      await telegram.sendLoaded(vendor, entry.invoice, entry.allocations);
    } catch (err) {
      console.error('Telegram loaded notification failed:', err.message);
    }

    res.json({ success: true, invoice: entry.invoice });
  } catch (err) {
    console.error('Trigger load error:', err);
    res.status(500).json({ error: 'Failed to trigger load' });
  }
});

module.exports = router;
