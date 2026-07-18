const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

async function main() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs
    FROM "_prisma_migrations"
    ORDER BY started_at
  `);
  console.log(JSON.stringify(rows, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
