const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

async function main() {
  const migrationsDir = path.join(__dirname, 'src', 'prisma', 'migrations');
  const migrationFolders = fs.readdirSync(migrationsDir)
    .filter(f => fs.statSync(path.join(migrationsDir, f)).isDirectory())
    .sort();

  console.log(`Found ${migrationFolders.length} migrations in filesystem:`);
  migrationFolders.forEach(m => console.log(`  - ${m}`));

  // Step 1: Wipe the entire _prisma_migrations table
  const deleted = await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations"`);
  console.log(`\nStep 1: Deleted ${deleted} old/failed rows from _prisma_migrations`);

  // Step 2: Insert all migrations as cleanly applied
  console.log('\nStep 2: Inserting migrations as cleanly applied...');
  for (const name of migrationFolders) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs, rolled_back_at)
      VALUES (gen_random_uuid()::text, '', '${name}', NOW(), NOW(), 1, NULL, NULL)
    `);
    console.log(`  ✓ Marked applied: ${name}`);
  }

  // Step 3: Verify final state
  const rows = await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at IS NOT NULL as is_finished, logs IS NULL as logs_clean
    FROM "_prisma_migrations" ORDER BY started_at
  `);
  console.log(`\nStep 3: Final state (${rows.length} recorded migrations):`);
  for (const r of rows) {
    console.log(`  ${r.is_finished && r.logs_clean ? '✓' : '✗'} ${r.migration_name}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
