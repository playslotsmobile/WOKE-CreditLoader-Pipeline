const express = require('express');
const router = express.Router();
const quickbooks = require('../services/quickbooks');
const telegram = require('../services/telegram');

// In-memory store until DB is live
const invoices = [];
let nextInvoiceId = 1;

router.post('/submit-invoice', async (req, res) => {
  try {
    const { vendorSlug, method, baseAmount, feeAmount, totalAmount, allocations } = req.body;

    // Find vendor from the in-memory list
    const vendors = req.app.get('vendors');
    const vendor = vendors.find((v) => v.slug === vendorSlug);
    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    const isWire = method === 'Wire';

    // Build invoice record
    const invoice = {
      id: nextInvoiceId++,
      vendorSlug,
      qbInvoiceId: null,
      method: isWire ? 'Wire' : method === 'ACH' ? 'ACH (1%)' : 'Credit/Debit (3%)',
      baseAmount,
      feeAmount,
      totalAmount,
      status: isWire ? 'PENDING' : 'REQUESTED',
      submittedAt: new Date().toISOString(),
      paidAt: null,
      loadedAt: null,
    };

    // Enrich allocations with account info
    const enrichedAllocations = allocations.map((a) => {
      const acct = vendor.accounts.find((acc) => acc.id === a.accountId);
      return { ...a, ...acct };
    });

    if (isWire) {
      invoices.push({ invoice, allocations: enrichedAllocations });
      try {
        await telegram.sendWireSubmitted(vendor, invoice, enrichedAllocations);
      } catch (err) {
        console.error('Telegram wire notification failed:', err.message);
      }
    } else {
      try {
        const qbInvoice = await quickbooks.createInvoice(vendor, invoice, enrichedAllocations);
        invoice.qbInvoiceId = qbInvoice.DocNumber || qbInvoice.Id;
        invoice.status = 'REQUESTED';
      } catch (err) {
        console.error('QB invoice creation failed:', err.message);
        invoice.qbInvoiceId = 'QB-PENDING';
      }

      invoices.push({ invoice, allocations: enrichedAllocations });
      try {
        await telegram.sendInvoiceSent(vendor, invoice, enrichedAllocations);
      } catch (err) {
        console.error('Telegram invoice notification failed:', err.message);
      }
    }

    console.log('Invoice saved:', invoice);
    res.json({ success: true, invoiceId: invoice.id, qbInvoiceId: invoice.qbInvoiceId });
  } catch (err) {
    console.error('Submit invoice error:', err);
    res.status(500).json({ error: 'Failed to submit invoice' });
  }
});

// Get all invoices (for admin dashboard)
router.get('/invoices', (req, res) => {
  res.json(invoices);
});

module.exports = router;
module.exports.invoices = invoices;
