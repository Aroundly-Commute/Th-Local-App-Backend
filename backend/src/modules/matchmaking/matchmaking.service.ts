import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, RideStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchMatchesDto } from './dto/search-matches.dto';
import { pointWkt } from '../../common/utils/geo';
import { RequestRideDto } from './dto/request-ride.dto';
import { ChatService } from '../chat/chat.service';

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
        r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
        AND r."driverId" != ${userId}
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

    // 2. Query Cab Buddy Requests (type = 'buddy')
    const buddiesRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      WITH
        search AS (
          SELECT
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography AS search_start_g,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography AS search_end_g,
            ${riderStartTime}::timestamptz AS search_start_time
        )
      SELECT
        br."id",
        br."riderId",
        u."name" as "riderName",
        u."profilePic" as "riderAvatar",
        u."gender" as "riderGender",
        u."rating" as "riderRating",
        br."seatsNeeded",
        br."startPlaceName",
        br."endPlaceName",
        br."startTime",
        br."status",
        br."type",
        ST_AsGeoJSON(br."startPoint") AS "startPointGeoJson",
        ST_AsGeoJSON(br."endPoint") AS "endPointGeoJson"
      FROM "BuddyRequest" br
      JOIN "User" u ON br."riderId" = u."id"
      CROSS JOIN search
      WHERE
        br."status" = 'OPEN'
        AND br."riderId" != ${userId}
        AND br."type" = 'buddy'
        AND DATE((br."startTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') = DATE(search.search_start_time AT TIME ZONE 'Asia/Kolkata')
        AND ST_DWithin(br."startPoint"::geography, search.search_start_g, ${startRadiusMeters})
        AND ST_DWithin(br."endPoint"::geography, search.search_end_g, ${endRadiusMeters})
      ORDER BY ABS(EXTRACT(EPOCH FROM (br."startTime" - search.search_start_time))) ASC
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

    // 3. Query Car Pooling Requests (type = 'carpool')
    const carpoolsRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      WITH
        search AS (
          SELECT
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography AS search_start_g,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography AS search_end_g,
            ${riderStartTime}::timestamptz AS search_start_time
        )
      SELECT
        br."id",
        br."riderId",
        u."name" as "riderName",
        u."profilePic" as "riderAvatar",
        u."gender" as "riderGender",
        u."rating" as "riderRating",
        br."seatsNeeded",
        br."startPlaceName",
        br."endPlaceName",
        br."startTime",
        br."status",
        br."type",
        ST_AsGeoJSON(br."startPoint") AS "startPointGeoJson",
        ST_AsGeoJSON(br."endPoint") AS "endPointGeoJson"
      FROM "BuddyRequest" br
      JOIN "User" u ON br."riderId" = u."id"
      CROSS JOIN search
      WHERE
        br."status" = 'OPEN'
        AND br."riderId" != ${userId}
        AND br."type" = 'carpool'
        AND DATE((br."startTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata') = DATE(search.search_start_time AT TIME ZONE 'Asia/Kolkata')
        AND ST_DWithin(br."startPoint"::geography, search.search_start_g, ${startRadiusMeters})
        AND ST_DWithin(br."endPoint"::geography, search.search_end_g, ${endRadiusMeters})
      ORDER BY ABS(EXTRACT(EPOCH FROM (br."startTime" - search.search_start_time))) ASC
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
      select: { id: true, status: true, seatsAvailable: true, driverId: true, startTime: true, endTime: true },
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

    const id = randomUUID();
    const now = new Date();

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        rideId: string;
        riderId: string;
        riderStartName: string;
        riderEndName: string;
        riderStartTime: Date;
        status: RideStatus;
      }>
    >(Prisma.sql`
      INSERT INTO "RideRequest"
        ("id", "updatedAt", "rideId","riderId","riderStartName","riderEndName","riderStartTime","riderStart","riderEnd","status","seats")
      VALUES
        (${id}, ${now}, ${dto.rideId}, ${riderId}, ${dto.riderStartName}, ${dto.riderEndName}, ${riderStartTime},
         ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
         ST_SetSRID(ST_GeomFromText(${endWkt}), 4326),
         ${RideStatus.REQUESTED}::"RideStatus",
         ${seats}
        )
      RETURNING "id","rideId","riderId" as "riderName","riderStartName","riderEndName","riderStartTime","status","seats"
    `);

    // Mark ride requested (simple phase-1 state machine)
    await this.prisma.ride.update({
      where: { id: dto.rideId },
      data: { status: RideStatus.REQUESTED },
      select: { id: true },
    });

    const newRequest = rows[0];

    // Notify the driver in real-time
    this.gateway.notifyUser(ride.driverId, 'new_ride_request', newRequest);
    await this.chatService.sendNotificationToUser(
      ride.driverId,
      'New Ride Request',
      'You have received a new ride request.',
      'new_ride_request',
      newRequest
    );

    return newRequest;
  }

  async listRequests(rideId?: string, riderId?: string) {
    const conditions: Prisma.Sql[] = [];
    if (rideId) conditions.push(Prisma.sql`rr."rideId" = ${rideId}`);
    else if (riderId) conditions.push(Prisma.sql`rr."riderId" = ${riderId}`);
    
    const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    return this.prisma.$queryRaw<
      Array<{
        id: string;
        rideId: string;
        riderName: string;
        riderAvatar: string | null;
        riderStartName: string;
        riderEndName: string;
        riderStartTime: Date;
        status: RideStatus;
        riderStartGeoJson: string;
        riderEndGeoJson: string;
      }>
    >(Prisma.sql`
      SELECT
        rr."id", rr."rideId", u."name" as "riderName", u."profilePic" as "riderAvatar", rr."riderStartName", rr."riderEndName", rr."riderStartTime", rr."status",
        ST_AsGeoJSON(rr."riderStart") as "riderStartGeoJson",
        ST_AsGeoJSON(rr."riderEnd") as "riderEndGeoJson"
      FROM "RideRequest" rr
      JOIN "User" u ON rr."riderId" = u."id"
      ${where}
      ORDER BY rr."createdAt" DESC
      LIMIT 200
    `);
  }

  async updateRequestStatus(requestId: string, status: RideStatus, userId: string) {
    if (!(status === RideStatus.ACCEPTED || status === RideStatus.REJECTED || status === RideStatus.CANCELLED)) {
      throw new BadRequestException('Only ACCEPTED, REJECTED or CANCELLED are allowed here');
    }

    const req = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      include: { ride: true }
    });
    if (!req) throw new NotFoundException('Request not found');

    if (status === RideStatus.ACCEPTED || status === RideStatus.REJECTED) {
      if (req.ride.driverId !== userId) {
        throw new BadRequestException('Only the driver can accept or reject requests');
      }
    } else if (status === RideStatus.CANCELLED) {
      if (req.riderId !== userId) {
        throw new BadRequestException('Only the rider can cancel their request');
      }
    }

    if (status === RideStatus.ACCEPTED) {
      if (req.status !== RideStatus.ACCEPTED) {
        if (req.ride.seatsAvailable < req.seats) {
          throw new BadRequestException(`Not enough available seats. Only ${req.ride.seatsAvailable} remaining.`);
        }
        
        const newSeatsAvailable = req.ride.seatsAvailable - req.seats;
        let rideStatus = req.ride.status;
        if (newSeatsAvailable === 0) {
          rideStatus = RideStatus.ACCEPTED;
        } else {
          const otherRequestedCount = await this.prisma.rideRequest.count({
            where: { rideId: req.rideId, status: RideStatus.REQUESTED, id: { not: req.id } }
          });
          rideStatus = otherRequestedCount > 0 ? RideStatus.REQUESTED : RideStatus.OPEN;
        }

        await this.prisma.ride.update({
          where: { id: req.rideId },
          data: {
            seatsAvailable: newSeatsAvailable,
            status: rideStatus
          }
        });
      }
    } else if (status === RideStatus.CANCELLED || status === RideStatus.REJECTED) {
      if (req.status === RideStatus.ACCEPTED) {
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
      } else if (req.status === RideStatus.REQUESTED) {
        const pendingCount = await this.prisma.rideRequest.count({
          where: { rideId: req.rideId, status: RideStatus.REQUESTED, id: { not: req.id } }
        });
        const acceptedCount = await this.prisma.rideRequest.count({
          where: { rideId: req.rideId, status: RideStatus.ACCEPTED }
        });
        
        let rideStatus: RideStatus = RideStatus.OPEN;
        if (pendingCount > 0) {
          rideStatus = RideStatus.REQUESTED;
        } else if (acceptedCount > 0) {
          rideStatus = RideStatus.ACCEPTED;
        }
        
        await this.prisma.ride.update({
          where: { id: req.rideId },
          data: { status: rideStatus }
        });
      }
    }

    const updatedReq = await this.prisma.rideRequest.update({
      where: { id: requestId },
      data: { status },
      select: { id: true, rideId: true, status: true, updatedAt: true },
    });

    if (status === RideStatus.CANCELLED) {
      this.gateway.notifyUser(req.ride.driverId, 'ride_request_updated', updatedReq);
      await this.chatService.sendNotificationToUser(
        req.ride.driverId,
        'Booking Cancelled',
        'A rider has cancelled their booking for your ride.',
        'ride_request_updated',
        updatedReq
      );
    } else {
      this.gateway.notifyUser(req.riderId, 'ride_request_updated', updatedReq);
      await this.chatService.sendNotificationToUser(
        req.riderId,
        `Ride Request ${status}`,
        `Your ride request status has been updated to ${status.toLowerCase()}.`,
        'ride_request_updated',
        updatedReq
      );
    }

    return updatedReq;
  }

  async updateBuddyRequestStatus(id: string, status: string, userId: string) {
    const req = await this.prisma.buddyRequest.findUnique({
      where: { id }
    });
    if (!req) throw new NotFoundException('Buddy request not found');
    if (req.riderId !== userId) throw new BadRequestException('Not authorized to update this request');

    return this.prisma.buddyRequest.update({
      where: { id },
      data: { status }
    });
  }

  async createBuddyRequest(body: any, riderId: string) {
    const { startPlaceName, endPlaceName, startCoords, endCoords, startTime, seatsNeeded, type } = body;
    const departureTime = new Date(startTime);
    if (isNaN(departureTime.valueOf())) {
      throw new BadRequestException('Invalid startTime');
    }

    const startWkt = startCoords && startCoords.length === 2 ? pointWkt({ lng: startCoords[0], lat: startCoords[1] }) : null;
    const endWkt = endCoords && endCoords.length === 2 ? pointWkt({ lng: endCoords[0], lat: endCoords[1] }) : null;

    const buddyRequest = await this.prisma.buddyRequest.create({
      data: {
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

  async listBuddyRequests(userId: string, page?: number, limit?: number) {
    const prismaParams: any = {
      where: {
        riderId: { not: userId },
        status: 'OPEN',
        startTime: { gte: new Date() }
      },
      include: {
        rider: {
          select: {
            id: true,
            name: true,
            profilePic: true,
            gender: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    };

    if (limit && limit > 0) {
      prismaParams.take = limit;
      if (page && page > 1) {
        prismaParams.skip = (page - 1) * limit;
      }
    }

    return this.prisma.buddyRequest.findMany(prismaParams);
  }

  async getBuddyRequest(id: string) {
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

    const buddyRequest = await this.prisma.buddyRequest.findUnique({
      where: { id: buddyRequestId },
      include: { rider: true }
    });
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

    const newRequest = await this.prisma.rideRequest.create({
      data: {
        id: requestId,
        rideId: ride.id,
        riderId: buddyRequest.riderId,
        riderStartName: buddyRequest.startPlaceName,
        riderEndName: buddyRequest.endPlaceName,
        riderStartTime: buddyRequest.startTime,
        status: RideStatus.ACCEPTED,
        fareCents: 1000,
        seats: buddyRequest.seatsNeeded
      }
    });

    await this.prisma.ride.update({
      where: { id: ride.id },
      data: {
        seatsAvailable: ride.seatsAvailable - buddyRequest.seatsNeeded,
        status: RideStatus.ACCEPTED
      }
    });

    await this.prisma.buddyRequest.update({
      where: { id: buddyRequestId },
      data: { status: 'ACCEPTED' }
    });

    try {
      await this.chatService.sendNotificationToUser(
        buddyRequest.riderId,
        'Ride Offer Accepted',
        'Your buddy request has been accepted by a driver!',
        'ride_request_updated',
        newRequest
      );
    } catch (e) {
      console.error('Failed to send notification to rider:', buddyRequest.riderId, e);
    }

    return newRequest;
  }
}

