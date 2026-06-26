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

    // Pre-search check to prevent unnecessary heavy SQL queries if the user is already busy
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

    const startRadiusMeters = dto.startRadiusMeters ?? 3000;
    const endRadiusMeters = dto.endRadiusMeters ?? 3000;
    const corridorMeters = dto.corridorMeters ?? 3000;
    const timeWindowMinutes = dto.timeWindowMinutes ?? 30;

    const startWkt = pointWkt(dto.start);
    const endWkt = pointWkt(dto.end);

    // Basic matching strategy (phase 1):
    // - time overlap within ±timeWindowMinutes of riderStartTime
    // - start/end proximity within radii
    // - route corridor overlap: driver route should be close to rider start->end line
    //
    // Score = time difference (minutes) + normalized distance components.
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        driverName: string;
        chargeCents: number;
        seatsAvailable: number;
        startTime: Date;
        endTime: Date;
        startPlaceName: string;
        endPlaceName: string;
        status: RideStatus;
        startPointGeoJson: string;
        endPointGeoJson: string;
        estimatedPickupTime: Date;
        timeDiffMinutes: number;
        startDistanceMeters: number;
        endDistanceMeters: number;
        corridorDistanceMeters: number;
        score: number;
      }>
    >(Prisma.sql`
      WITH
        rider AS (
          SELECT
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geography AS rider_start_g,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geography AS rider_end_g,
            ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)::geometry AS rider_start_geom,
            ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)::geometry AS rider_end_geom,
            ST_MakeLine(
              ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
              ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)
            )::geography AS rider_line_g,
            ${riderStartTime}::timestamptz AS rider_start_time
        )
      SELECT
        r."id",
        u."name" as "driverName",
        u."profilePic" as "driverAvatar",
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
        (r."startTime" + (EXTRACT(EPOCH FROM (r."endTime" - r."startTime")) * ST_LineLocatePoint(r."routeLine"::geometry, rider.rider_start_geom)) * INTERVAL '1 second') AS "estimatedPickupTime",
        ABS(EXTRACT(EPOCH FROM (
          (r."startTime" + (EXTRACT(EPOCH FROM (r."endTime" - r."startTime")) * ST_LineLocatePoint(r."routeLine"::geometry, rider.rider_start_geom)) * INTERVAL '1 second')
          - rider.rider_start_time
        )) / 60.0) AS "timeDiffMinutes",
        ST_Distance(r."routeLine"::geography, rider.rider_start_g) AS "startDistanceMeters",
        ST_Distance(r."routeLine"::geography, rider.rider_end_g) AS "endDistanceMeters",
        ST_Distance(r."routeLine"::geography, rider.rider_line_g) AS "corridorDistanceMeters",
        ST_Distance(rider.rider_start_g, rider.rider_end_g) AS "riderDistanceMeters",
        (
          (ST_Distance(r."routeLine"::geography, rider.rider_start_g) + 
           ST_Distance(r."routeLine"::geography, rider.rider_end_g)) / 1000.0
        ) AS score
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      CROSS JOIN rider
      WHERE
        r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
        AND r."driverId" != ${userId}
        AND r."seatsAvailable" >= ${seats}
        AND ST_DWithin(r."routeLine"::geography, rider.rider_start_g, ${startRadiusMeters})
        AND ST_DWithin(r."routeLine"::geography, rider.rider_end_g, ${endRadiusMeters})
        AND ST_LineLocatePoint(r."routeLine"::geometry, rider.rider_start_geom) < ST_LineLocatePoint(r."routeLine"::geometry, rider.rider_end_geom)
      ORDER BY score ASC
      LIMIT 50
    `);

    const { calculateFare } = require('../../common/utils/pricing');
    const matches = rows.map((row) => {
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

    return {
      query: {
        start: dto.start,
        end: dto.end,
        startTime: riderStartTime.toISOString(),
        startRadiusMeters,
        endRadiusMeters,
        corridorMeters,
        timeWindowMinutes,
      },
      matches,
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
    const { startPlaceName, endPlaceName, startCoords, endCoords, startTime, seatsNeeded } = body;
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
}

