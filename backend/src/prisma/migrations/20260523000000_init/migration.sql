-- Baseline migration: applied once to a fresh Supabase database.
-- For existing databases, this migration is marked as already applied via
-- prisma migrate resolve --applied 20260523000000_init

-- Enable PostGIS (Supabase has it pre-installed; this is idempotent)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Enums
CREATE TYPE "RideStatus" AS ENUM ('OPEN', 'REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'SHIPPED', 'DELIVERED', 'CANCELLED');
CREATE TYPE "ParkingSlotType" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY');
CREATE TYPE "BookingStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- User
CREATE TABLE IF NOT EXISTS "User" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "email"        TEXT UNIQUE,
    "name"         TEXT NOT NULL,
    "firebaseUid"  TEXT NOT NULL UNIQUE,
    "phoneNumber"  TEXT UNIQUE,
    "profilePic"   TEXT,
    "passwordHash" TEXT,
    "role"         TEXT NOT NULL DEFAULT 'passenger',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- Ride
CREATE TABLE IF NOT EXISTS "Ride" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "driverId"       TEXT NOT NULL,
    "seatsAvailable" INT NOT NULL DEFAULT 1,
    "chargeCents"    INT NOT NULL,
    "startTime"      TIMESTAMP(3) NOT NULL,
    "endTime"        TIMESTAMP(3) NOT NULL,
    "startPlaceName" TEXT NOT NULL,
    "endPlaceName"   TEXT NOT NULL,
    "startPoint"     geometry(Point,4326),
    "endPoint"       geometry(Point,4326),
    "routeLine"      geometry(LineString,4326),
    "status"         "RideStatus" NOT NULL DEFAULT 'OPEN',
    CONSTRAINT "Ride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ride_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "Ride_startTime_idx" ON "Ride"("startTime");
CREATE INDEX IF NOT EXISTS "Ride_endTime_idx" ON "Ride"("endTime");

-- RideRequest
CREATE TABLE IF NOT EXISTS "RideRequest" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "rideId"         TEXT NOT NULL,
    "riderId"        TEXT NOT NULL,
    "riderStartName" TEXT NOT NULL,
    "riderEndName"   TEXT NOT NULL,
    "riderStartTime" TIMESTAMP(3) NOT NULL,
    "riderStart"     geometry(Point,4326),
    "riderEnd"       geometry(Point,4326),
    "status"         "RideStatus" NOT NULL DEFAULT 'REQUESTED',
    CONSTRAINT "RideRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RideRequest_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE,
    CONSTRAINT "RideRequest_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "RideRequest_rideId_idx" ON "RideRequest"("rideId");

-- Message
CREATE TABLE IF NOT EXISTS "Message" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "chatId"    TEXT NOT NULL,
    "text"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "senderId"  TEXT NOT NULL,
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "Message_chatId_idx" ON "Message"("chatId");

-- Shop
CREATE TABLE IF NOT EXISTS "Shop" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "ownerId"     TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Shop_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT
);

-- Product
CREATE TABLE IF NOT EXISTS "Product" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "imageUrl"    TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- ShopProduct
CREATE TABLE IF NOT EXISTS "ShopProduct" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "shopId"    TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price"     DOUBLE PRECISION NOT NULL,
    "stock"     INT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopProduct_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShopProduct_shopId_productId_key" UNIQUE ("shopId", "productId"),
    CONSTRAINT "ShopProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT,
    CONSTRAINT "ShopProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT
);

-- Cart
CREATE TABLE IF NOT EXISTS "Cart" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Cart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT
);

-- CartItem
CREATE TABLE IF NOT EXISTS "CartItem" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "cartId"        TEXT NOT NULL,
    "shopProductId" TEXT NOT NULL,
    "quantity"      INT NOT NULL DEFAULT 1,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CartItem_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE RESTRICT,
    CONSTRAINT "CartItem_shopProductId_fkey" FOREIGN KEY ("shopProductId") REFERENCES "ShopProduct"("id") ON DELETE RESTRICT
);

