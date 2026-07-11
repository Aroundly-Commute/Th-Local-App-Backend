-- AlterEnum
ALTER TYPE "RideStatus" ADD VALUE 'STARTED';
ALTER TYPE "RideStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "RideRequest" ADD COLUMN     "otp" TEXT,
ADD COLUMN     "actualFare" DOUBLE PRECISION,
ADD COLUMN     "riderShare" DOUBLE PRECISION,
ADD COLUMN     "driverShare" DOUBLE PRECISION,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3);
