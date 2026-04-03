const express = require('express');
const router = express.Router();
const telegram = require('../services/telegram');

router.post('/qb-webhook', async (req, res) => {
  // QB sends a verification challenge on setup
  if (req.headers['intuit-signature']) {
    // TODO: verify webhook signature with HMAC
  }

  // Respond immediately (QB requires fast response)
  res.status(200).send('OK');

  try {
    const events = req.body?.eventNotifications || [];

    for (const notification of events) {
      const entities = notification?.dataChangeEvent?.entities || [];

      for (const entity of entities) {
        if (entity.name === 'Payment') {
          await handlePayment(entity, req.app);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

async function handlePayment(entity, app) {
  console.log('QB Payment event received:', entity.id);

  // TODO: When DB is live:
  // 1. Look up invoice by QB invoice ID
  // 2. Update status to PAID
  // 3. Trigger auto-loader
  // 4. On load complete, send LOADED messages

  // For now, log the event
  const { invoices } = require('./forms');
  const vendors = app.get('vendors');

  // Find matching invoice (this is a stub — real implementation uses QB API to get payment details)
  // The payment entity has the invoice reference we need to match
  console.log('Payment entity:', JSON.stringify(entity, null, 2));
}

module.exports = router;
