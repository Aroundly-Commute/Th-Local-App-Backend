-- Show all rows for the init migration
SELECT id, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs
FROM "_prisma_migrations"
WHERE "migration_name" = '20260523000000_init';
