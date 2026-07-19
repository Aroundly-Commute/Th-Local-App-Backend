-- CreateTable
CREATE TABLE IF NOT EXISTS "RecurringRideSchedule" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "driverId" TEXT NOT NULL,
    "seatsAvailable" INTEGER NOT NULL DEFAULT 1,
    "chargeCents" INTEGER NOT NULL,
    "daysOfWeek" INTEGER[],
    "timeOfDay" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "startPlaceName" TEXT NOT NULL,
    "endPlaceName" TEXT NOT NULL,
    "startPoint" geometry(Point,4326),
    "endPoint" geometry(Point,4326),
    "routeLine" geometry(LineString,4326),
    "vehicleType" TEXT NOT NULL DEFAULT 'CAR',
    "vehicleCapacity" INTEGER NOT NULL DEFAULT 5,
    "fuelType" TEXT NOT NULL DEFAULT 'Petrol',
    "vehicleNumber" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RecurringRideSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RecurringRideSchedule_driverId_idx" ON "RecurringRideSchedule"("driverId");

-- AddForeignKey
ALTER TABLE "RecurringRideSchedule" DROP CONSTRAINT IF EXISTS "RecurringRideSchedule_driverId_fkey";
ALTER TABLE "RecurringRideSchedule" ADD CONSTRAINT "RecurringRideSchedule_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
