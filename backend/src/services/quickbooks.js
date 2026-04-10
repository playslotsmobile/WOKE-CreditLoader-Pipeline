const prisma = require('../db/client');
const { logger } = require('./logger');

let accessToken = null;
let tokenExpiry = 0;

async function getRefreshToken() {
  // Try DB first, fall back to .env
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'qb_refresh_token' } });
    if (setting) return setting.value;
  } catch {
    // Table may not exist yet during migration
  }
  return process.env.QB_REFRESH_TOKEN;
}

async function saveRefreshToken(token) {
  process.env.QB_REFRESH_TOKEN = token;
  try {
    await prisma.setting.upsert({
      where: { key: 'qb_refresh_token' },
      update: { value: token },
      create: { key: 'qb_refresh_token', value: token },
    });
    logger.info('QB refresh token saved to DB');
  } catch (err) {
    logger.error('Failed to save refresh token to DB', { error: err });
  }
}

async function refreshAccessToken() {
  const refreshToken = await getRefreshToken();
  const auth = Buffer.from(
    process.env.QB_CLIENT_ID + ':' + process.env.QB_CLIENT_SECRET
  ).toString('base64');

  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + auth,
    },
    body: 'grant_type=refresh_token&refresh_token=' + refreshToken,
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('QB token refresh failed: ' + JSON.stringify(data));
  }

  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

  if (data.refresh_token) {
    await saveRefreshToken(data.refresh_token);
  }

  return accessToken;
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) {
    return accessToken;
  }
  return refreshAccessToken();
}

async function qbRequest(method, endpoint, body) {
  const token = await getAccessToken();
  const realmId = process.env.QB_REALM_ID;
  const baseUrl =
    process.env.QB_ENVIRONMENT === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';

  const url = `${baseUrl}/v3/company/${realmId}/${endpoint}`;

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QB API ${method} ${endpoint} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

async function findCustomer(displayName) {
  const encoded = displayName.replace(/'/g, "\\'");
  const data = await qbRequest(
    'GET',
    `query?query=SELECT * FROM Customer WHERE DisplayName = '${encoded}'`
  );
  const customers = data.QueryResponse?.Customer;
  if (!customers || customers.length === 0) {
    throw new Error(`QB customer not found: ${displayName}`);
  }
  return customers[0];
}

async function createInvoice(vendor, invoice, allocations) {
  const customer = await findCustomer(vendor.qbCustomerName);

  const lineItems = allocations
    .filter((a) => a.dollarAmount > 0)
    .map((a, i) => {
      const platform = a.platform === 'PLAY777' ? '777' : 'IConnect';
      const id = a.operatorId ? ` (${a.operatorId})` : '';
      const label = `${platform} ${a.username}${id} - ${a.credits.toLocaleString()} credits`;
      return {
        LineNum: i + 1,
        Amount: a.dollarAmount,
        DetailType: 'SalesItemLineDetail',
        Description: label,
        SalesItemLineDetail: {
          Qty: 1,
          UnitPrice: a.dollarAmount,
        },
      };
    });

  if (invoice.feeAmount > 0) {
    lineItems.push({
      LineNum: lineItems.length + 1,
      Amount: invoice.feeAmount,
      DetailType: 'SalesItemLineDetail',
      Description: `Processing fee (${invoice.method})`,
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: invoice.feeAmount,
      },
    });
  }

  const invoiceData = {
    CustomerRef: { value: customer.Id },
    Line: lineItems,
    BillEmail: { Address: vendor.email },
    EmailStatus: 'NeedToSend',
  };

  if (invoice.method === 'Credit/Debit (3%)') {
    invoiceData.AllowOnlineCreditCardPayment = true;
    invoiceData.AllowOnlineACHPayment = false;
  } else if (invoice.method === 'ACH (1%)') {
    invoiceData.AllowOnlineCreditCardPayment = false;
    invoiceData.AllowOnlineACHPayment = true;
  } else if (invoice.method === 'PayPal (3%)') {
    invoiceData.AllowOnlineCreditCardPayment = false;
    invoiceData.AllowOnlineACHPayment = false;
    invoiceData.AllowOnlinePayPalPayment = true;
  }

  const result = await qbRequest('POST', 'invoice', invoiceData);
  const createdInvoice = result.Invoice;

  // Explicitly send the invoice email
  try {
    await sendInvoiceEmail(createdInvoice.Id, vendor.email);
    logger.info('QB invoice email sent', { invoiceId: createdInvoice.Id, email: vendor.email });
  } catch (err) {
    logger.error('QB failed to send invoice email', { invoiceId: createdInvoice.Id, error: err });
  }

  return createdInvoice;
}

async function sendInvoiceEmail(invoiceId, email) {
  const token = await getAccessToken();
  const realmId = process.env.QB_REALM_ID;
  const baseUrl =
    process.env.QB_ENVIRONMENT === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';

  const url = `${baseUrl}/v3/company/${realmId}/invoice/${invoiceId}/send?sendTo=${encodeURIComponent(email)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QB send invoice failed: ${res.status} - ${text}`);
  }

  return res.json();
}

async function getInvoice(invoiceId) {
  const data = await qbRequest('GET', `invoice/${invoiceId}`);
  return data.Invoice;
}

async function getPayment(paymentId) {
  const data = await qbRequest('GET', `payment/${paymentId}`);
  return data.Payment;
}

module.exports = {
  findCustomer,
  createInvoice,
  sendInvoiceEmail,
  getInvoice,
  getPayment,
  qbRequest,
};
