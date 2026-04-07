const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedAdmin() {
  const username = process.argv[2] || 'admin';
  const password = process.argv[3];

  if (!password) {
    console.error('Usage: node src/db/seed-admin.js <username> <password>');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  await prisma.adminUser.upsert({
    where: { username },
    update: { passwordHash: hash },
    create: { username, passwordHash: hash },
  });

  console.log(`Admin user "${username}" created/updated.`);
}

seedAdmin()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
