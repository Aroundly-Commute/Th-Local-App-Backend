-- Add missing enum value
ALTER TYPE "RideStatus" ADD VALUE IF NOT EXISTS 'WITHDRAWN';

-- Add missing column to Ride
ALTER TABLE "Ride"
  ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'OFFERED';

-- Add missing columns to RideRequest
ALTER TABLE "RideRequest"
  ADD COLUMN IF NOT EXISTS "requesterRideId" TEXT,
  ADD COLUMN IF NOT EXISTS "otpVerified" BOOLEAN NOT NULL DEFAULT false;

-- Add missing columns to User
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "corporateEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "isVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "rating" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- Add unique constraint on User.corporateEmail
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_corporateEmail_key'
  ) THEN
    -- Drop the index if it exists to avoid relation collision when creating the constraint
    DROP INDEX IF EXISTS "User_corporateEmail_key";
    ALTER TABLE "User" ADD CONSTRAINT "User_corporateEmail_key" UNIQUE ("corporateEmail");
  END IF;
END $$;

-- Create EmailVerificationCode table
CREATE TABLE IF NOT EXISTS "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- Create Review table
CREATE TABLE IF NOT EXISTS "Review" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "rideId" TEXT,
    "rating" DOUBLE PRECISION NOT NULL,
    "comment" TEXT,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- Add unique constraint on Review
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Review_fromUserId_toUserId_rideId_key'
  ) THEN
    -- Drop the index if it exists to avoid relation collision when creating the constraint
    DROP INDEX IF EXISTS "Review_fromUserId_toUserId_rideId_key";
    ALTER TABLE "Review" ADD CONSTRAINT "Review_fromUserId_toUserId_rideId_key" UNIQUE ("fromUserId", "toUserId", "rideId");
  END IF;
END $$;

-- Add foreign keys
DO $$
BEGIN
  -- RideRequest.requesterRideId -> Ride
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RideRequest_requesterRideId_fkey'
  ) THEN
    ALTER TABLE "RideRequest" ADD CONSTRAINT "RideRequest_requesterRideId_fkey"
      FOREIGN KEY ("requesterRideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Review.fromUserId -> User
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Review_fromUserId_fkey'
  ) THEN
    ALTER TABLE "Review" ADD CONSTRAINT "Review_fromUserId_fkey"
      FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- Review.toUserId -> User
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Review_toUserId_fkey'
  ) THEN
    ALTER TABLE "Review" ADD CONSTRAINT "Review_toUserId_fkey"
      FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Add missing indexes
CREATE INDEX IF NOT EXISTS "Ride_driverId_idx" ON "Ride"("driverId");
CREATE INDEX IF NOT EXISTS "Ride_status_idx" ON "Ride"("status");
CREATE INDEX IF NOT EXISTS "RideRequest_requesterRideId_idx" ON "RideRequest"("requesterRideId");
CREATE INDEX IF NOT EXISTS "RideRequest_riderId_idx" ON "RideRequest"("riderId");
CREATE INDEX IF NOT EXISTS "EmailVerificationCode_email_idx" ON "EmailVerificationCode"("email");
