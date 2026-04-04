const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const vendors = [
  {
    slug: 'mike', name: 'Mike Perez', businessName: 'OSL DEVELOPMENT LLC',
    email: 'Manichos917218@gmail.com', qbCustomerId: 'OSL DEVELOPMENT LLC', telegramChatId: '-1002377413893',
    accounts: [
      { platform: 'PLAY777', username: 'M12345', operatorId: '1112', rate: 0.37 },
      { platform: 'ICONNECT', username: 'Mikee', operatorId: null, rate: 0.15 },
    ],
  },
  {
    slug: 'claudia', name: 'Claudia Cardenas', businessName: 'JCSOFTWARE',
    email: 'jcsoftware@jcsoftware50.com', qbCustomerId: 'JCSOFTWARE', telegramChatId: '-1002307445932',
    accounts: [
      { platform: 'PLAY777', username: 'MM123456', operatorId: '1113', rate: 0.35 },
      { platform: 'PLAY777', username: 'BIGBOSS', operatorId: '2152', rate: 0.35 },
      { platform: 'ICONNECT', username: 'Andrea1979', operatorId: null, rate: 0.15 },
    ],
  },
  {
    slug: 'karla', name: 'Karla Rivera', businessName: 'LFM SOFTWARE LLC',
    email: 'zadhay11@gmail.com', qbCustomerId: 'LFM SOFTWARE LLC', telegramChatId: '-1002466441180',
    accounts: [
      { platform: 'PLAY777', username: 'KAR123', operatorId: '1123', rate: 0.35 },
      { platform: 'ICONNECT', username: 'K1234', operatorId: null, rate: 0.15 },
    ],
  },
  {
    slug: 'jose', name: 'Jose Gracia', businessName: 'Jose Gracia',
    email: 'claudiahgracia@yahoo.com', qbCustomerId: 'Jose Gracia', telegramChatId: '-4992937914',
    accounts: [
      { platform: 'PLAY777', username: 'LOZANO777', operatorId: '2982', rate: 0.30 },
    ],
  },
  {
    slug: 'venisa', name: 'Venisa Vasquez', businessName: 'Venisa Vasquez',
    email: 'yamevi@icloud.com', qbCustomerId: 'Venisa Vasquez', telegramChatId: '-1002950271408',
    accounts: [
      { platform: 'PLAY777', username: 'VENISA', operatorId: '2152', rate: 0.40 },
    ],
  },
  {
    slug: 'alex', name: 'Alex Noz', businessName: 'GREAT RED SOLUTIONS LLC',
    email: 'Greatredsolutions@yahoo.com', qbCustomerId: 'GREAT RED SOLUTIONS LLC', telegramChatId: '-1002493846687',
    accounts: [
      { platform: 'PLAY777', username: 'TEAM1115', operatorId: '1115', rate: 0.35 },
    ],
  },
  {
    slug: 'luis', name: 'Luis Salinas', businessName: 'SaraLeasing LLC',
    email: 'only@cashemotional.com', qbCustomerId: 'SaraLeasing LLC', telegramChatId: '-1002341071126',
    accounts: [
      { platform: 'PLAY777', username: 'LUISVENDOR', operatorId: '1476', rate: 0.40 },
    ],
  },
  {
    slug: 'yuli', name: 'Yuli', businessName: 'KKS SOFTWARE LLC',
    email: 'marioasalinas91@gmail.com', qbCustomerId: 'KKS SOFTWARE LLC', telegramChatId: '-1002317047594',
    accounts: [
      { platform: 'PLAY777', username: 'MARIA1234', operatorId: '1366', rate: 0.40 },
      { platform: 'ICONNECT', username: 'ALE1234', operatorId: null, rate: 0.30 },
    ],
  },
  {
    slug: 'gilberto', name: 'Gilberto Rivera', businessName: 'GRR SOFTWARE LLC',
    email: 'wilowhat956@gmail.com', qbCustomerId: 'GRR SOFTWARE LLC', telegramChatId: '-1002463060426',
    accounts: [
      { platform: 'PLAY777', username: 'PUPS11', operatorId: '1319', rate: 0.35 },
      { platform: 'ICONNECT', username: 'DONBELDE1', operatorId: null, rate: 0.15 },
    ],
  },
  {
    slug: 'lynette', name: 'Lynette', businessName: 'AC DRIP LLC',
    email: 'Arturo.castro202@gmail.com', qbCustomerId: 'AC DRIP LLC', telegramChatId: '-1002269930759',
    accounts: [
      { platform: 'PLAY777', username: 'LYN1234', operatorId: '1117', rate: 0.40 },
    ],
  },
  {
    slug: 'lorena', name: 'Lorena Delgado', businessName: 'DELGADO INNOVATIONS LLC',
    email: 'Lorenadel85@gmail.com', qbCustomerId: 'DELGADO INNOVATIONS LLC', telegramChatId: '-1002396670550',
    accounts: [
      { platform: 'PLAY777', username: 'Vendor', operatorId: '1127', rate: 0.35 },
    ],
  },
  {
    slug: 'leo', name: 'Leo', businessName: 'GS SOFTWARE LLC',
    email: 'gutierrezleo95@gmail.com', qbCustomerId: 'GS SOFTWARE LLC', telegramChatId: '-1002247705198',
    accounts: [
      { platform: 'PLAY777', username: 'MASC11', operatorId: '956', rate: 0.50 },
    ],
  },
  {
    slug: 'cody', name: 'Cody Trejo', businessName: 'Cody Trejo',
    email: 'cody.trejo@yahoo.com', qbCustomerId: 'Cody Trejo', telegramChatId: '-5109734233',
    accounts: [
      { platform: 'PLAY777', username: 'LTORRES1979', operatorId: '1288', rate: 0.40 },
      { platform: 'PLAY777', username: 'CTREJO', operatorId: '1868', rate: 0.50 },
    ],
  },
  {
    slug: 'cesar', name: 'Cesar Rivera', businessName: 'CGR SOFTWARE LLC',
    email: 'Cesargrivera93@gmail.com', qbCustomerId: 'CGR SOFTWARE LLC', telegramChatId: '-1002201282882',
    accounts: [
      { platform: 'PLAY777', username: 'CR1234', operatorId: '1114', rate: 0.35 },
      { platform: 'PLAY777', username: 'DSILVA777', operatorId: '1337', rate: 0.35 },
      { platform: 'PLAY777', username: 'CINDY123', operatorId: '1414', rate: 0.35 },
      { platform: 'PLAY777', username: 'LTORRES1979', operatorId: '1288', rate: 0.40 },
      { platform: 'PLAY777', username: 'LTREJO69', operatorId: '798', rate: 0.35 },
      { platform: 'ICONNECT', username: 'LTREJO79', operatorId: null, rate: 0.30 },
    ],
  },
];

async function seed() {
  console.log('Seeding database...');

  for (const v of vendors) {
    const vendor = await prisma.vendor.upsert({
      where: { slug: v.slug },
      update: {
        name: v.name,
        businessName: v.businessName,
        email: v.email,
        qbCustomerId: v.qbCustomerId,
        telegramChatId: v.telegramChatId,
      },
      create: {
        slug: v.slug,
        name: v.name,
        businessName: v.businessName,
        email: v.email,
        qbCustomerId: v.qbCustomerId,
        telegramChatId: v.telegramChatId,
      },
    });

    // Delete existing accounts and recreate
    await prisma.vendorAccount.deleteMany({ where: { vendorId: vendor.id } });

    for (const a of v.accounts) {
      await prisma.vendorAccount.create({
        data: {
          vendorId: vendor.id,
          platform: a.platform,
          username: a.username,
          operatorId: a.operatorId,
          rate: a.rate,
        },
      });
    }

    console.log(`  ✓ ${v.name} (${v.accounts.length} accounts)`);
  }

  console.log('Seed complete.');
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
