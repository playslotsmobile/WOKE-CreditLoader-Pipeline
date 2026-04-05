const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '..', '.env');
let accessToken = null;
let tokenExpiry = 0;

async function refreshAccessToken() {
  const auth = Buffer.from(
    process.env.QB_CLIENT_ID + ':' + process.env.QB_CLIENT_SECRET
  ).toString('base64');

  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + auth,
    },
    body: 'grant_type=refresh_token&refresh_token=' + process.env.QB_REFRESH_TOKEN,
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('QB token refresh failed: ' + JSON.stringify(data));
  }

  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

  // Save new refresh token
  if (data.refresh_token) {
    try {
      let env = fs.readFileSync(envPath, 'utf8');
      env = env.replace(/QB_REFRESH_TOKEN=.*/, `QB_REFRESH_TOKEN=${data.refresh_token}`);
      fs.writeFileSync(envPath, env);
      process.env.QB_REFRESH_TOKEN = data.refresh_token;
      console.log('QB refresh token saved.');
    } catch (err) {
      console.error('Failed to save refresh token:', err.message);
    }
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
  }

  const result = await qbRequest('POST', 'invoice', invoiceData);
  return result.Invoice;
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
  getInvoice,
  getPayment,
};
