-- AlterTable
ALTER TABLE "BuddyRequest" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'buddy';
