const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../db/client');
const { logger } = require('../services/logger');

const log = logger.child({ service: 'webhooks' });

function verifySignature(payload, signature) {
  const webhookToken = process.env.QB_WEBHOOK_TOKEN;
  if (!webhookToken) {
    log.warn('QB_WEBHOOK_TOKEN not set — rejecting webhook');
    return false;
  }
  if (!signature || typeof signature !== 'string') return false;
  const hash = crypto
    .createHmac('sha256', webhookToken)
    .update(payload)
    .digest('base64');
  // Timing-safe compare; lengths must match for timingSafeEqual
  const a = Buffer.from(hash);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post('/qb-webhook', async (req, res) => {
  const signature = req.headers['intuit-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!verifySignature(rawBody, signature)) {
    log.error('QB webhook: invalid or missing signature');
    return res.status(401).send('Invalid signature');
  }

  try {
    await prisma.webhookEvent.create({
      data: {
        source: 'quickbooks',
        eventType: 'payment',
        payload: req.body,
        status: 'RECEIVED',
      },
    });
    log.info('QB webhook queued for processing');
  } catch (err) {
    log.error('Failed to queue webhook event', { error: err });
  }

  res.status(200).send('OK');
});

module.exports = router;
