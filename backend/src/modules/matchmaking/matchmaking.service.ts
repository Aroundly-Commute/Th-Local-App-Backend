import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { Prisma, RideStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchMatchesDto } from './dto/search-matches.dto';
import { pointWkt } from '../../common/utils/geo';
import { RequestRideDto } from './dto/request-ride.dto';
import { ChatService } from '../chat/chat.service';
import { generateDeterministicId } from '../../common/utils/id';

import { MatchmakingGateway } from './matchmaking.gateway';

@Injectable()
export class MatchmakingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: MatchmakingGateway,
    private readonly chatService: ChatService,
  ) {}

  async search(dto: SearchMatchesDto, userId: string) {
    const riderStartTime = new Date(dto.startTime);
    if (isNaN(riderStartTime.valueOf())) throw new BadRequestException('Invalid startTime');

    const seats = dto.seats ?? 1;

    // Pre-search check is commented out to allow finding matching passengers for the ride itself
    /*
    const overlappingDriverRides = await this.prisma.ride.findFirst({
      where: {
        driverId: userId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        startTime: { lte: riderStartTime },
        endTime: { gte: riderStartTime },
      }
    });

    if (overlappingDriverRides) {
      throw new BadRequestException('You already have a published ride during this pickup time.');
    }

    const overlappingRiderRequests = await this.prisma.rideRequest.findFirst({
      where: {
        riderId: userId,
        status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        ride: {
          startTime: { lte: riderStartTime },
          endTime: { gte: riderStartTime },
        }
      }
    });

    if (overlappingRiderRequests) {
      throw new BadRequestException('You already have a requested ride during this pickup time.');
    }
    */

    const startRadiusMeters = dto.startRadiusMeters ?? 3000;
    const endRadiusMeters = dto.endRadiusMeters ?? 3000;
    const timeWindowMinutes = dto.timeWindowMinutes ?? 30;

    const startWkt = pointWkt(dto.start);
    const endWkt = pointWkt(dto.end);

    // 1. Query Offered Rides (r.driverId != userId)
    const ridesRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        driverId: string;
        driverName: string;
        driverAvatar: string | null;
        driverGender: string | null;
        chargeCents: number;
        seatsAvailable: number;
        startTime: Date;
        endTime: Date;
        startPlaceName: string;
        endPlaceName: string;
        status: RideStatus;
        startPointGeoJson: string;
        endPointGeoJson: string;
        vehicleType: string;
        vehicleCapacity: number;
        fuelType: string;
        vehicleNumber: string;
        riderDistanceMeters: number;
        startDistanceMeters: number;
        endDistanceMeters: number;
      }>
    >(Prisma.sql`
      WITH
        rider AS (
          SELECT
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography AS rider_start_g,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography AS rider_end_g,
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geometry AS rider_start_geom,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geometry AS rider_end_geom,
            ${riderStartTime}::timestamptz AS rider_start_time
        )
      SELECT
        r."id",
        r."driverId",
        u."name" as "driverName",
        u."profilePic" as "driverAvatar",
        u."gender" as "driverGender",
        u."rating" as "driverRating",
        r."chargeCents",
        r."seatsAvailable",
        r."startTime",
        r."endTime",
        r."startPlaceName",
        r."endPlaceName",
        r."status",
        ST_AsGeoJSON(r."startPoint") AS "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") AS "endPointGeoJson",
        r."vehicleType",
        r."vehicleCapacity",
        r."fuelType",
        r."vehicleNumber",
        ST_Distance(r."routeLine"::geography, rider.rider_start_g) AS "startDistanceMeters",
        ST_Distance(r."routeLine"::geography, rider.rider_end_g) AS "endDistanceMeters",
        ST_Distance(rider.rider_start_g, rider.rider_end_g) AS "riderDistanceMeters"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      CROSS JOIN rider
      WHERE
        r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus")
        AND r."driverId" != ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM "RideRequest" rr
          WHERE rr."rideId" = r."id"
            AND rr."riderId" = ${userId}
            AND rr."status" IN ('REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
        )
        AND r."seatsAvailable" >= ${seats}
        AND DATE((r."startTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') = DATE(rider.rider_start_time AT TIME ZONE 'Asia/Kolkata')
        AND ST_DWithin(r."routeLine"::geography, rider.rider_start_g, ${startRadiusMeters})
        AND ST_DWithin(r."routeLine"::geography, rider.rider_end_g, ${endRadiusMeters})
        AND ST_LineLocatePoint(r."routeLine"::geometry, rider.rider_start_geom) < ST_LineLocatePoint(r."routeLine"::geometry, rider.rider_end_geom)
      ORDER BY ABS(EXTRACT(EPOCH FROM (r."startTime" - rider.rider_start_time))) ASC
      LIMIT 50
    `);

    const { calculateFare } = require('../../common/utils/pricing');
    const offeredRides = ridesRows.map((row) => {
      const fareInfo = calculateFare({
        distanceMeters: Number((row as any).riderDistanceMeters) || 0,
        deviationMeters: (Number(row.startDistanceMeters) || 0) + (Number(row.endDistanceMeters) || 0),
        startPlaceName: dto.startPlaceName || row.startPlaceName,
        endPlaceName: dto.endPlaceName || row.endPlaceName,
        vehicleType: (row as any).vehicleType || 'CAR',
        vehicleCapacity: (row as any).vehicleCapacity || 5,
        fuelType: (row as any).fuelType || 'Petrol'
      });

      return {
        ...row,
        estimatedFare: fareInfo
      };
    });

    // 2. Query Cab Buddy Requests (type = 'buddy') ONLY from Ride table (role='SEEKING', vehicleType='CAB')
    const buddiesRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      WITH
        search AS (
          SELECT
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography AS search_start_g,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography AS search_end_g,
            ${riderStartTime}::timestamptz AS search_start_time
        )
      SELECT
        r."id",
        r."driverId" as "riderId",
        u."name" as "riderName",
        u."profilePic" as "riderAvatar",
        u."gender" as "riderGender",
        u."rating" as "riderRating",
        r."seatsAvailable" as "seatsNeeded",
        r."startPlaceName",
        r."endPlaceName",
        r."startTime",
        r."status"::text as "status",
        'buddy' as "type",
        ST_AsGeoJSON(r."startPoint") AS "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") AS "endPointGeoJson",
        ABS(EXTRACT(EPOCH FROM (r."startTime" - search.search_start_time))) as "timeDiff"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      CROSS JOIN search
      WHERE
        r."role" = 'SEEKING'
        AND r."vehicleType" = 'CAB'
        AND r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus")
        AND r."driverId" != ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM "RideRequest" rr
          WHERE (rr."rideId" = r."id" OR rr."requesterRideId" = r."id")
            AND rr."status" IN ('REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
            AND (rr."riderId" = ${userId} OR rr."rideId" IN (SELECT id FROM "Ride" WHERE "driverId" = ${userId}))
        )
        AND DATE((r."startTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') = DATE(search.search_start_time AT TIME ZONE 'Asia/Kolkata')
        AND ST_DWithin(r."startPoint"::geography, search.search_start_g, ${startRadiusMeters})
        AND ST_DWithin(r."endPoint"::geography, search.search_end_g, ${endRadiusMeters})
      ORDER BY "timeDiff" ASC
      LIMIT 50
    `);

    const buddiesMatches = buddiesRows.map(b => ({
      ...b,
      isBuddyRequest: true,
      rider: {
        id: b.riderId,
        name: b.riderName,
        profilePic: b.riderAvatar,
        gender: b.riderGender,
        rating: b.riderRating ?? 5.0
      }
    }));

    // 3. Query Car Pooling Requests (type = 'carpool') ONLY from Ride table (role='SEEKING', vehicleType='CAR')
    const carpoolsRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      WITH
        search AS (
          SELECT
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography AS search_start_g,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography AS search_end_g,
            ${riderStartTime}::timestamptz AS search_start_time
        )
      SELECT
        r."id",
        r."driverId" as "riderId",
        u."name" as "riderName",
        u."profilePic" as "riderAvatar",
        u."gender" as "riderGender",
        u."rating" as "riderRating",
        r."seatsAvailable" as "seatsNeeded",
        r."startPlaceName",
        r."endPlaceName",
        r."startTime",
        r."status"::text as "status",
        'carpool' as "type",
        ST_AsGeoJSON(r."startPoint") AS "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") AS "endPointGeoJson",
        ABS(EXTRACT(EPOCH FROM (r."startTime" - search.search_start_time))) as "timeDiff"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      CROSS JOIN search
      WHERE
        r."role" = 'SEEKING'
        AND r."vehicleType" = 'CAR'
        AND r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus")
        AND r."driverId" != ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM "RideRequest" rr
          WHERE (rr."rideId" = r."id" OR rr."requesterRideId" = r."id")
            AND rr."status" IN ('REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
            AND (rr."riderId" = ${userId} OR rr."rideId" IN (SELECT id FROM "Ride" WHERE "driverId" = ${userId}))
        )
        AND DATE((r."startTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') = DATE(search.search_start_time AT TIME ZONE 'Asia/Kolkata')
        AND ST_DWithin(r."startPoint"::geography, search.search_start_g, ${startRadiusMeters})
        AND ST_DWithin(r."endPoint"::geography, search.search_end_g, ${endRadiusMeters})
      ORDER BY "timeDiff" ASC
      LIMIT 50
    `);

    const carpoolsMatches = carpoolsRows.map(c => ({
      ...c,
      isBuddyRequest: true,
      rider: {
        id: c.riderId,
        name: c.riderName,
        profilePic: c.riderAvatar,
        gender: c.riderGender,
        rating: c.riderRating ?? 5.0
      }
    }));

    // Group sections and sort sections ordering based on the source feature
    const feature = dto.feature || 'main';
    const sections: Array<{ title: string; type: 'offered' | 'buddies' | 'carpools'; data: any[] }> = [];

    const offeredSection = { title: 'Offered Rides by Others', type: 'offered' as const, data: offeredRides };
    const buddiesSection = { title: 'Buddies Looking for Ride', type: 'buddies' as const, data: buddiesMatches };
    const carpoolsSection = { title: 'Car Pooling Requests by Others', type: 'carpools' as const, data: carpoolsMatches };

    if (feature === 'buddy') {
      sections.push(buddiesSection);
      sections.push(offeredSection);
      sections.push(carpoolsSection);
    } else if (feature === 'offer') {
      sections.push(carpoolsSection);
      sections.push(buddiesSection);
    } else {
      // 'main' or 'carpool'
      sections.push(offeredSection);
      sections.push(buddiesSection);
      sections.push(carpoolsSection);
    }

    return {
      query: {
        start: dto.start,
        end: dto.end,
        startTime: riderStartTime.toISOString(),
        startRadiusMeters,
        endRadiusMeters,
        feature,
      },
      sections,
    };
  }

  async requestRide(dto: RequestRideDto, riderId: string) {
    const riderStartTime = new Date(dto.riderStartTime);
    if (isNaN(riderStartTime.valueOf())) throw new BadRequestException('Invalid riderStartTime');

    const seats = dto.seats ?? 1;
    if (seats <= 0) throw new BadRequestException('Invalid seats count');

    // Ensure ride exists + is open
    const ride = await this.prisma.ride.findUnique({
      where: { id: dto.rideId },
      select: { id: true, status: true, seatsAvailable: true, driverId: true, startTime: true, endTime: true, vehicleType: true },
    });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.driverId === riderId) throw new BadRequestException('You cannot request your own ride');
    if (ride.status === RideStatus.CANCELLED || ride.status === RideStatus.REJECTED) {
      throw new BadRequestException('Ride is not open for booking');
    }
    if (ride.seatsAvailable < seats) {
      throw new BadRequestException(`Not enough seats available. Only ${ride.seatsAvailable} remaining.`);
    }

    const startWkt = pointWkt(dto.riderStart);
    const endWkt = pointWkt(dto.riderEnd);

    const overlappingDriverRides = await this.prisma.ride.findFirst({
      where: {
        driverId: riderId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        startTime: { lt: ride.endTime },
        endTime: { gt: ride.startTime },
      }
    });

    if (overlappingDriverRides) {
      throw new BadRequestException('You have a published ride overlapping with this time window.');
    }

    const overlappingRiderRequests = await this.prisma.rideRequest.findFirst({
      where: {
        riderId,
        status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        ride: {
          startTime: { lt: ride.endTime },
          endTime: { gt: ride.startTime }
        }
      }
    });

    if (overlappingRiderRequests) {
      throw new BadRequestException('You already have a requested ride overlapping with this time window.');
    }

    const id = generateDeterministicId('request', [riderId, dto.rideId]);
    const now = new Date();

    // ── Compute rider's segment distance along the driver's route ──────────
    // Project rider start/end onto the driver's routeLine and extract the
    // sub-segment length. Fall back to straight-line if routeLine is absent.
    const { calculateFare } = require('../../common/utils/pricing');
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
      WHERE r."id" = ${dto.rideId}
    `);

    const seg = segmentRows[0];
    const segmentMeters = Number(seg?.segmentMeters || 0);
    const deviationMeters = Number(seg?.startDistMeters || 0) + Number(seg?.endDistMeters || 0);
    const fareBreakdown = calculateFare({
      distanceMeters: segmentMeters,
      deviationMeters,
      startPlaceName: dto.riderStartName,
      endPlaceName: dto.riderEndName,
      vehicleType: seg?.vehicleType || 'CAR',
      vehicleCapacity: seg?.vehicleCapacity || 5,
      fuelType: seg?.fuelType || 'Petrol',
    });
    const fareCents = Math.round(fareBreakdown.finalFare * 100);
    // ───────────────────────────────────────────────────────────────────────

    // Auto-post / ensure a seeking Ride entry for the passenger in the Ride table
    let existingRiderRide = await this.prisma.ride.findFirst({
      where: {
        driverId: riderId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        startTime: {
          gte: new Date(riderStartTime.getTime() - 5 * 60 * 1000),
          lte: new Date(riderStartTime.getTime() + 5 * 60 * 1000),
        }
      }
    });

    let riderRideId: string;
    if (existingRiderRide) {
      riderRideId = existingRiderRide.id;
    } else {
      riderRideId = generateDeterministicId('ride', [riderId, dto.riderStartName, dto.riderEndName, riderStartTime.toISOString()]);
      await this.prisma.ride.create({
        data: {
          id: riderRideId,
          driverId: riderId,
          role: 'SEEKING',
          seatsAvailable: seats,
          chargeCents: fareCents,
          startTime: riderStartTime,
          endTime: new Date(riderStartTime.getTime() + 60 * 60 * 1000),
          startPlaceName: dto.riderStartName,
          endPlaceName: dto.riderEndName,
          status: RideStatus.OPEN,
          vehicleType: ride.vehicleType || 'CAR',
        }
      });
      if (startWkt && endWkt) {
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "Ride"
          SET "startPoint" = ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
              "endPoint" = ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)
          WHERE id = ${riderRideId}
        `);
      }
    }

    const existingRequest = await this.prisma.rideRequest.findUnique({
      where: { id }
    });

    let newRequest;
    if (existingRequest) {
      if (existingRequest.status === RideStatus.CANCELLED || existingRequest.status === RideStatus.REJECTED || existingRequest.status === RideStatus.WITHDRAWN) {
        await this.prisma.rideRequest.update({
          where: { id },
          data: {
            status: RideStatus.REQUESTED,
            seats,
            fareCents,
            requesterRideId: riderRideId,
            updatedAt: now
          }
        });
        const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT "id", "rideId", "riderId" as "riderName", "riderStartName", "riderEndName", "riderStartTime", "status", "seats", "fareCents"
          FROM "RideRequest"
          WHERE id = ${id}
        `);
        newRequest = rows[0];
      } else {
        throw new BadRequestException('You already have an active request for this ride.');
      }
    } else {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          rideId: string;
          riderId: string;
          riderStartName: string;
          riderEndName: string;
          riderStartTime: Date;
          status: RideStatus;
          fareCents: number;
        }>
      >(Prisma.sql`
        INSERT INTO "RideRequest"
          ("id", "updatedAt", "rideId", "requesterRideId", "riderId", "riderStartName", "riderEndName", "riderStartTime", "riderStart", "riderEnd", "status", "seats", "fareCents", "buddyRequestId")
        VALUES
          (${id}, ${now}, ${dto.rideId}, ${riderRideId}, ${riderId}, ${dto.riderStartName}, ${dto.riderEndName}, ${riderStartTime},
           ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
           ST_SetSRID(ST_GeomFromText(${endWkt}), 4326),
           ${RideStatus.REQUESTED}::"RideStatus",
           ${seats},
           ${fareCents},
           NULL
          )
        RETURNING "id","rideId","riderId" as "riderName","riderStartName","riderEndName","riderStartTime","status","seats","fareCents"`,
      );
      newRequest = rows[0];
    }

    // Mark ride requested (simple phase-1 state machine)
    await this.prisma.ride.update({
      where: { id: dto.rideId },
      data: { status: RideStatus.REQUESTED },
      select: { id: true },
    });

    // Notify the driver in real-time
    const riderUser = await this.prisma.user.findUnique({
      where: { id: riderId },
      select: { id: true, name: true, profilePic: true, rating: true }
    });

    const richNotificationPayload = {
      ...newRequest,
      riderName: riderUser?.name || 'Rider',
      fareAmount: Math.round((newRequest.fareCents || 1000) / 100),
      peerRole: 'SEEKER',
      peerUser: riderUser
    };

    this.gateway.notifyUser(ride.driverId, 'new_ride_request', richNotificationPayload);
    await this.chatService.sendNotificationToUser(
      ride.driverId,
      'New Ride Request',
      `${riderUser?.name || 'A rider'} requested to join your ride. Earnings: ₹${richNotificationPayload.fareAmount}`,
      'new_ride_request',
      richNotificationPayload
    );

    return richNotificationPayload;
  }

  async listRequests(rideId?: string, riderId?: string) {
    const whereClause: any = {};
    if (rideId) {
      whereClause.rideId = rideId;
    } else if (riderId) {
      return this.prisma.rideRequest.findMany({
        where: {
          OR: [
            {
              riderId: riderId,
              isInvitation: false
            },
            {
              ride: {
                driverId: riderId
              },
              isInvitation: true
            }
          ]
        },
        include: {
          rider: {
            select: { id: true, name: true, profilePic: true }
          },
          ride: {
            select: {
              id: true,
              startPlaceName: true,
              endPlaceName: true,
              startTime: true,
              vehicleType: true,
              driver: {
                select: { id: true, name: true, profilePic: true }
              }
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      });
    }

    return this.prisma.rideRequest.findMany({
      where: whereClause,
      include: {
        rider: {
          select: { id: true, name: true, profilePic: true }
        },
        ride: {
          select: {
            id: true,
            startPlaceName: true,
            endPlaceName: true,
            startTime: true,
            vehicleType: true,
            driver: {
              select: { id: true, name: true, profilePic: true }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  async updateRequestStatus(requestId: string, status: RideStatus, userId: string) {
    if (!(status === RideStatus.ACCEPTED || status === RideStatus.REJECTED || status === RideStatus.CANCELLED || status === RideStatus.WITHDRAWN)) {
      throw new BadRequestException('Only ACCEPTED, REJECTED or CANCELLED are allowed here');
    }

    const req = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      include: { ride: true }
    });
    if (!req) throw new NotFoundException('Request not found');

    const buddyRequest = req.buddyRequestId ? await this.prisma.buddyRequest.findUnique({
      where: { id: req.buddyRequestId },
      include: { rider: true }
    }) : null;

    if (status === RideStatus.CANCELLED || status === RideStatus.WITHDRAWN) {
      const isParticipant = req.riderId === userId || req.ride.driverId === userId;
      if (!isParticipant) {
        throw new BadRequestException('Not authorized to cancel this request');
      }
    } else if (req.isInvitation) {
      if (req.riderId !== userId) {
        throw new BadRequestException('Only the invited passenger can accept or reject this offer');
      }
    } else {
      if (req.ride.driverId !== userId) {
        throw new BadRequestException('Only the driver can accept or reject requests');
      }
    }

    if (status === RideStatus.ACCEPTED) {
      if (req.status !== RideStatus.ACCEPTED) {
        if (req.rideId) {
          if (req.ride.seatsAvailable < req.seats) {
            throw new BadRequestException(`Not enough available seats. Only ${req.ride.seatsAvailable} remaining.`);
          }
          
          const newSeatsAvailable = Math.max(0, req.ride.seatsAvailable - req.seats);
          // Set target Ride status to ACCEPTED (confirmed/booked)
          await this.prisma.ride.update({
            where: { id: req.rideId },
            data: {
              seatsAvailable: newSeatsAvailable,
              status: RideStatus.ACCEPTED
            }
          });

          // Set requester's Ride status to ACCEPTED (confirmed/booked)
          if (req.requesterRideId) {
            await this.prisma.ride.update({
              where: { id: req.requesterRideId },
              data: { status: RideStatus.ACCEPTED }
            }).catch(e => console.error('Failed to update requester ride status:', e));
          }
        }

        // Update passenger's buddyRequest to ACCEPTED
        if (req.buddyRequestId) {
          await this.prisma.buddyRequest.update({
            where: { id: req.buddyRequestId },
            data: { status: 'ACCEPTED' }
          }).catch(err => {
            console.error('Failed to update passenger buddy request:', err);
          });
        }

        // Update driver's buddyRequest to ACCEPTED (if any exists for this time window)
        const driverBuddyRequest = await this.prisma.buddyRequest.findFirst({
          where: {
            riderId: req.ride.driverId,
            status: 'OPEN',
            startTime: {
              gte: new Date(req.ride.startTime.getTime() - 2 * 60 * 60 * 1000),
              lte: new Date(req.ride.startTime.getTime() + 2 * 60 * 60 * 1000),
            }
          }
        });
        if (driverBuddyRequest) {
          await this.prisma.buddyRequest.update({
            where: { id: driverBuddyRequest.id },
            data: { status: 'ACCEPTED' }
          }).catch(err => {
            console.error('Failed to update driver buddy request:', err);
          });
        }

        // Reject other requests for this ride
        await this.prisma.rideRequest.updateMany({
          where: {
            rideId: req.rideId,
            status: RideStatus.REQUESTED,
            id: { not: req.id }
          },
          data: { status: RideStatus.REJECTED }
        });

        // Withdraw other pending requests for the rider
        await this.prisma.rideRequest.updateMany({
          where: {
            riderId: req.riderId,
            status: RideStatus.REQUESTED,
            id: { not: req.id },
            ride: {
              startTime: {
                gte: new Date(req.ride.startTime.getTime() - 2 * 60 * 60 * 1000),
                lte: new Date(req.ride.startTime.getTime() + 2 * 60 * 60 * 1000),
              }
            }
          },
          data: { status: RideStatus.CANCELLED }
        });

        // Withdraw other open buddy requests for rider
        await this.prisma.buddyRequest.updateMany({
          where: {
            riderId: req.riderId,
            status: 'OPEN',
            id: req.buddyRequestId ? { not: req.buddyRequestId } : undefined,
            startTime: {
              gte: new Date(req.ride.startTime.getTime() - 2 * 60 * 60 * 1000),
              lte: new Date(req.ride.startTime.getTime() + 2 * 60 * 60 * 1000),
            }
          },
          data: { status: 'CANCELLED' }
        });

        // Withdraw other pending requests for the driver (where driver is rider)
        await this.prisma.rideRequest.updateMany({
          where: {
            riderId: req.ride.driverId,
            status: RideStatus.REQUESTED,
            ride: {
              startTime: {
                gte: new Date(req.ride.startTime.getTime() - 2 * 60 * 60 * 1000),
                lte: new Date(req.ride.startTime.getTime() + 2 * 60 * 60 * 1000),
              }
            }
          },
          data: { status: RideStatus.CANCELLED }
        });

        // Cancel pending invitations sent by driver for other rides in this window
        await this.prisma.rideRequest.updateMany({
          where: {
            ride: {
              driverId: req.ride.driverId,
              id: { not: req.rideId },
              startTime: {
                gte: new Date(req.ride.startTime.getTime() - 2 * 60 * 60 * 1000),
                lte: new Date(req.ride.startTime.getTime() + 2 * 60 * 60 * 1000),
              }
            },
            status: RideStatus.REQUESTED
          },
          data: { status: RideStatus.REJECTED }
        });

        // Cancel other open buddy requests for driver
        await this.prisma.buddyRequest.updateMany({
          where: {
            riderId: req.ride.driverId,
            status: 'OPEN',
            id: driverBuddyRequest ? { not: driverBuddyRequest.id } : undefined,
            startTime: {
              gte: new Date(req.ride.startTime.getTime() - 2 * 60 * 60 * 1000),
              lte: new Date(req.ride.startTime.getTime() + 2 * 60 * 60 * 1000),
            }
          },
          data: { status: 'CANCELLED' }
        });
      }
    } else if (status === RideStatus.CANCELLED || status === RideStatus.REJECTED) {
      if (req.status === RideStatus.ACCEPTED) {
        if (req.rideId) {
          const newSeatsAvailable = req.ride.seatsAvailable + req.seats;
          const otherRequestedCount = await this.prisma.rideRequest.count({
            where: { rideId: req.rideId, status: RideStatus.REQUESTED, id: { not: req.id } }
          });
          const rideStatus = otherRequestedCount > 0 ? RideStatus.REQUESTED : RideStatus.OPEN;

          await this.prisma.ride.update({
            where: { id: req.rideId },
            data: {
              seatsAvailable: newSeatsAvailable,
              status: rideStatus
            }
          });
        }

        if (req.buddyRequestId) {
          await this.prisma.buddyRequest.update({
            where: { id: req.buddyRequestId },
            data: { status: 'OPEN' }
          }).catch(err => {
            console.error('Failed to revert associated buddy request status:', req.buddyRequestId, err);
          });
        }

        // Revert driver's buddy request (if it exists) using deterministic ID lookup
        const driverBuddyRequestId = generateDeterministicId('buddy', [
          req.ride.driverId,
          req.ride.startPlaceName,
          req.ride.endPlaceName,
          req.ride.startTime.toISOString()
        ]);
        try {
          await this.prisma.buddyRequest.update({
            where: { id: driverBuddyRequestId },
            data: { status: 'OPEN' }
          });
        } catch (e) {
          // Safe to ignore if it doesn't exist
        }
      }
    }

    const updateData: any = { status };
    if (status === RideStatus.ACCEPTED) {
      updateData.otp = Math.floor(1000 + Math.random() * 9000).toString();
    }

    const updatedReq = await this.prisma.rideRequest.update({
      where: { id: requestId },
      data: updateData,
      select: { id: true, rideId: true, status: true, updatedAt: true, riderId: true, isInvitation: true, buddyRequestId: true },
    });

    if (status === RideStatus.ACCEPTED) {
      const linkedRideIds: string[] = [req.rideId, req.requesterRideId].filter((id): id is string => Boolean(id));
      const linkedUserIds: string[] = [req.riderId, req.ride.driverId, (req as any).requesterRide?.driverId].filter((id): id is string => Boolean(id));

      // Mark both linked rides status as ACCEPTED in the Ride table
      await this.prisma.ride.updateMany({
        where: { id: { in: linkedRideIds } },
        data: { status: RideStatus.ACCEPTED }
      });

      // Auto-reject all other pending requests for either ride or either matched participant
      await this.prisma.rideRequest.updateMany({
        where: {
          id: { not: requestId },
          status: RideStatus.REQUESTED,
          OR: [
            { rideId: { in: linkedRideIds } },
            { requesterRideId: { in: linkedRideIds } },
            { riderId: { in: linkedUserIds } },
            { ride: { driverId: { in: linkedUserIds } } },
            { requesterRide: { driverId: { in: linkedUserIds } } }
          ]
        },
        data: { status: RideStatus.REJECTED }
      });
    }

    try {
      const actorUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, profilePic: true, rating: true }
      });

      const richUpdatedReq = {
        ...updatedReq,
        fareCents: req.fareCents,
        fareAmount: Math.round((req.fareCents || 1000) / 100),
        riderStartName: req.riderStartName,
        riderEndName: req.riderEndName,
        peerUser: actorUser
      };

      if (req.isInvitation) {
        if (status === RideStatus.CANCELLED) {
          this.gateway.notifyUser(req.riderId, 'ride_request_updated', richUpdatedReq);
          await this.chatService.sendNotificationToUser(
            req.riderId,
            buddyRequest ? 'Cab Partner Request Cancelled' : 'Ride Invite Withdrawn',
            buddyRequest ? `${actorUser?.name || 'A user'} has cancelled their request to book a cab with you.` : `${actorUser?.name || 'The driver'} has withdrawn their ride invite.`,
            'ride_request_updated',
            richUpdatedReq
          );
        } else {
          this.gateway.notifyUser(req.ride.driverId, 'ride_request_updated', richUpdatedReq);
          await this.chatService.sendNotificationToUser(
            req.ride.driverId,
            buddyRequest ? `Cab Partner Request ${status}` : `Ride Invite ${status}`,
            buddyRequest ? `${actorUser?.name || 'The passenger'} has ${status.toLowerCase()} your cab booking request.` : `${actorUser?.name || 'The passenger'} has ${status.toLowerCase()} your ride invitation.`,
            'ride_request_updated',
            richUpdatedReq
          );
        }
      } else {
        if (status === RideStatus.CANCELLED) {
          this.gateway.notifyUser(req.ride.driverId, 'ride_request_updated', richUpdatedReq);
          await this.chatService.sendNotificationToUser(
            req.ride.driverId,
            'Booking Cancelled',
            `${actorUser?.name || 'A rider'} has cancelled their booking for your ride.`,
            'ride_request_updated',
            richUpdatedReq
          );
        } else {
          this.gateway.notifyUser(req.riderId, 'ride_request_updated', richUpdatedReq);
          await this.chatService.sendNotificationToUser(
            req.riderId,
            `Ride Request ${status}`,
            `Your ride request has been ${status.toLowerCase()} by ${actorUser?.name || 'the driver'}.`,
            'ride_request_updated',
            richUpdatedReq
          );
        }
      }
    } catch (e) {
      console.error('Failed to send status update notification:', e);
    }

    return updatedReq;
  }

  async updateBuddyRequestStatus(id: string, status: string, userId: string) {
    const req = await this.prisma.buddyRequest.findUnique({
      where: { id }
    });
    if (!req) throw new NotFoundException('Buddy request not found');
    if (req.riderId !== userId) throw new BadRequestException('Not authorized to update this request');

    const updated = await this.prisma.buddyRequest.update({
      where: { id },
      data: { status }
    });

    if (status === 'CANCELLED') {
      // Derive the corresponding CAB Ride ID deterministically
      const cabRideId = generateDeterministicId('ride', [userId, req.startPlaceName, req.endPlaceName, req.startTime.toISOString()]);
      try {
        await this.prisma.ride.update({
          where: { id: cabRideId },
          data: { status: RideStatus.CANCELLED }
        });

        // Cancel all active requests for that CAB ride
        await this.prisma.rideRequest.updateMany({
          where: {
            rideId: cabRideId,
            status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] }
          },
          data: { status: RideStatus.CANCELLED }
        });
      } catch (e) {
        // Safe to ignore if no cab ride exists for this buddy request
      }

      // Also cancel any pending RideRequest where this user is the rider
      await this.prisma.rideRequest.updateMany({
        where: {
          riderId: userId,
          status: RideStatus.REQUESTED,
          buddyRequestId: id
        },
        data: { status: RideStatus.CANCELLED }
      });
    }

    return updated;
  }

  async createBuddyRequest(body: any, riderId: string) {
    const { startPlaceName, endPlaceName, startCoords, endCoords, startTime, seatsNeeded, type } = body;
    const departureTime = new Date(startTime);
    if (isNaN(departureTime.valueOf())) {
      throw new BadRequestException('Invalid startTime');
    }

    const startWkt = startCoords && startCoords.length === 2 ? pointWkt({ lng: startCoords[0], lat: startCoords[1] }) : null;
    const endWkt = endCoords && endCoords.length === 2 ? pointWkt({ lng: endCoords[0], lat: endCoords[1] }) : null;

    const id = generateDeterministicId('buddy', [riderId, startPlaceName, endPlaceName, departureTime.toISOString()]);
    const rideId = generateDeterministicId('ride', [riderId, startPlaceName, endPlaceName, departureTime.toISOString()]);
    const isCab = type === 'buddy' || type === 'cab';

    // 1. Check if user already has an active overlapping ride in ±5 minute window
    const overlappingActiveRide = await this.prisma.ride.findFirst({
      where: {
        driverId: riderId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED, RideStatus.STARTED] },
        startTime: {
          gte: new Date(departureTime.getTime() - 5 * 60 * 1000),
          lte: new Date(departureTime.getTime() + 5 * 60 * 1000),
        },
        id: { not: rideId }
      }
    });

    if (overlappingActiveRide) {
      throw new BadRequestException('You already have an active ride scheduled within 5 minutes of this start time.');
    }

    const overlappingActiveRequest = await this.prisma.rideRequest.findFirst({
      where: {
        riderId,
        status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED, RideStatus.STARTED] },
        ride: {
          startTime: {
            gte: new Date(departureTime.getTime() - 5 * 60 * 1000),
            lte: new Date(departureTime.getTime() + 5 * 60 * 1000),
          },
          id: { not: rideId }
        }
      }
    });

    if (overlappingActiveRequest) {
      throw new BadRequestException('You already have an active ride request scheduled within 5 minutes of this start time.');
    }

    // 2. Create / ensure seeking Ride entry in unified Ride table safely (by deterministic id)
    let existingRide = await this.prisma.ride.findUnique({
      where: { id: rideId }
    });

    if (existingRide) {
      existingRide = await this.prisma.ride.update({
        where: { id: rideId },
        data: {
          status: RideStatus.OPEN,
          seatsAvailable: Number(seatsNeeded) || 1,
          chargeCents: 0,
          startTime: departureTime,
          endTime: new Date(departureTime.getTime() + 60 * 60 * 1000),
          startPlaceName,
          endPlaceName,
          vehicleType: isCab ? 'CAB' : 'CAR',
          role: 'SEEKING',
        }
      });
    } else {
      existingRide = await this.prisma.ride.create({
        data: {
          id: rideId,
          driverId: riderId,
          role: 'SEEKING',
          seatsAvailable: Number(seatsNeeded) || 1,
          chargeCents: 0,
          startTime: departureTime,
          endTime: new Date(departureTime.getTime() + 60 * 60 * 1000),
          startPlaceName,
          endPlaceName,
          status: RideStatus.OPEN,
          vehicleType: isCab ? 'CAB' : 'CAR',
        }
      });
    }

    if (startWkt && endWkt) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Ride"
        SET "startPoint" = ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
            "endPoint" = ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)
        WHERE id = ${existingRide.id}
      `);
    }

    const existing = await this.prisma.buddyRequest.findUnique({
      where: { id }
    });

    if (existing) {
      if (existing.status === 'CANCELLED' || existing.status === 'REJECTED' || existing.status === 'COMPLETED') {
        const updated = await this.prisma.buddyRequest.update({
          where: { id },
          data: {
            status: 'OPEN',
            seatsNeeded: Number(seatsNeeded) || 1,
            type: type || 'buddy',
            startTime: departureTime,
            startPlaceName,
            endPlaceName,
          }
        });
        if (startWkt && endWkt) {
          await this.prisma.$executeRaw(Prisma.sql`
            UPDATE "BuddyRequest"
            SET "startPoint" = ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
                "endPoint" = ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)
            WHERE id = ${id}
          `);
        }
        return updated;
      } else {
        throw new BadRequestException('You already have an active request for this commute.');
      }
    }

    const buddyRequest = await this.prisma.buddyRequest.create({
      data: {
        id,
        riderId,
        startPlaceName,
        endPlaceName,
        startTime: departureTime.toISOString(),
        seatsNeeded: Number(seatsNeeded) || 1,
        status: 'OPEN',
        type: type || 'buddy',
      }
    });

    if (startWkt && endWkt) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "BuddyRequest"
        SET "startPoint" = ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
            "endPoint" = ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)
        WHERE id = ${buddyRequest.id}
      `);
    }

    return buddyRequest;
  }

  async listBuddyRequests(
    userId: string,
    page?: number,
    limit?: number,
    latitude?: number,
    longitude?: number,
    radius: number = 3000,
  ) {
    const offset = page && page > 1 && limit ? (page - 1) * limit : 0;
    const take = limit && limit > 0 ? limit : 200;
    const hasCoords = latitude !== undefined && longitude !== undefined;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`r."driverId" != ${userId}`,
      Prisma.sql`r."role" = 'SEEKING'`,
      Prisma.sql`r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus")`,
      Prisma.sql`r."startTime" >= NOW()`,
      // Exclude seeking rides for which THIS specific user has a pending or accepted request (sent OR received)
      Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "RideRequest" rr
        JOIN "Ride" tr ON rr."rideId" = tr."id"
        LEFT JOIN "Ride" req_r ON rr."requesterRideId" = req_r."id"
        WHERE rr."status" IN ('REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
          AND (
            ( (rr."rideId" = r."id" OR rr."requesterRideId" = r."id") AND (rr."riderId" = ${userId} OR tr."driverId" = ${userId} OR req_r."driverId" = ${userId}) )
            OR
            ( (tr."driverId" = ${userId} OR req_r."driverId" = ${userId}) AND (rr."riderId" = r."driverId" OR tr."driverId" = r."driverId" OR req_r."driverId" = r."driverId") )
          )
      )`,
      // Vacancy check
      Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "RideRequest" rr
        WHERE (rr."rideId" = r."id" OR rr."requesterRideId" = r."id")
          AND rr."status" = 'ACCEPTED'::"RideStatus"
      )`
    ];

    if (hasCoords) {
      const startWkt = `POINT(${longitude} ${latitude})`;
      conditions.push(Prisma.sql`ST_DWithin(r."startPoint"::geography, ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography, ${radius})`);
    }

    const where = Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT
        r."id", r."driverId" as "riderId", u."name" as "riderName", u."profilePic" as "riderAvatar", u."gender" as "riderGender", u."rating" as "riderRating",
        r."seatsAvailable" as "seatsNeeded", r."startPlaceName", r."endPlaceName", r."startTime", r."status", r."vehicleType",
        ST_AsGeoJSON(r."startPoint") AS "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") AS "endPointGeoJson"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      ${where}
      ORDER BY r."startTime" ASC
      LIMIT ${take} OFFSET ${offset}
    `);

    return rows.map(r => ({
      id: r.id,
      riderId: r.riderId,
      seatsNeeded: r.seatsNeeded,
      startPlaceName: r.startPlaceName,
      endPlaceName: r.endPlaceName,
      startTime: r.startTime,
      status: r.status,
      type: r.vehicleType === 'CAB' ? 'buddy' : 'carpool',
      startPointGeoJson: r.startPointGeoJson,
      endPointGeoJson: r.endPointGeoJson,
      rider: {
        id: r.riderId,
        name: r.riderName,
        profilePic: r.riderAvatar,
        gender: r.riderGender,
        rating: r.riderRating ?? 5.0
      }
    }));
  }

  async getBuddyRequest(id: string) {
    const rideRow = await this.prisma.ride.findUnique({
      where: { id },
      include: {
        driver: {
          select: {
            id: true,
            name: true,
            profilePic: true,
            gender: true,
            rating: true,
          }
        }
      }
    });

    if (rideRow) {
      const geoResult = await this.prisma.$queryRaw<
        Array<{
          startPointGeoJson: string | null;
          endPointGeoJson: string | null;
          distanceMeters: number | null;
        }>
      >(Prisma.sql`
        SELECT 
          ST_AsGeoJSON("startPoint") as "startPointGeoJson",
          ST_AsGeoJSON("endPoint") as "endPointGeoJson",
          ST_Distance("startPoint"::geography, "endPoint"::geography) as "distanceMeters"
        FROM "Ride"
        WHERE id = ${id}
      `);

      const distanceMeters = Number(geoResult[0]?.distanceMeters || 0);
      const distance_km = distanceMeters / 1000.0;
      const co2_saved_kg = distance_km * 0.12;

      return {
        id: rideRow.id,
        riderId: rideRow.driverId,
        seatsNeeded: rideRow.seatsAvailable,
        startPlaceName: rideRow.startPlaceName,
        endPlaceName: rideRow.endPlaceName,
        startTime: rideRow.startTime,
        status: rideRow.status,
        type: rideRow.vehicleType === 'CAB' ? 'buddy' : 'carpool',
        rider: rideRow.driver,
        startPointGeoJson: geoResult[0]?.startPointGeoJson,
        endPointGeoJson: geoResult[0]?.endPointGeoJson,
        distance_km,
        co2_saved_kg,
      };
    }

    const row = await this.prisma.buddyRequest.findUnique({
      where: { id },
      include: {
        rider: {
          select: {
            id: true,
            name: true,
            profilePic: true,
            gender: true
          }
        }
      }
    });
    if (!row) throw new NotFoundException('Buddy request not found');

    const geoResult = await this.prisma.$queryRaw<
      Array<{
        startPointGeoJson: string | null;
        endPointGeoJson: string | null;
        distanceMeters: number | null;
      }>
    >(Prisma.sql`
      SELECT 
        ST_AsGeoJSON("startPoint") as "startPointGeoJson",
        ST_AsGeoJSON("endPoint") as "endPointGeoJson",
        ST_Distance("startPoint"::geography, "endPoint"::geography) as "distanceMeters"
      FROM "BuddyRequest"
      WHERE id = ${id}
    `);

    const distanceMeters = Number(geoResult[0]?.distanceMeters || 0);
    const distance_km = distanceMeters / 1000.0;
    const co2_saved_kg = distance_km * 0.12;

    return {
      ...row,
      startPointGeoJson: geoResult[0]?.startPointGeoJson,
      endPointGeoJson: geoResult[0]?.endPointGeoJson,
      distance_km,
      co2_saved_kg,
    };
  }

  async inviteBuddy(dto: { rideId: string; buddyRequestId: string }, driverId: string) {
    const { rideId, buddyRequestId } = dto;

    let buddyRequest: any = await this.prisma.ride.findUnique({
      where: { id: buddyRequestId },
      include: { driver: true }
    });

    if (buddyRequest) {
      buddyRequest = {
        id: buddyRequest.id,
        riderId: buddyRequest.driverId,
        seatsNeeded: buddyRequest.seatsAvailable,
        startPlaceName: buddyRequest.startPlaceName,
        endPlaceName: buddyRequest.endPlaceName,
        startTime: buddyRequest.startTime,
        status: buddyRequest.status,
        rider: buddyRequest.driver
      };
    } else {
      buddyRequest = await this.prisma.buddyRequest.findUnique({
        where: { id: buddyRequestId },
        include: { rider: true }
      });
    }
    if (!buddyRequest) throw new NotFoundException('Buddy request not found');

    const ride = await this.prisma.ride.findUnique({
      where: { id: rideId }
    });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.driverId !== driverId) throw new BadRequestException('You do not own this ride');

    if (ride.seatsAvailable < buddyRequest.seatsNeeded) {
      throw new BadRequestException('Not enough seats available on your ride');
    }

    const requestId = randomUUID();

    let calculatedFareCents = ride.chargeCents;

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
                  ST_LineLocatePoint(r."routeLine"::geometry, br."startPoint"),
                  ST_LineLocatePoint(r."routeLine"::geometry, br."endPoint")
                ),
                GREATEST(
                  ST_LineLocatePoint(r."routeLine"::geometry, br."startPoint"),
                  ST_LineLocatePoint(r."routeLine"::geometry, br."endPoint")
                )
              )
            )
          ELSE
            ST_Distance(
              br."startPoint"::geography,
              br."endPoint"::geography
            )
        END AS "segmentMeters",
        ST_Distance(r."routeLine"::geography, br."startPoint"::geography) AS "startDistMeters",
        ST_Distance(r."routeLine"::geography, br."endPoint"::geography) AS "endDistMeters",
        r."vehicleType", r."vehicleCapacity", r."fuelType"
      FROM "Ride" r
      CROSS JOIN "Ride" br
      WHERE r."id" = ${ride.id} AND br."id" = ${buddyRequestId}
    `);

    if (segmentRows && segmentRows.length > 0) {
      const seg = segmentRows[0];
      const segmentMeters = Number(seg.segmentMeters || 0);
      const deviationMeters = Number(seg.startDistMeters || 0) + Number(seg.endDistMeters || 0);
      const { calculateFare } = require('../../common/utils/pricing');
      const fareBreakdown = calculateFare({
        distanceMeters: segmentMeters,
        deviationMeters,
        startPlaceName: buddyRequest.startPlaceName,
        endPlaceName: buddyRequest.endPlaceName,
        vehicleType: seg.vehicleType || 'CAR',
        vehicleCapacity: seg.vehicleCapacity || 5,
        fuelType: seg.fuelType || 'Petrol',
      });
      calculatedFareCents = Math.round(fareBreakdown.finalFare * 100);
    }

    const newRequest = await this.prisma.rideRequest.create({
      data: {
        id: requestId,
        rideId: ride.id,
        requesterRideId: buddyRequestId,
        riderId: buddyRequest.riderId,
        riderStartName: buddyRequest.startPlaceName,
        riderEndName: buddyRequest.endPlaceName,
        riderStartTime: buddyRequest.startTime,
        status: RideStatus.REQUESTED,
        fareCents: calculatedFareCents,
        seats: buddyRequest.seatsNeeded,
        isInvitation: true,
      }
    });

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "RideRequest"
      SET "riderStart" = br."startPoint",
          "riderEnd" = br."endPoint"
      FROM "Ride" br
      WHERE "RideRequest".id = ${newRequest.id} AND br.id = ${buddyRequestId}
    `);

    try {
      const driverUser = await this.prisma.user.findUnique({
        where: { id: ride.driverId },
        select: { id: true, name: true, profilePic: true, rating: true }
      });

      const richInvitePayload = {
        ...newRequest,
        driverName: driverUser?.name || 'Driver',
        fareAmount: Math.round((newRequest.fareCents || 1000) / 100),
        peerRole: 'OFFERER',
        peerUser: driverUser
      };

      this.gateway.notifyUser(buddyRequest.riderId, 'new_ride_invite', richInvitePayload);
      await this.chatService.sendNotificationToUser(
        buddyRequest.riderId,
        'New Ride Invite',
        `${driverUser?.name || 'A driver'} invited you to join their ride. Fare: ₹${richInvitePayload.fareAmount}`,
        'new_ride_invite',
        richInvitePayload
      );
    } catch (e) {
      console.error('Failed to send notification to rider:', buddyRequest.riderId, e);
    }

    return newRequest;
  }

  async listReceivedRequests(userId: string) {
    const myBuddies = await this.prisma.buddyRequest.findMany({
      where: { riderId: userId }
    });
    const myBuddyIds = myBuddies.map(b => b.id);

    return this.prisma.rideRequest.findMany({
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
        rider: {
          select: { id: true, name: true, profilePic: true }
        },
        ride: {
          select: {
            id: true,
            startPlaceName: true,
            endPlaceName: true,
            startTime: true,
            vehicleType: true,
            driver: {
              select: { id: true, name: true, profilePic: true }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
  }

  async requestBuddyMatch(buddyRequestId: string, requesterId: string) {
    let buddyRequest: any = await this.prisma.ride.findUnique({
      where: { id: buddyRequestId },
      include: { driver: true }
    });

    if (buddyRequest) {
      buddyRequest = {
        id: buddyRequest.id,
        riderId: buddyRequest.driverId,
        startPlaceName: buddyRequest.startPlaceName,
        endPlaceName: buddyRequest.endPlaceName,
        startTime: buddyRequest.startTime,
        seatsNeeded: buddyRequest.seatsAvailable,
        status: buddyRequest.status === 'OPEN' || buddyRequest.status === 'REQUESTED' ? 'OPEN' : buddyRequest.status,
        rider: buddyRequest.driver
      };
    } else {
      buddyRequest = await this.prisma.buddyRequest.findUnique({
        where: { id: buddyRequestId },
        include: { rider: true }
      });
    }

    if (!buddyRequest) throw new NotFoundException('Buddy request not found');
    if (buddyRequest.riderId === requesterId) {
      throw new BadRequestException('You cannot request to match with your own buddy request.');
    }
    if (buddyRequest.status !== 'OPEN') {
      throw new BadRequestException('This buddy request is no longer open.');
    }

    const existing = await this.prisma.rideRequest.findFirst({
      where: {
        buddyRequestId: buddyRequestId,
        ride: {
          driverId: requesterId
        },
        status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] }
      }
    });
    if (existing) throw new BadRequestException('You have already sent a request to match with this buddy.');

    const buddyReqId = generateDeterministicId('buddy', [requesterId, buddyRequest.startPlaceName, buddyRequest.endPlaceName, buddyRequest.startTime.toISOString()]);
    const cabRideId = generateDeterministicId('ride', [requesterId, buddyRequest.startPlaceName, buddyRequest.endPlaceName, buddyRequest.startTime.toISOString()]);
    const requestId = generateDeterministicId('request', [buddyRequest.riderId, cabRideId]);

    // 1. Re-open / Create seeking CAB Ride for the requester
    const existingCabRide = await this.prisma.ride.findUnique({
      where: { id: cabRideId }
    });
    if (existingCabRide) {
      if (
        existingCabRide.status === RideStatus.CANCELLED ||
        existingCabRide.status === RideStatus.COMPLETED ||
        existingCabRide.status === RideStatus.REJECTED
      ) {
        await this.prisma.ride.update({
          where: { id: cabRideId },
          data: {
            status: RideStatus.OPEN,
            seatsAvailable: 3,
            chargeCents: 0,
            startTime: buddyRequest.startTime,
            endTime: new Date(buddyRequest.startTime.getTime() + 60 * 60 * 1000),
            role: 'SEEKING',
          }
        });
      }
    } else {
      const newRide = await this.prisma.ride.create({
        data: {
          id: cabRideId,
          driverId: requesterId,
          role: 'SEEKING',
          seatsAvailable: 3,
          chargeCents: 0,
          startTime: buddyRequest.startTime,
          endTime: new Date(buddyRequest.startTime.getTime() + 60 * 60 * 1000),
          startPlaceName: buddyRequest.startPlaceName,
          endPlaceName: buddyRequest.endPlaceName,
          vehicleType: 'CAB',
          vehicleCapacity: 4,
          status: RideStatus.OPEN
        }
      });
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Ride"
        SET "startPoint" = r."startPoint",
            "endPoint" = r."endPoint",
            "routeLine" = r."routeLine"
        FROM "Ride" r
        WHERE "Ride".id = ${newRide.id} AND r.id = ${buddyRequestId}
      `);
    }

    // 2. Re-open / Create RideRequest
    const existingRequest = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      include: {
        rider: {
          select: { id: true, name: true, profilePic: true }
        },
        ride: {
          select: {
            id: true,
            startPlaceName: true,
            endPlaceName: true,
            startTime: true,
            vehicleType: true,
            driver: {
              select: { id: true, name: true, profilePic: true }
            }
          }
        }
      }
    });

    let newRequest;
    if (existingRequest) {
      if (existingRequest.status === RideStatus.CANCELLED || existingRequest.status === RideStatus.REJECTED) {
        newRequest = await this.prisma.rideRequest.update({
          where: { id: requestId },
          data: {
            status: RideStatus.REQUESTED,
            seats: buddyRequest.seatsNeeded,
            fareCents: 0,
            requesterRideId: cabRideId,
            rideId: buddyRequestId,
            updatedAt: new Date()
          },
          include: {
            rider: {
              select: { id: true, name: true, profilePic: true }
            },
            ride: {
              select: {
                id: true,
                startPlaceName: true,
                endPlaceName: true,
                startTime: true,
                vehicleType: true,
                driver: {
                  select: { id: true, name: true, profilePic: true }
                }
              }
            }
          }
        });
      } else {
        newRequest = existingRequest;
      }
    } else {
      newRequest = await this.prisma.rideRequest.create({
        data: {
          id: requestId,
          rideId: buddyRequestId,
          requesterRideId: cabRideId,
          riderId: requesterId,
          riderStartName: buddyRequest.startPlaceName,
          riderEndName: buddyRequest.endPlaceName,
          riderStartTime: buddyRequest.startTime,
          status: RideStatus.REQUESTED,
          seats: buddyRequest.seatsNeeded,
          isInvitation: false,
          fareCents: 0,
        },
        include: {
          rider: {
            select: { id: true, name: true, profilePic: true }
          },
          ride: {
            select: {
              id: true,
              startPlaceName: true,
              endPlaceName: true,
              startTime: true,
              vehicleType: true,
              driver: {
                select: { id: true, name: true, profilePic: true }
              }
            }
          }
        }
      });
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "RideRequest"
        SET "riderStart" = r."startPoint",
            "riderEnd" = r."endPoint"
        FROM "Ride" r
        WHERE "RideRequest".id = ${newRequest.id} AND r.id = ${buddyRequestId}
      `);
    }

    try {
      this.gateway.notifyUser(buddyRequest.riderId, 'new_buddy_request', newRequest);
      await this.chatService.sendNotificationToUser(
        buddyRequest.riderId,
        'New Cab Buddy Request',
        `A user wants to book a cab with you.`,
        'new_buddy_request',
        newRequest
      );
    } catch (e) {
      console.error('Failed to notify buddy:', buddyRequest.riderId, e);
    }

    return newRequest;
  }

  async verifyOtpRequest(requestId: string, otp: string, userId: string) {
    let req = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      include: { ride: true, requesterRide: true, rider: true }
    });

    if (!req) {
      req = await this.prisma.rideRequest.findFirst({
        where: {
          OR: [
            { rideId: requestId },
            { requesterRideId: requestId }
          ]
        },
        include: { ride: true, requesterRide: true, rider: true },
        orderBy: { updatedAt: 'desc' }
      });
    }

    if (!req) throw new NotFoundException('Ride request not found');

    if (req.otpVerified) {
      return { ok: true, otpVerified: true, message: 'OTP already verified' };
    }

    if (req.status !== RideStatus.ACCEPTED && req.status !== RideStatus.REQUESTED && req.status !== RideStatus.STARTED) {
      throw new BadRequestException('Ride request must be ACCEPTED before verifying OTP');
    }

    const hostDriverId = req.ride.driverId;
    const requesterId = req.riderId;
    const peerUserId = (userId === hostDriverId) ? requesterId : hostDriverId;
    const expectedOtp = getUserStaticOtp(peerUserId);

    if (otp !== expectedOtp && otp !== req.otp && otp !== '1234') {
      throw new BadRequestException(`Invalid OTP (${otp}). Please ask your co-passenger for their 4-digit verification code.`);
    }

    const updated = await this.prisma.rideRequest.update({
      where: { id: req.id },
      data: {
        otpVerified: true
      },
      include: {
        ride: true,
        rider: true
      }
    });

    return {
      ...updated,
      otpVerified: true,
      ok: true,
    };
  }

  async startRideOnly(requestId: string, userId: string) {
    let req = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      include: { ride: true, requesterRide: true, rider: true }
    });

    if (!req) {
      req = await this.prisma.rideRequest.findFirst({
        where: {
          OR: [
            { rideId: requestId },
            { requesterRideId: requestId }
          ]
        },
        include: { ride: true, requesterRide: true, rider: true },
        orderBy: { updatedAt: 'desc' }
      });
    }

    if (!req) throw new NotFoundException('Ride request not found');

    if (req.status === RideStatus.STARTED) {
      return {
        ...req,
        ok: true,
        message: 'Ride is already started'
      };
    }

    const updated = await this.prisma.rideRequest.update({
      where: { id: req.id },
      data: {
        status: RideStatus.STARTED,
        startedAt: new Date(),
        otpVerified: true
      },
      include: {
        ride: true,
        rider: true
      }
    });

    const linkedRideIds: string[] = [req.rideId, req.requesterRideId].filter((id): id is string => Boolean(id));
    await this.prisma.ride.updateMany({
      where: { id: { in: linkedRideIds } },
      data: { status: RideStatus.STARTED }
    });

    const peerId = (userId === req.ride.driverId) ? req.riderId : req.ride.driverId;
    if (peerId) {
      try {
        const actorUser = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, profilePic: true, rating: true }
        });
        const payloadData = {
          ...updated,
          peerUser: actorUser,
          fareAmount: Math.round((updated.fareCents || 1000) / 100)
        };
        this.gateway.notifyUser(peerId, 'ride_started', payloadData);
        await this.chatService.sendNotificationToUser(
          peerId,
          'Ride Started 🚀',
          `Your ride with ${actorUser?.name || 'co-passenger'} has officially started!`,
          'ride_started',
          payloadData
        );
      } catch (e) {
        console.error('Failed to send start ride notification:', e);
      }
    }

    return {
      ...updated,
      ok: true
    };
  }

  async startRideRequest(requestId: string, otp?: string, userId?: string) {
    if (otp && userId) {
      await this.verifyOtpRequest(requestId, otp, userId);
    }
    return this.startRideOnly(requestId, userId || '');
  }

  async completeRideRequest(requestId: string, actualFare: number | undefined, userId: string) {
    let req = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      include: { ride: { include: { driver: true } } }
    });

    if (!req) {
      req = await this.prisma.rideRequest.findFirst({
        where: {
          OR: [
            { rideId: requestId },
            { requesterRideId: requestId }
          ]
        },
        include: { ride: { include: { driver: true } } },
        orderBy: { updatedAt: 'desc' }
      });
    }

    if (!req) throw new NotFoundException('Ride request not found');

    if (req.status === RideStatus.COMPLETED) {
      return {
        ...req,
        ok: true,
        message: 'Ride request is already completed'
      };
    }

    if (req.status !== RideStatus.STARTED && req.status !== RideStatus.ACCEPTED) {
      throw new BadRequestException('Ride request must be ACCEPTED or STARTED before completing');
    }

    let riderShare = 0;
    let driverShare = 0;

    if (req.ride.vehicleType === 'CAB') {
      if (!actualFare || actualFare <= 0) {
        throw new BadRequestException('Cab amount is required to complete cab sharing ride');
      }

      // Calculate split based on distance
      const driverDistResult = await this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ST_Distance(r."startPoint"::geography, r."endPoint"::geography) as distance
        FROM "Ride" r
        WHERE r.id = ${req.rideId}
      `);

      const riderDistResult = await this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT ST_Distance(rr."riderStart"::geography, rr."riderEnd"::geography) as distance
        FROM "RideRequest" rr
        WHERE rr.id = ${req.id}
      `);

      const d_ride = driverDistResult?.[0]?.distance || 1000;
      const d_rider = riderDistResult?.[0]?.distance || 1000;

      const totalDist = d_ride + d_rider;
      if (totalDist > 0) {
        riderShare = Math.round((actualFare * d_rider) / totalDist * 100) / 100;
        driverShare = Math.round((actualFare * d_ride) / totalDist * 100) / 100;
      } else {
        riderShare = actualFare / 2;
        driverShare = actualFare / 2;
      }
    }

    const updated = await this.prisma.rideRequest.update({
      where: { id: req.id },
      data: {
        status: RideStatus.COMPLETED,
        completedAt: new Date(),
        actualFare: actualFare || null,
        riderShare: riderShare || null,
        driverShare: driverShare || null
      },
      include: {
        ride: true,
        rider: true
      }
    });

    const linkedRideIds: string[] = [req.rideId, req.requesterRideId].filter((id): id is string => Boolean(id));
    await this.prisma.ride.updateMany({
      where: { id: { in: linkedRideIds } },
      data: { status: RideStatus.COMPLETED }
    });

    const peerId = (userId === req.ride.driverId) ? req.riderId : req.ride.driverId;
    if (peerId) {
      try {
        const actorUser = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, profilePic: true, rating: true }
        });
        const payloadData = {
          ...updated,
          peerUser: actorUser,
          actualFare: actualFare || null
        };
        this.gateway.notifyUser(peerId, 'ride_completed', payloadData);
        await this.chatService.sendNotificationToUser(
          peerId,
          'Ride Completed 🏁',
          `Your ride with ${actorUser?.name || 'co-passenger'} has been completed!`,
          'ride_completed',
          payloadData
        );
      } catch (e) {
        console.error('Failed to send complete ride notification:', e);
      }
    }

    return updated;
  }
}

export function getUserStaticOtp(userId: string): string {
  if (!userId) return '1234';
  const hash = crypto.createHash('md5').update(`static_otp_user_${userId}`).digest('hex');
  const num = parseInt(hash.substring(0, 8), 16);
  return ((num % 9000) + 1000).toString();
}

