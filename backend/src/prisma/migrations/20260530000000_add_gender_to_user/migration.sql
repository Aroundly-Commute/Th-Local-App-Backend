-- AlterTable: Add gender column to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gender" TEXT;
