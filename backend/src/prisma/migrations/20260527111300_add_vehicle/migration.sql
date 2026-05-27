-- AlterTable
ALTER TABLE "Ride" 
ADD COLUMN "vehicleType" TEXT NOT NULL DEFAULT 'CAR',
ADD COLUMN "vehicleCapacity" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "fuelType" TEXT NOT NULL DEFAULT 'Petrol',
ADD COLUMN "vehicleNumber" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "RideRequest" 
ADD COLUMN "fareCents" INTEGER NOT NULL DEFAULT 1000;

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "fuelType" TEXT NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_userId_key" ON "Vehicle"("userId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
