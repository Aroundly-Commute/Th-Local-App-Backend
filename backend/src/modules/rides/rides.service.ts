import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, RideStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lineStringWkt, pointWkt } from '../../common/utils/geo';
import { PublishRideDto } from './dto/publish-ride.dto';
import { ChatService } from '../chat/chat.service';
import { generateDeterministicId } from '../../common/utils/id';

const getDeterministicChatId = (user1: string, user2: string) => {
  const sorted = [user1, user2].sort();
  return `chat_${sorted[0]}_${sorted[1]}`;
};

@Injectable()
export class RidesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
  ) {}

  async publishRide(dto: PublishRideDto, driverId: string) {
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    if (!(startTime instanceof Date) || isNaN(startTime.valueOf())) {
      throw new BadRequestException('Invalid startTime');
    }
    if (!(endTime instanceof Date) || isNaN(endTime.valueOf())) {
      throw new BadRequestException('Invalid endTime');
    }
    if (endTime <= startTime) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const startWkt = pointWkt(dto.start);
    const endWkt = pointWkt(dto.end);
    const routeWkt = lineStringWkt(dto.route);

    const id = generateDeterministicId('ride', [driverId, dto.startPlaceName, dto.endPlaceName, startTime.toISOString()]);

    const overlappingDriverRides = await this.prisma.ride.findFirst({
      where: {
        driverId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
        id: { not: id }
      }
    });

    if (overlappingDriverRides) {
      throw new BadRequestException('You already have a published ride during this time window.');
    }

    const overlappingRiderRequests = await this.prisma.rideRequest.findFirst({
      where: {
        riderId: driverId,
        status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        ride: {
          startTime: { lt: endTime },
          endTime: { gt: startTime },
          id: { not: id }
        }
      }
    });

    if (overlappingRiderRequests) {
      throw new BadRequestException('You already have a requested ride during this time window.');
    }

    const now = new Date();

    const userVehicle = await this.prisma.vehicle.findUnique({
      where: { userId: driverId }
    });

    const vehicleType = dto.vehicleType || userVehicle?.type || 'CAR';
    const vehicleCapacity = dto.vehicleCapacity || userVehicle?.capacity || 5;
    const fuelType = dto.fuelType || userVehicle?.fuelType || 'Petrol';
    const vehicleNumber = dto.vehicleNumber || userVehicle?.vehicleNumber || '';

    const existingRide = await this.prisma.ride.findUnique({
      where: { id }
    });

    if (existingRide) {
      if (
        existingRide.status === RideStatus.CANCELLED ||
        existingRide.status === RideStatus.COMPLETED ||
        existingRide.status === RideStatus.REJECTED
      ) {
        // Reactivate / overwrite the inactive ride using update returning statement
        const rows = await this.prisma.$queryRaw<
          Array<{
            id: string;
            createdAt: Date;
            updatedAt: Date;
            driverId: string;
            seatsAvailable: number;
            chargeCents: number;
            startTime: Date;
            endTime: Date;
            startPlaceName: string;
            endPlaceName: string;
            status: RideStatus;
            startPointGeoJson: string;
            endPointGeoJson: string;
            routeGeoJson: string;
          }>
        >(Prisma.sql`
          UPDATE "Ride"
          SET "updatedAt" = ${now},
              "seatsAvailable" = ${dto.seatsAvailable},
              "chargeCents" = ${dto.chargeCents},
              "startTime" = ${startTime},
              "endTime" = ${endTime},
              "status" = ${RideStatus.OPEN}::"RideStatus",
              "vehicleType" = ${vehicleType},
              "vehicleCapacity" = ${vehicleCapacity},
              "fuelType" = ${fuelType},
              "vehicleNumber" = ${vehicleNumber},
              "startPoint" = ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
              "endPoint" = ST_SetSRID(ST_GeomFromText(${endWkt}), 4326),
              "routeLine" = ST_SetSRID(ST_GeomFromText(${routeWkt}), 4326)
          WHERE id = ${id}
          RETURNING
            "id","createdAt","updatedAt","driverId","seatsAvailable","chargeCents","startTime","endTime","startPlaceName","endPlaceName","status",
            ST_AsGeoJSON("startPoint") as "startPointGeoJson",
            ST_AsGeoJSON("endPoint") as "endPointGeoJson",
            ST_AsGeoJSON("routeLine") as "routeGeoJson"
        `);
        return rows[0];
      } else {
        throw new BadRequestException('You already have an active ride with these details.');
      }
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        driverId: string;
        seatsAvailable: number;
        chargeCents: number;
        startTime: Date;
        endTime: Date;
        startPlaceName: string;
        endPlaceName: string;
        status: RideStatus;
        startPointGeoJson: string;
        endPointGeoJson: string;
        routeGeoJson: string;
      }>
    >(Prisma.sql`
      INSERT INTO "Ride"
        ("id", "updatedAt", "driverId","seatsAvailable","chargeCents","startTime","endTime","startPlaceName","endPlaceName","status","startPoint","endPoint","routeLine","vehicleType","vehicleCapacity","fuelType","vehicleNumber")
      VALUES
        (${id}, ${now}, ${driverId}, ${dto.seatsAvailable}, ${dto.chargeCents}, ${startTime}, ${endTime}, ${dto.startPlaceName}, ${dto.endPlaceName}, ${RideStatus.OPEN}::"RideStatus",
         ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
         ST_SetSRID(ST_GeomFromText(${endWkt}), 4326),
         ST_SetSRID(ST_GeomFromText(${routeWkt}), 4326),
         ${vehicleType}, ${vehicleCapacity}, ${fuelType}, ${vehicleNumber}
        )
      RETURNING
        "id","createdAt","updatedAt","driverId","seatsAvailable","chargeCents","startTime","endTime","startPlaceName","endPlaceName","status",
        ST_AsGeoJSON("startPoint") as "startPointGeoJson",
        ST_AsGeoJSON("endPoint") as "endPointGeoJson",
        ST_AsGeoJSON("routeLine") as "routeGeoJson"
    `);

    return rows[0];
  }

  async listRides(
    status?: RideStatus,
    driverId?: string,
    excludeDriverId?: string,
    page?: number,
    limit?: number,
    latitude?: number,
    longitude?: number,
    radius: number = 3000,
  ) {
    const conditions: Prisma.Sql[] = [];
    if (status) {
      conditions.push(Prisma.sql`r."status" = ${status}::"RideStatus"`);
    } else {
      conditions.push(Prisma.sql`r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus")`);
    }

    // Only show carpool rides (CAR) in Rides Near You. CAB rides are handled via cab share matchmaking.
    conditions.push(Prisma.sql`r."vehicleType" = 'CAR'`);

    if (driverId) conditions.push(Prisma.sql`r."driverId" = ${driverId}`);
    
    if (excludeDriverId) {
      conditions.push(Prisma.sql`r."driverId" != ${excludeDriverId}`);
      conditions.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "RideRequest" rr
        WHERE rr."rideId" = r."id"
          AND rr."riderId" = ${excludeDriverId}
          AND rr."status" IN ('REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
      )`);
    }

    // Vacancy check: Exclude rides that have any accepted ride requests
    conditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "RideRequest" rr
      WHERE rr."rideId" = r."id"
        AND rr."status" = 'ACCEPTED'::"RideStatus"
    )`);
    
    // Only list rides that have not passed their start time
    conditions.push(Prisma.sql`r."startTime" >= NOW()`);

    // Spatial filter check
    if (latitude !== undefined && longitude !== undefined) {
      const startWkt = `POINT(${longitude} ${latitude})`;
      conditions.push(Prisma.sql`ST_DWithin(r."startPoint"::geography, ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography, ${radius})`);
    }

    const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    
    let limitClause = Prisma.sql`LIMIT 200`;
    let offsetClause = Prisma.empty;

    if (limit && limit > 0) {
      limitClause = Prisma.sql`LIMIT ${limit}`;
      if (page && page > 0) {
        const offset = (page - 1) * limit;
        offsetClause = Prisma.sql`OFFSET ${offset}`;
      }
    }

    const rides = await this.prisma.$queryRaw<
      Array<{
        id: string;
        driverName: string;
        driverAvatar: string | null;
        driverGender: string | null;
        seatsAvailable: number;
        chargeCents: number;
        startTime: Date;
        endTime: Date;
        startPlaceName: string;
        endPlaceName: string;
        status: RideStatus;
        startPointGeoJson: string;
        endPointGeoJson: string;
        distanceMeters: number | null;
      }>
    >(Prisma.sql`
      SELECT
        r."id", u."name" as "driverName", u."profilePic" as "driverAvatar", u."gender" as "driverGender", u."rating" as "driverRating",
        r."seatsAvailable", r."chargeCents", r."startTime", r."endTime",
        r."startPlaceName", r."endPlaceName", r."status",
        ST_AsGeoJSON(r."startPoint") as "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") as "endPointGeoJson",
        ST_Distance(r."startPoint"::geography, r."endPoint"::geography) as "distanceMeters"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      ${where}
      ORDER BY r."startTime" ASC
      ${limitClause}
      ${offsetClause}
    `);

    return rides.map(ride => {
      const distanceMeters = Number(ride.distanceMeters || 0);
      const distance_km = distanceMeters / 1000.0;
      const co2_saved_kg = distance_km * 0.12;
      return {
        ...ride,
        distance_km,
        co2_saved_kg,
      };
    });
  }

  async getRide(id: string, userId?: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        driverId: string;
        driverName: string;
        driverAvatar: string | null;
        driverGender: string | null;
        driverRating: number;
        seatsAvailable: number;
        chargeCents: number;
        startTime: Date;
        endTime: Date;
        startPlaceName: string;
        endPlaceName: string;
        status: RideStatus;
        startPointGeoJson: string;
        endPointGeoJson: string;
        routeGeoJson: string;
        distanceMeters: number | null;
        vehicleType: string;
        vehicleCapacity: number;
        fuelType: string;
        vehicleNumber: string;
      }>
    >(Prisma.sql`
      SELECT
        r."id", r."driverId", u."name" as "driverName", u."profilePic" as "driverAvatar", u."gender" as "driverGender", u."rating" as "driverRating",
        r."seatsAvailable", r."chargeCents", r."startTime", r."endTime",
        r."startPlaceName", r."endPlaceName", r."status",
        ST_AsGeoJSON(r."startPoint") as "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") as "endPointGeoJson",
        ST_AsGeoJSON(r."routeLine") as "routeGeoJson",
        r."vehicleType", r."vehicleCapacity", r."fuelType", r."vehicleNumber",
        COALESCE(
          ST_Length(r."routeLine"::geography),
          ST_Distance(r."startPoint"::geography, r."endPoint"::geography)
        ) as "distanceMeters"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      WHERE r."id" = ${id}
      LIMIT 1
    `);
    if (!rows[0]) throw new NotFoundException('Ride not found');
    const ride = rows[0];

    const isPastRide = ride.startTime < new Date();
    // Raw SQL so we can include rider geometry for map rendering
    const passengerRows = await (isPastRide
      ? this.prisma.$queryRaw<
          Array<{
            request_id: string;
            rider_id: string;
            rider_name: string;
            rider_avatar: string | null;
            status: string;
            fareCents: number;
            seats: number;
            riderStartGeoJson: string | null;
            riderEndGeoJson: string | null;
            riderStartName: string;
            riderEndName: string;
          }>
        >(Prisma.sql`
          SELECT
            rr."id" as "request_id",
            rr."riderId" as "rider_id",
            u."name" as "rider_name",
            u."profilePic" as "rider_avatar",
            rr."status"::text,
            rr."fareCents",
            rr."seats",
            rr."riderStartName",
            rr."riderEndName",
            ST_AsGeoJSON(rr."riderStart") as "riderStartGeoJson",
            ST_AsGeoJSON(rr."riderEnd")   as "riderEndGeoJson"
          FROM "RideRequest" rr
          JOIN "User" u ON rr."riderId" = u."id"
          WHERE rr."rideId" = ${id}
            AND rr."status"::text = 'ACCEPTED'
        `)
      : this.prisma.$queryRaw<
          Array<{
            request_id: string;
            rider_id: string;
            rider_name: string;
            rider_avatar: string | null;
            status: string;
            fareCents: number;
            seats: number;
            riderStartGeoJson: string | null;
            riderEndGeoJson: string | null;
            riderStartName: string;
            riderEndName: string;
          }>
        >(Prisma.sql`
          SELECT
            rr."id" as "request_id",
            rr."riderId" as "rider_id",
            u."name" as "rider_name",
            u."profilePic" as "rider_avatar",
            rr."status"::text,
            rr."fareCents",
            rr."seats",
            rr."riderStartName",
            rr."riderEndName",
            ST_AsGeoJSON(rr."riderStart") as "riderStartGeoJson",
            ST_AsGeoJSON(rr."riderEnd")   as "riderEndGeoJson"
          FROM "RideRequest" rr
          JOIN "User" u ON rr."riderId" = u."id"
          WHERE rr."rideId" = ${id}
            AND rr."status"::text IN ('REQUESTED', 'ACCEPTED')
        `)
    );

    const driverReviews = await this.prisma.review.findMany({
      where: {
        fromUserId: ride.driverId,
        rideId: id
      }
    });
    const passengerReviewMap = new Map<string, number>();
    driverReviews.forEach(rev => {
      passengerReviewMap.set(rev.toUserId, rev.rating);
    });

    (ride as any).passengers = passengerRows.map(rr => ({
      request_id: rr.request_id,
      rider_id: rr.rider_id,
      rider_name: rr.rider_name || 'Passenger',
      rider_avatar: rr.rider_avatar || null,
      status: rr.status,
      chat_id: getDeterministicChatId(ride.driverId, rr.rider_id),
      fareCents: rr.fareCents,
      seats: rr.seats,
      riderStartName: rr.riderStartName,
      riderEndName: rr.riderEndName,
      riderStartGeoJson: rr.riderStartGeoJson || null,
      riderEndGeoJson: rr.riderEndGeoJson || null,
      my_review_rating: passengerReviewMap.get(rr.rider_id) || null,
    }));

    let my_review_rating: number | null = null;
    if (userId && userId !== ride.driverId) {
      const myRequest = await this.prisma.rideRequest.findFirst({
        where: { rideId: id, riderId: userId }
      });
      if (myRequest) {
        (ride as any).my_request_id = myRequest.id;
        (ride as any).my_request_status = myRequest.status;
        (ride as any).my_request_is_invitation = myRequest.isInvitation || false;
        (ride as any).my_chat_id = getDeterministicChatId(ride.driverId, userId);
        (ride as any).my_fare_cents = myRequest.fareCents;
      }

      const review = await this.prisma.review.findFirst({
        where: {
          fromUserId: userId,
          toUserId: ride.driverId,
          rideId: id
        }
      });
      my_review_rating = review ? review.rating : null;
    }

    const distanceMeters = Number(ride.distanceMeters || 0);
    const distance_km = distanceMeters / 1000.0;
    const co2_saved_kg = distance_km * 0.12;

    const { calculateFare } = require('../../common/utils/pricing');
    const estimatedFare = calculateFare({
      distanceMeters,
      deviationMeters: 0,
      startPlaceName: ride.startPlaceName,
      endPlaceName: ride.endPlaceName,
      vehicleType: ride.vehicleType || 'CAR',
      vehicleCapacity: ride.vehicleCapacity || 5,
      fuelType: ride.fuelType || 'Petrol'
    });

    return {
      ...ride,
      distance_km,
      co2_saved_kg,
      my_review_rating,
      estimatedFare,
    };
  }

  async setRideStatus(id: string, status: RideStatus) {
    const ride = await this.prisma.ride.findUnique({
      where: { id }
    });
    if (!ride) throw new NotFoundException('Ride not found');

    const updated = await this.prisma.ride.update({
      where: { id },
      data: { status },
      select: { id: true, status: true, updatedAt: true },
    });

    if (status === RideStatus.CANCELLED) {
      // Also cancel the driver's own BuddyRequest in this time window
      const driverBuddyRequestId = generateDeterministicId('buddy', [
        ride.driverId,
        ride.startPlaceName,
        ride.endPlaceName,
        ride.startTime.toISOString(),
      ]);

      try {
        await this.prisma.buddyRequest.update({
          where: { id: driverBuddyRequestId },
          data: { status: 'CANCELLED' }
        });
      } catch (e) {
        // Safe to ignore if no buddy request exists for this ride
      }

      const activeRequests = await this.prisma.rideRequest.findMany({
        where: { rideId: id, status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] } }
      });

      if (activeRequests.length > 0) {
        await this.prisma.rideRequest.updateMany({
          where: { rideId: id, status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] } },
          data: { status: RideStatus.CANCELLED }
        });

        for (const req of activeRequests) {
          try {
            await this.chatService.sendNotificationToUser(
              req.riderId,
              'Ride Cancelled by Driver',
              'The driver has cancelled the offered ride.',
              'ride_cancelled',
              { rideId: id, requestId: req.id }
            );
          } catch (e) {
            console.error('Failed to send cancellation notification to rider:', req.riderId, e);
          }
        }
      }
    }

    return updated;
  }

  async getMyRides(userId: string, page?: number, limit?: number) {
    const driverRides = await this.prisma.ride.findMany({
      where: { driverId: userId },
      include: {
        driver: true,
        requests: { include: { rider: true } }
      }
    });

    const riderRequests = await this.prisma.rideRequest.findMany({
      where: { riderId: userId },
      include: { ride: { include: { driver: true } } }
    });

    const buddyRequests = await this.prisma.buddyRequest.findMany({
      where: { riderId: userId },
      include: { rider: true }
    });

    const myBuddyIds = buddyRequests.map(b => b.id);
    const receivedRequests = await this.prisma.rideRequest.findMany({
      where: {
        OR: [
          {
            ride: {
              driverId: userId
            },
            isInvitation: false
          },
          {
            buddyRequestId: { in: myBuddyIds },
            isInvitation: true
          }
        ]
      },
      include: {
        rider: true,
        ride: { include: { driver: true } }
      }
    });

    const writtenReviews = await this.prisma.review.findMany({
      where: { fromUserId: userId }
    });
    const reviewMap = new Map<string, number>();
    writtenReviews.forEach(rev => {
      if (rev.rideId) {
        reviewMap.set(`${rev.rideId}:${rev.toUserId}`, rev.rating);
      }
    });

    // Ensure all ACCEPTED/STARTED requests have OTPs generated
    for (const rr of riderRequests) {
      if ((rr.status === 'ACCEPTED' || rr.status === 'STARTED') && !rr.otp) {
        const randomOtp = Math.floor(1000 + Math.random() * 9000).toString();
        rr.otp = randomOtp;
        await this.prisma.rideRequest.update({
          where: { id: rr.id },
          data: { otp: randomOtp }
        });
      }
    }

    for (const rr of receivedRequests) {
      if ((rr.status === 'ACCEPTED' || rr.status === 'STARTED') && !rr.otp) {
        const randomOtp = Math.floor(1000 + Math.random() * 9000).toString();
        rr.otp = randomOtp;
        await this.prisma.rideRequest.update({
          where: { id: rr.id },
          data: { otp: randomOtp }
        });
      }
    }

    for (const r of driverRides) {
      for (const rr of r.requests) {
        if ((rr.status === 'ACCEPTED' || rr.status === 'STARTED') && !rr.otp) {
          const randomOtp = Math.floor(1000 + Math.random() * 9000).toString();
          rr.otp = randomOtp;
          await this.prisma.rideRequest.update({
            where: { id: rr.id },
            data: { otp: randomOtp }
          });
        }
      }
    }

    const upcoming: any[] = [];
    const past: any[] = [];
    const requested: any[] = [];

    driverRides.forEach(r => {
      const mapped = this.mapDriverRide(r, userId, reviewMap);
      if (r.status === 'CANCELLED' || r.startTime < new Date()) {
        past.push(mapped);
      } else {
        upcoming.push(mapped);

        // Find sent invitations in driverRides
        r.requests.forEach(rr => {
          if (rr.status === 'REQUESTED' && rr.isInvitation === true) {
            (rr as any).ride = r; // Crucial fix: attach parent ride reference to avoid mapping crashes
            const mappedInvitation = this.mapReceivedRequest(rr, reviewMap);
            requested.push({
              ...mappedInvitation,
              section: 'sent',
              requestType: r.vehicleType === 'CAB' ? 'sent_cab_share' : 'sent_ride_join',
              peer_name: rr.rider?.name || 'Passenger',
              peer_avatar: rr.rider?.profilePic || null,
              peer_rating: rr.rider?.rating ?? 5.0,
            });
          }
        });
      }
    });

    riderRequests.forEach(rr => {
      const mapped = this.mapRiderRequest(rr, reviewMap);
      const rideStartTime = rr.riderStartTime || rr.ride.startTime;
      if (rr.status === 'ACCEPTED' || rr.status === 'STARTED') {
        if (rideStartTime >= new Date() && rr.ride.status !== 'CANCELLED') {
          upcoming.push(mapped);
        } else {
          past.push(mapped);
        }
      } else if (rr.status === 'REQUESTED') {
        if (rideStartTime >= new Date() && rr.ride.status !== 'CANCELLED') {
          // Push to upcoming so it shows in own upcoming tab as "Requested"
          if (rr.isInvitation === false) {
            upcoming.push(mapped);
          }

          if (rr.isInvitation === false) {
            requested.push({
              ...mapped,
              section: 'sent',
              requestType: 'sent_ride_join'
            });
          } else {
            requested.push({
              ...mapped,
              section: 'received',
              requestType: rr.ride.vehicleType === 'CAB' ? 'received_cab_share' : 'received_ride_join'
            });
          }
        } else {
          past.push(mapped);
        }
      } else if (rr.status === 'REJECTED' || rr.status === 'CANCELLED' || rr.status === 'COMPLETED') {
        past.push(mapped);
      }
    });

    receivedRequests.forEach(rr => {
      const isDriver = rr.ride.driverId === userId;
      const mapped = isDriver
        ? this.mapReceivedRequest(rr, reviewMap)
        : this.mapRiderRequest(rr, reviewMap);

      const rideStartTime = rr.riderStartTime || rr.ride.startTime;
      if (rr.status === 'REQUESTED') {
        if (rideStartTime >= new Date() && rr.ride.status !== 'CANCELLED') {
          if (rr.isInvitation === false) {
            if (!requested.some(item => item.request_id === rr.id)) {
              requested.push({
                ...mapped,
                section: 'received',
                requestType: 'received_ride_join'
              });
            }
          } else {
            if (!requested.some(item => item.request_id === rr.id)) {
              requested.push({
                ...mapped,
                section: 'received',
                requestType: rr.ride.vehicleType === 'CAB' ? 'received_cab_share' : 'received_ride_join'
              });
            }
          }
        } else {
          if (!past.some(item => item.request_id === rr.id)) {
            past.push(mapped);
          }
        }
      } else if (rr.status === 'REJECTED' || rr.status === 'CANCELLED') {
        if (!past.some(item => item.request_id === rr.id)) {
          past.push(mapped);
        }
      }
    });

    buddyRequests.forEach(br => {
      if (br.status === 'ACCEPTED') {
        return;
      }

      // Skip displaying buddy request if the user has an associated CAB ride in this window
      const hasAssociatedCabRide = driverRides.some(dr =>
        dr.vehicleType === 'CAB' &&
        Math.abs(dr.startTime.getTime() - br.startTime.getTime()) < 2 * 60 * 60 * 1000
      );
      if (hasAssociatedCabRide) {
        return;
      }

      // Skip displaying buddy request if the user has an active/pending ride request associated with it
      const hasAssociatedRiderRequest = riderRequests.some(rr =>
        rr.buddyRequestId === br.id &&
        rr.status !== 'CANCELLED' &&
        rr.status !== 'REJECTED'
      );
      if (hasAssociatedRiderRequest) {
        return;
      }

      if (br.status === 'OPEN') {
        const isDriverOfActiveCab = driverRides.some(dr =>
          dr.vehicleType === 'CAB' && dr.status !== 'CANCELLED' && dr.status !== 'COMPLETED'
        );
        if (isDriverOfActiveCab) {
          return;
        }
      }

      const mapped = {
        id: br.id,
        isBuddyRequest: true,
        role: 'rider',
        request_status: br.status,
        driver_id: br.riderId,
        driver_name: br.rider?.name || 'Buddy Request',
        driver_avatar: br.rider?.profilePic || null,
        driver_rating: 5.0,
        origin: br.startPlaceName,
        destination: br.endPlaceName,
        departure_time: br.startTime.toISOString(),
        seats_available: br.seatsNeeded,
        price_per_seat: 0,
        status: br.status,
        chat_id: null,
        peer_name: 'Buddy',
      };

      if (br.status === 'CANCELLED' || br.startTime < new Date()) {
        past.push(mapped);
      } else if (br.status === 'OPEN') {
        // Push open buddy requests ONLY to upcoming tab, NOT to requests tab
        upcoming.push(mapped);
      } else {
        upcoming.push(mapped);
      }
    });

    upcoming.sort((a, b) => new Date(a.departure_time).getTime() - new Date(b.departure_time).getTime());
    past.sort((a, b) => new Date(b.departure_time).getTime() - new Date(a.departure_time).getTime());

    const totalUpcoming = upcoming.length;
    const totalPast = past.length;
    const totalRequested = requested.length;

    let paginatedUpcoming = upcoming;
    let paginatedPast = past;
    let paginatedRequested = requested;

    if (limit && limit > 0) {
      const p = page || 1;
      const start = (p - 1) * limit;
      const end = p * limit;
      paginatedUpcoming = upcoming.slice(start, end);
      paginatedPast = past.slice(start, end);
      paginatedRequested = requested.slice(start, end);
    }

    return {
      upcoming: paginatedUpcoming,
      past: paginatedPast,
      requested: paginatedRequested,
      hasMoreUpcoming: limit ? totalUpcoming > (page || 1) * limit : false,
      hasMorePast: limit ? totalPast > (page || 1) * limit : false,
      hasMoreRequested: limit ? totalRequested > (page || 1) * limit : false,
      totalUpcomingCount: totalUpcoming,
      totalPastCount: totalPast,
      totalRequestedCount: totalRequested,
    };
  }

  async offerRide(body: any, userId: string) {
    const { startName, endName, startCoords, endCoords, seats, price, date, time, vehicleType: bodyVehicleType } = body;
    const startTime = new Date(`${date}T${time}:00+05:30`);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // add 1 hr approx

    console.log(`[OfferRide Service] Local Time: ${date} ${time} | Calculated UTC: ${startTime.toISOString()}`);

    const rideId = generateDeterministicId('ride', [userId, startName, endName, startTime.toISOString()]);

    const overlappingDriver = await this.prisma.ride.findFirst({
       where: {
         driverId: userId,
         status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         startTime: { lt: endTime },
         endTime: { gt: startTime },
         id: { not: rideId }
       }
    });
    if (overlappingDriver) throw new BadRequestException('You already have a published ride during this time window.');

    const overlappingRider = await this.prisma.rideRequest.findFirst({
       where: {
         riderId: userId,
         status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         ride: {
           startTime: { lt: endTime },
           endTime: { gt: startTime },
           id: { not: rideId }
         }
       }
    });
    if (overlappingRider) throw new BadRequestException('You already have a requested ride during this time window.');

    const userVehicle = await this.prisma.vehicle.findUnique({
      where: { userId }
    });

    const vehicleType = bodyVehicleType || userVehicle?.type || 'CAR';
    const vehicleCapacity = userVehicle?.capacity || 5;
    const fuelType = userVehicle?.fuelType || 'Petrol';
    const vehicleNumber = userVehicle?.vehicleNumber || '';

    const existingRide = await this.prisma.ride.findUnique({
      where: { id: rideId }
    });

    let ride;
    if (existingRide) {
      if (
        existingRide.status === RideStatus.CANCELLED ||
        existingRide.status === RideStatus.COMPLETED ||
        existingRide.status === RideStatus.REJECTED
      ) {
        ride = await this.prisma.ride.update({
          where: { id: rideId },
          data: {
            status: RideStatus.OPEN,
            seatsAvailable: seats || vehicleCapacity || 3,
            chargeCents: (price || 10) * 100,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            vehicleType,
            vehicleCapacity,
            fuelType,
            vehicleNumber,
          }
        });
      } else {
        throw new BadRequestException('You already have an active ride with these details.');
      }
    } else {
      ride = await this.prisma.ride.create({
        data: {
          id: rideId,
          driverId: userId,
          seatsAvailable: seats || vehicleCapacity || 3,
          chargeCents: (price || 10) * 100,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          startPlaceName: startName,
          endPlaceName: endName,
          status: RideStatus.OPEN,
          vehicleType,
          vehicleCapacity,
          fuelType,
          vehicleNumber,
        }
      });
    }

    if (startCoords && startCoords.length === 2 && endCoords && endCoords.length === 2) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Ride"
        SET "startPoint" = ST_SetSRID(ST_MakePoint(${startCoords[0]}, ${startCoords[1]}), 4326),
            "endPoint" = ST_SetSRID(ST_MakePoint(${endCoords[0]}, ${endCoords[1]}), 4326),
            "routeLine" = ST_SetSRID(ST_MakeLine(ST_MakePoint(${startCoords[0]}, ${startCoords[1]}), ST_MakePoint(${endCoords[0]}, ${endCoords[1]})), 4326)
        WHERE id = ${ride.id}
      `);

      // Update the chargeCents using the calculated PostGIS distance!
      const distanceRow = await this.prisma.$queryRaw<Array<{ distance: number }>>(Prisma.sql`
        SELECT ST_Distance("startPoint"::geography, "endPoint"::geography) as distance
        FROM "Ride"
        WHERE id = ${ride.id}
      `);
      if (distanceRow && distanceRow.length > 0) {
        const { calculateFare } = require('../../common/utils/pricing');
        const calculated = calculateFare({
          distanceMeters: distanceRow[0].distance,
          deviationMeters: 0,
          startPlaceName: startName,
          endPlaceName: endName,
          vehicleType,
          vehicleCapacity,
          fuelType,
        });
        ride = await this.prisma.ride.update({
          where: { id: ride.id },
          data: { chargeCents: calculated.finalFare * 100 }
        });
      }
    }

    return ride;
  }

  async bookRide(id: string, userId: string, body: any) {
    const ride = await this.prisma.ride.findUnique({
      where: { id },
      include: { requests: true }
    });
    if (!ride) throw new NotFoundException('Ride not found');

    const seatsCount = Number(body.seats) || 1;
    let calculatedFareCents = (body.fareCents !== undefined && !isNaN(Number(body.fareCents)))
      ? Math.round(Number(body.fareCents))
      : undefined;

    if (calculatedFareCents === undefined && body.riderStartCoords && body.riderEndCoords) {
      const startWkt = pointWkt({ lng: Number(body.riderStartCoords[0]), lat: Number(body.riderStartCoords[1]) });
      const endWkt = pointWkt({ lng: Number(body.riderEndCoords[0]), lat: Number(body.riderEndCoords[1]) });

      const segmentRows = await this.prisma.$queryRaw<
        Array<{ segmentMeters: number; startDistMeters: number; endDistMeters: number; vehicleType: string; vehicleCapacity: number; fuelType: string }>
      >(Prisma.sql`
        SELECT
          CASE
            WHEN r."routeLine" IS NOT NULL THEN
              ST_Length(
                ST_LineSubstring(
                  r."routeLine"::geography,
                  LEAST(
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)),
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${endWkt}), 4326))
                  ),
                  GREATEST(
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)),
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${endWkt}), 4326))
                  )
                )
              )
            ELSE
              ST_Distance(
                ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography,
                ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography
              )
          END AS "segmentMeters",
          ST_Distance(r."routeLine"::geography, ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography) AS "startDistMeters",
          ST_Distance(r."routeLine"::geography, ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography) AS "endDistMeters",
          r."vehicleType", r."vehicleCapacity", r."fuelType"
        FROM "Ride" r
        WHERE r."id" = ${ride.id}
      `);

      if (segmentRows && segmentRows.length > 0) {
        const seg = segmentRows[0];
        const segmentMeters = Number(seg.segmentMeters || 0);
        const deviationMeters = Number(seg.startDistMeters || 0) + Number(seg.endDistMeters || 0);
        const { calculateFare } = require('../../common/utils/pricing');
        const fareBreakdown = calculateFare({
          distanceMeters: segmentMeters,
          deviationMeters,
          startPlaceName: body.riderStartName || ride.startPlaceName,
          endPlaceName: body.riderEndName || ride.endPlaceName,
          vehicleType: seg.vehicleType || 'CAR',
          vehicleCapacity: seg.vehicleCapacity || 5,
          fuelType: seg.fuelType || 'Petrol',
        });
        calculatedFareCents = Math.round(fareBreakdown.finalFare * 100);
      }
    }

    if (calculatedFareCents === undefined) {
      calculatedFareCents = ride.chargeCents;
    }

    const exists = ride.requests.find(r => r.riderId === userId && r.status !== 'CANCELLED');
    if (exists) return { ok: true, chat_id: getDeterministicChatId(ride.driverId, userId) };

    const requestId = await this.prisma.rideRequest.create({
      data: {
        id: randomUUID(),
        rideId: ride.id,
        riderId: userId,
        riderStartName: body.riderStartName || ride.startPlaceName,
        riderEndName: body.riderEndName || ride.endPlaceName,
        riderStartTime: body.riderStartTime ? new Date(body.riderStartTime) : ride.startTime,
        status: RideStatus.REQUESTED,
        fareCents: calculatedFareCents
      },
      include: { rider: true }
    });

    if (body.riderStartCoords && body.riderEndCoords) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "RideRequest"
        SET "riderStart" = ST_SetSRID(ST_MakePoint(${body.riderStartCoords[0]}, ${body.riderStartCoords[1]}), 4326),
            "riderEnd" = ST_SetSRID(ST_MakePoint(${body.riderEndCoords[0]}, ${body.riderEndCoords[1]}), 4326)
        WHERE id = ${requestId.id}
      `);
    }

    try {
      await this.chatService.sendNotificationToUser(
        ride.driverId,
        'New Booking Request',
        `${requestId.rider.name} requested to join your ride.`,
        'new_ride_request',
        {
          id: requestId.id,
          rideId: ride.id,
          riderName: requestId.rider.name,
          riderStartName: requestId.riderStartName,
          riderEndName: requestId.riderEndName,
          riderStartTime: requestId.riderStartTime,
          status: requestId.status,
          fareCents: calculatedFareCents
        }
      );
    } catch (e) {
      console.error('Failed to send notification to driver:', ride.driverId, e);
    }

    return { ok: true, chat_id: getDeterministicChatId(ride.driverId, userId) };
  }

  private mapDriverRide(r: any, userId: string, reviewMap?: Map<string, number>) {
    const acceptedPassengers = (r.requests || []).filter((rr: any) =>
      rr.status === 'ACCEPTED' || rr.status === 'STARTED' || rr.status === 'COMPLETED'
    );
    const isConfirmed = acceptedPassengers.length > 0;
    const firstPassenger = acceptedPassengers[0];

    const chat_id = firstPassenger ? getDeterministicChatId(r.driverId, firstPassenger.riderId) : null;
    const peer_name = isConfirmed && firstPassenger ? firstPassenger.rider?.name : null;
    const peer_avatar = isConfirmed && firstPassenger ? firstPassenger.rider?.profilePic : null;
    const peer_rating = isConfirmed && firstPassenger ? (firstPassenger.rider?.rating ?? 5.0) : null;

    return {
      id: r.id,
      role: 'driver',
      isConfirmed,
      driver_id: r.driverId,
      driver_name: r.driver?.name || 'Driver',
      driver_avatar: r.driver?.profilePic || null,
      driver_gender: r.driver?.gender || null,
      driver_rating: r.driver?.rating ?? 5.0,
      origin: r.startPlaceName,
      destination: r.endPlaceName,
      departure_time: r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat: isConfirmed && firstPassenger ? (firstPassenger.fareCents ? firstPassenger.fareCents / 100 : r.chargeCents / 100) : r.chargeCents / 100,
      status: r.status,
      vehicle_type: r.vehicleType,
      passengers: acceptedPassengers.map((rr: any) => ({
        request_id: rr.id,
        rider_id: rr.riderId,
        rider_name: rr.rider?.name || 'Passenger',
        rider_avatar: rr.rider?.profilePic || null,
        rider_rating: rr.rider?.rating ?? 5.0,
        status: rr.status,
        chat_id: getDeterministicChatId(r.driverId, rr.riderId),
        seats: rr.seats,
        my_review_rating: reviewMap ? (reviewMap.get(`${r.id}:${rr.riderId}`) || null) : null,
        otp: rr.otp,
        actual_fare: rr.actualFare,
        rider_share: rr.riderShare,
        driver_share: rr.driverShare,
      })),
      chat_id,
      peer_name,
      peer_avatar,
      peer_rating,
    };
  }

  private mapRiderRequest(rr: any, reviewMap?: Map<string, number>) {
    const r = rr.ride;
    const isConfirmed = rr.status === 'ACCEPTED' || rr.status === 'STARTED' || rr.status === 'COMPLETED';

    return {
      id: r.id,
      request_id: rr.id,
      role: 'rider',
      isConfirmed,
      request_status: rr.status,
      driver_id: r.driverId,
      driver_name: r.driver?.name || 'Driver',
      driver_avatar: r.driver?.profilePic || null,
      driver_gender: r.driver?.gender || null,
      driver_rating: r.driver?.rating ?? 5.0,
      origin: rr.riderStartName || r.startPlaceName,
      destination: rr.riderEndName || r.endPlaceName,
      departure_time: rr.riderStartTime?.toISOString() || r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat: rr.fareCents ? rr.fareCents / 100 : r.chargeCents / 100,
      status: r.status,
      vehicle_type: r.vehicleType,
      chat_id: getDeterministicChatId(r.driverId, rr.riderId),
      peer_name: r.driver?.name || 'Driver',
      peer_avatar: r.driver?.profilePic || null,
      peer_rating: r.driver?.rating ?? 5.0,
      is_invitation: rr.isInvitation || false,
      my_review_rating: reviewMap ? (reviewMap.get(`${r.id}:${r.driverId}`) || null) : null,
      otp: rr.otp,
      actual_fare: rr.actualFare,
      rider_share: rr.riderShare,
      driver_share: rr.driverShare,
      buddyRequestId: rr.buddyRequestId,
    };
  }

  private mapReceivedRequest(rr: any, reviewMap?: Map<string, number>) {
    const r = rr.ride;
    const isConfirmed = rr.status === 'ACCEPTED' || rr.status === 'STARTED' || rr.status === 'COMPLETED';

    return {
      id: r.id,
      request_id: rr.id,
      role: 'driver',
      isConfirmed,
      rider_id: rr.riderId,
      request_status: rr.status,
      driver_id: r.driverId,
      driver_name: r.driver?.name || 'Driver',
      driver_avatar: r.driver?.profilePic || null,
      driver_gender: r.driver?.gender || null,
      driver_rating: r.driver?.rating ?? 5.0,
      origin: rr.riderStartName || r.startPlaceName,
      destination: rr.riderEndName || r.endPlaceName,
      departure_time: rr.riderStartTime?.toISOString() || r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat: rr.fareCents ? rr.fareCents / 100 : r.chargeCents / 100,
      status: r.status,
      vehicle_type: r.vehicleType,
      chat_id: getDeterministicChatId(r.driverId, rr.riderId),
      peer_name: rr.rider?.name || 'Passenger',
      peer_avatar: rr.rider?.profilePic || null,
      peer_rating: rr.rider?.rating ?? 5.0,
      is_invitation: rr.isInvitation || false,
      my_review_rating: reviewMap ? (reviewMap.get(`${r.id}:${rr.riderId}`) || null) : null,
      otp: rr.otp,
      actual_fare: rr.actualFare,
      rider_share: rr.riderShare,
      driver_share: rr.driverShare,
      buddyRequestId: rr.buddyRequestId,
    };
  }
}
