const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Graceful shutdown — let Postgres connections close cleanly on systemd stop
// instead of dangling until the pool timeout. Only register once.
let shutdownRegistered = false;
function registerShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      try { await prisma.$disconnect(); } catch (_) {}
      process.exit(0);
    });
  }
}
registerShutdown();

module.exports = prisma;
