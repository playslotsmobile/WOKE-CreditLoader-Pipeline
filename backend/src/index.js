const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const formRoutes = require('./routes/forms');
const webhookRoutes = require('./routes/webhooks');

const app = express();
app.use(cors());
app.use(express.json());

// ── Vendor data (placeholder until DB is live) ──
const vendors = [
  {
    id: 1,
    slug: 'mike',
    name: 'Mike Perez',
    businessName: 'OSL DEVELOPMENT LLC',
    email: 'Manichos917218@gmail.com',
    qbCustomerName: 'OSL DEVELOPMENT LLC',
    telegramChatId: '-1002377413893',
    accounts: [
      { id: 1, platform: 'PLAY777', username: 'M12345', operatorId: '1112', rate: '0.37', loadType: 'vendor' },
      { id: 2, platform: 'ICONNECT', username: 'Mikee', operatorId: null, rate: '0.15', loadType: 'vendor' },
    ],
  },
  {
    id: 2,
    slug: 'claudia',
    name: 'Claudia Cardenas',
    businessName: 'JCSOFTWARE',
    email: 'jcsoftware@jcsoftware50.com',
    qbCustomerName: 'JCSOFTWARE',
    telegramChatId: '-1002307445932',
    accounts: [
      { id: 3, platform: 'PLAY777', username: 'MM123456', operatorId: '1113', rate: '0.35', loadType: 'vendor' },
      { id: 4, platform: 'PLAY777', username: 'BIGBOSS', operatorId: '2152', rate: '0.35', loadType: 'vendor' },
      { id: 5, platform: 'ICONNECT', username: 'Andrea1979', operatorId: null, rate: '0.15', loadType: 'vendor' },
    ],
  },
  {
    id: 3,
    slug: 'karla',
    name: 'Karla Rivera',
    businessName: 'LFM SOFTWARE LLC',
    email: 'zadhay11@gmail.com',
    qbCustomerName: 'LFM SOFTWARE LLC',
    telegramChatId: '-1002466441180',
    accounts: [
      { id: 6, platform: 'PLAY777', username: 'KAR123', operatorId: '1123', rate: '0.35', loadType: 'vendor' },
      { id: 7, platform: 'ICONNECT', username: 'K1234', operatorId: null, rate: '0.15', loadType: 'vendor' },
    ],
  },
  {
    id: 4,
    slug: 'jose',
    name: 'Jose Gracia',
    businessName: 'Jose Gracia',
    email: 'claudiahgracia@yahoo.com',
    qbCustomerName: 'Jose Gracia',
    telegramChatId: '-4992937914',
    accounts: [
      { id: 8, platform: 'PLAY777', username: 'LOZANO777', operatorId: '2982', rate: '0.30', loadType: 'vendor' },
    ],
  },
  {
    id: 5,
    slug: 'venisa',
    name: 'Venisa Vasquez',
    businessName: 'Venisa Vasquez',
    email: 'yamevi@icloud.com',
    qbCustomerName: 'Venisa Vasquez',
    telegramChatId: '-1002950271408',
    accounts: [
      { id: 9, platform: 'PLAY777', username: 'VENISA', operatorId: '2152', rate: '0.40', loadType: 'vendor' },
    ],
  },
  {
    id: 6,
    slug: 'alex',
    name: 'Alex Noz',
    businessName: 'GREAT RED SOLUTIONS LLC',
    email: 'Greatredsolutions@yahoo.com',
    qbCustomerName: 'GREAT RED SOLUTIONS LLC',
    telegramChatId: '-1002493846687',
    accounts: [
      { id: 10, platform: 'PLAY777', username: 'TEAM1115', operatorId: '1115', rate: '0.35', loadType: 'vendor' },
    ],
  },
  {
    id: 7,
    slug: 'luis',
    name: 'Luis Salinas',
    businessName: 'SaraLeasing LLC',
    email: 'only@cashemotional.com',
    qbCustomerName: 'SaraLeasing LLC',
    telegramChatId: '-1002341071126',
    accounts: [
      { id: 11, platform: 'PLAY777', username: 'LUISVENDOR', operatorId: '1476', rate: '0.40', loadType: 'vendor' },
    ],
  },
  {
    id: 8,
    slug: 'yuli',
    name: 'Yuli',
    businessName: 'KKS SOFTWARE LLC',
    email: 'marioasalinas91@gmail.com',
    qbCustomerName: 'KKS SOFTWARE LLC',
    telegramChatId: '-1002317047594',
    accounts: [
      { id: 12, platform: 'PLAY777', username: 'MARIA1234', operatorId: '1366', rate: '0.40', loadType: 'vendor' },
      { id: 13, platform: 'ICONNECT', username: 'ALE1234', operatorId: null, rate: '0.30', loadType: 'vendor' },
    ],
  },
  {
    id: 9,
    slug: 'gilberto',
    name: 'Gilberto Rivera',
    businessName: 'GRR SOFTWARE LLC',
    email: 'wilowhat956@gmail.com',
    qbCustomerName: 'GRR SOFTWARE LLC',
    telegramChatId: '-1002463060426',
    accounts: [
      { id: 14, platform: 'PLAY777', username: 'PUPS11', operatorId: '1319', rate: '0.35', loadType: 'vendor' },
      { id: 15, platform: 'ICONNECT', username: 'DONBELDE1', operatorId: null, rate: '0.15', loadType: 'vendor' },
    ],
  },
  {
    id: 10,
    slug: 'lynette',
    name: 'Lynette',
    businessName: 'AC DRIP LLC',
    email: 'Arturo.castro202@gmail.com',
    qbCustomerName: 'AC DRIP LLC',
    telegramChatId: '-1002269930759',
    accounts: [
      { id: 16, platform: 'PLAY777', username: 'LYN1234', operatorId: '1117', rate: '0.40', loadType: 'vendor' },
    ],
  },
  {
    id: 11,
    slug: 'lorena',
    name: 'Lorena Delgado',
    businessName: 'DELGADO INNOVATIONS LLC',
    email: 'Lorenadel85@gmail.com',
    qbCustomerName: 'DELGADO INNOVATIONS LLC',
    telegramChatId: '-1002396670550',
    accounts: [
      { id: 17, platform: 'PLAY777', username: 'Vendor', operatorId: '1127', rate: '0.35', loadType: 'vendor' },
    ],
  },
  {
    id: 12,
    slug: 'leo',
    name: 'Leo',
    businessName: 'GS SOFTWARE LLC',
    email: 'gutierrezleo95@gmail.com',
    qbCustomerName: 'GS SOFTWARE LLC',
    telegramChatId: '-1002247705198',
    accounts: [
      { id: 18, platform: 'PLAY777', username: 'MASC11', operatorId: '956', rate: '0.50', loadType: 'operator' },
    ],
  },
  {
    id: 13,
    slug: 'cody',
    name: 'Cody Trejo',
    businessName: 'Cody Trejo',
    email: 'cody.trejo@yahoo.com',
    qbCustomerName: 'Cody Trejo',
    telegramChatId: '-5109734233',
    accounts: [
      { id: 19, platform: 'PLAY777', username: 'LTORRES1979', operatorId: '1288', rate: '0.40', loadType: 'vendor' },
      { id: 20, platform: 'PLAY777', username: 'CTREJO', operatorId: '1868', rate: '0.50', loadType: 'operator', parentOperatorId: '1288' },
    ],
  },
  {
    id: 14,
    slug: 'cesar',
    name: 'Cesar Rivera',
    businessName: 'CGR SOFTWARE LLC',
    email: 'Cesargrivera93@gmail.com',
    qbCustomerName: 'CGR SOFTWARE LLC',
    telegramChatId: '-1002201282882',
    accounts: [
      { id: 21, platform: 'PLAY777', username: 'CR1234', operatorId: '1114', rate: '0.35', loadType: 'vendor' },
      { id: 22, platform: 'PLAY777', username: 'DSILVA777', operatorId: '1337', rate: '0.35', loadType: 'vendor' },
      { id: 23, platform: 'PLAY777', username: 'CINDY123', operatorId: '1414', rate: '0.35', loadType: 'vendor' },
      { id: 24, platform: 'PLAY777', username: 'LTORRES1979', operatorId: '1288', rate: '0.40', loadType: 'vendor' },
      { id: 25, platform: 'PLAY777', username: 'LTREJO69', operatorId: '798', rate: '0.35', loadType: 'operator', parentOperatorId: '1288' },
      { id: 26, platform: 'ICONNECT', username: 'LTREJO79', operatorId: null, rate: '0.30', loadType: 'vendor' },
    ],
  },
];

// Make vendors available to routes
app.set('vendors', vendors);

// ── Routes ──
app.get('/api/vendors/:slug', (req, res) => {
  const vendor = vendors.find((v) => v.slug === req.params.slug);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  res.json(vendor);
});

app.use('/api', formRoutes);
app.use('/api', webhookRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
