const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const MIGRATIONS = [
  '20260523000000_init',
  '20260527111300_add_vehicle',
  '20260527173000_add_verification_code',
  '20260530000000_add_gender_to_user',
  '20260530100000_add_missing_columns',
  '20260604094718_add_fcm_token_and_chat_status',
  '20260613232424_add_buddy_requests',
  '20260616164634_add_seats_to_ride_request',
  '20260619173629_remove_marketplace',
  '20260620092900_add_society_workplace_bio',
  '20260625193100_add_saved_places',
  '20260701141000_add_buddy_request_type',
  '20260711173500_add_started_completed_statuses_and_request_fields',
  '20260713000000_add_invitation_columns',
];

async function main() {
  // Step 1: Wipe the entire table
  const deleted = await prisma.$executeRawUnsafe(`DELETE FROM "_prisma_migrations"`);
  console.log(`Step 1: Deleted ${deleted} rows from _prisma_migrations`);

  // Step 2: Verify it's empty
  const check = await prisma.$queryRawUnsafe(`SELECT count(*)::int as cnt FROM "_prisma_migrations"`);
  console.log(`Step 2: Table now has ${check[0].cnt} rows`);

  // Step 3: Insert all 14 as cleanly applied
  for (const name of MIGRATIONS) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs, rolled_back_at)
      VALUES (gen_random_uuid()::text, '', '${name}', NOW(), NOW(), 1, NULL, NULL)
    `);
    console.log(`  ✓ Inserted: ${name}`);
  }

  // Step 4: Final verification
  const rows = await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at IS NOT NULL as is_finished, logs IS NULL as logs_clean
    FROM "_prisma_migrations" ORDER BY started_at
  `);
  console.log('\nStep 4: Final state:');
  for (const r of rows) {
    console.log(`  ${r.is_finished && r.logs_clean ? '✓' : '✗'} ${r.migration_name}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