-- Order
CREATE TABLE IF NOT EXISTS "Order" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"      TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status"      "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT
);

-- OrderItem
CREATE TABLE IF NOT EXISTS "OrderItem" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "orderId"       TEXT NOT NULL,
    "shopProductId" TEXT NOT NULL,
    "quantity"      INT NOT NULL,
    "priceAtTime"   DOUBLE PRECISION NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT,
    CONSTRAINT "OrderItem_shopProductId_fkey" FOREIGN KEY ("shopProductId") REFERENCES "ShopProduct"("id") ON DELETE RESTRICT
);

-- ServiceProvider
CREATE TABLE IF NOT EXISTS "ServiceProvider" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "ownerId"     TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "services"    TEXT,
    "rating"      DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "ratingCount" INT NOT NULL DEFAULT 1,
    "dist"        TEXT DEFAULT '0.5 km',
    "emoji"       TEXT DEFAULT '🛠️',
    "bg"          TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceProvider_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ServiceProvider_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT
);

-- Service
CREATE TABLE IF NOT EXISTS "Service" (
    "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "providerId"  TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "price"       DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "rating"      DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "emoji"       TEXT DEFAULT '🛠️',
    "category"    TEXT NOT NULL,
    "bg"          TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Service_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Service_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ServiceProvider"("id") ON DELETE RESTRICT
);

-- Booking
CREATE TABLE IF NOT EXISTS "Booking" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"    TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "timeSlot"  TEXT NOT NULL,
    "date"      TEXT NOT NULL DEFAULT 'Today',
    "status"    TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT,
    CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT
);

-- Follow
CREATE TABLE IF NOT EXISTS "Follow" (
    "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId"     TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Follow_userId_businessId_key" UNIQUE ("userId", "businessId"),
    CONSTRAINT "Follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT
);

-- ParkingSpot
CREATE TABLE IF NOT EXISTS "ParkingSpot" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "spotName"  TEXT NOT NULL UNIQUE,
    "level"     INT NOT NULL,
    "section"   TEXT NOT NULL,
    "row"       INT NOT NULL,
    "col"       INT NOT NULL,
    "ownerId"   TEXT,
    "approved"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ParkingSpot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ParkingSpot_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL
);

-- ParkingAvailability
CREATE TABLE IF NOT EXISTS "ParkingAvailability" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "spotId"    TEXT NOT NULL,
    "date"      TEXT NOT NULL,
    "slotType"  "ParkingSlotType" NOT NULL DEFAULT 'HOURLY',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime"   TIMESTAMP(3) NOT NULL,
    "price"     DOUBLE PRECISION NOT NULL,
    "isBooked"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ParkingAvailability_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ParkingAvailability_spotId_fkey" FOREIGN KEY ("spotId") REFERENCES "ParkingSpot"("id") ON DELETE CASCADE
);

-- ParkingBooking
CREATE TABLE IF NOT EXISTS "ParkingBooking" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "spotId"         TEXT NOT NULL,
    "availabilityId" TEXT,
    "userId"         TEXT NOT NULL,
    "date"           TEXT NOT NULL,
    "slotType"       "ParkingSlotType" NOT NULL,
    "startTime"      TIMESTAMP(3) NOT NULL,
    "endTime"        TIMESTAMP(3) NOT NULL,
    "price"          DOUBLE PRECISION NOT NULL,
    "status"         "BookingStatus" NOT NULL DEFAULT 'REQUESTED',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ParkingBooking_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ParkingBooking_spotId_fkey" FOREIGN KEY ("spotId") REFERENCES "ParkingSpot"("id") ON DELETE CASCADE,
    CONSTRAINT "ParkingBooking_availabilityId_fkey" FOREIGN KEY ("availabilityId") REFERENCES "ParkingAvailability"("id") ON DELETE SET NULL,
    CONSTRAINT "ParkingBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);
