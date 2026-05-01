import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, RideStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchMatchesDto } from './dto/search-matches.dto';
import { pointWkt } from '../../common/utils/geo';
import { RequestRideDto } from './dto/request-ride.dto';

@Injectable()
export class MatchmakingService {
  constructor(private readonly prisma: PrismaService) {}

  async search(dto: SearchMatchesDto, userId: string) {
    const riderStartTime = new Date(dto.startTime);
    if (isNaN(riderStartTime.valueOf())) throw new BadRequestException('Invalid startTime');

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

    const startRadiusMeters = dto.startRadiusMeters ?? 1200;
    const endRadiusMeters = dto.endRadiusMeters ?? 1200;
    const corridorMeters = dto.corridorMeters ?? 1500;
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
            ST_MakeLine(
              ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
              ST_SetSRID(ST_GeomFromText(${endWkt}), 4326)
            )::geography AS rider_line_g,
            ${riderStartTime}::timestamptz AS rider_start_time
        )
      SELECT
        r."id",
        r."driverId" as "driverName",
        r."chargeCents",
        r."seatsAvailable",
        r."startTime",
        r."endTime",
        r."startPlaceName",
        r."endPlaceName",
        r."status",
        ST_AsGeoJSON(r."startPoint") AS "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") AS "endPointGeoJson",
        (r."startTime" + (EXTRACT(EPOCH FROM (r."endTime" - r."startTime")) * ST_LineLocatePoint(r."routeLine", rider.rider_start_g::geometry)) * INTERVAL '1 second') AS "estimatedPickupTime",
        ABS(EXTRACT(EPOCH FROM (
          (r."startTime" + (EXTRACT(EPOCH FROM (r."endTime" - r."startTime")) * ST_LineLocatePoint(r."routeLine", rider.rider_start_g::geometry)) * INTERVAL '1 second')
          - rider.rider_start_time
        )) / 60.0) AS "timeDiffMinutes",
        ST_Distance(r."routeLine"::geography, rider.rider_start_g) AS "startDistanceMeters",
        ST_Distance(r."routeLine"::geography, rider.rider_end_g) AS "endDistanceMeters",
        ST_Distance(r."routeLine"::geography, rider.rider_line_g) AS "corridorDistanceMeters",
        (
          ABS(EXTRACT(EPOCH FROM (
            (r."startTime" + (EXTRACT(EPOCH FROM (r."endTime" - r."startTime")) * ST_LineLocatePoint(r."routeLine", rider.rider_start_g::geometry)) * INTERVAL '1 second')
            - rider.rider_start_time
          )) / 60.0)
          + (ST_Distance(r."routeLine"::geography, rider.rider_start_g) / 1000.0)
          + (ST_Distance(r."routeLine"::geography, rider.rider_end_g) / 1000.0)
          + (ST_Distance(r."routeLine"::geography, rider.rider_line_g) / 2000.0)
        ) AS score
      FROM "Ride" r
      CROSS JOIN rider
      WHERE
        r."status" = ${RideStatus.OPEN}::"RideStatus"
        AND r."driverId" != ${userId}
        AND r."seatsAvailable" > 0
        AND (r."startTime" + (EXTRACT(EPOCH FROM (r."endTime" - r."startTime")) * ST_LineLocatePoint(r."routeLine", rider.rider_start_g::geometry)) * INTERVAL '1 second') 
            BETWEEN (rider.rider_start_time - (${timeWindowMinutes}::int * INTERVAL '1 minute'))
            AND (rider.rider_start_time + (${timeWindowMinutes}::int * INTERVAL '1 minute'))
        AND ST_DWithin(r."routeLine"::geography, rider.rider_start_g, ${startRadiusMeters})
        AND ST_DWithin(r."routeLine"::geography, rider.rider_end_g, ${endRadiusMeters})
        AND ST_DWithin(r."routeLine"::geography, rider.rider_line_g, ${corridorMeters})
        AND ST_LineLocatePoint(r."routeLine", rider.rider_start_g::geometry) <= ST_LineLocatePoint(r."routeLine", rider.rider_end_g::geometry)
      ORDER BY score ASC
      LIMIT 50
    `);

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
      matches: rows,
    };
  }

  async requestRide(dto: RequestRideDto, riderId: string) {
    const riderStartTime = new Date(dto.riderStartTime);
    if (isNaN(riderStartTime.valueOf())) throw new BadRequestException('Invalid riderStartTime');

    // Ensure ride exists + is open
    const ride = await this.prisma.ride.findUnique({
      where: { id: dto.rideId },
      select: { id: true, status: true, seatsAvailable: true, driverId: true, startTime: true, endTime: true },
    });
    if (!ride) throw new NotFoundException('Ride not found');
    if (ride.driverId === riderId) throw new BadRequestException('You cannot request your own ride');
    if (ride.status !== RideStatus.OPEN) throw new BadRequestException('Ride is not open');
    if (ride.seatsAvailable <= 0) throw new BadRequestException('No seats available');

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
        ("id", "updatedAt", "rideId","riderId","riderStartName","riderEndName","riderStartTime","riderStart","riderEnd","status")
      VALUES
        (${id}, ${now}, ${dto.rideId}, ${riderId}, ${dto.riderStartName}, ${dto.riderEndName}, ${riderStartTime},
         ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
         ST_SetSRID(ST_GeomFromText(${endWkt}), 4326),
         ${RideStatus.REQUESTED}::"RideStatus"
        )
      RETURNING "id","rideId","riderId" as "riderName","riderStartName","riderEndName","riderStartTime","status"
    `);

    // Mark ride requested (simple phase-1 state machine)
    await this.prisma.ride.update({
      where: { id: dto.rideId },
      data: { status: RideStatus.REQUESTED },
      select: { id: true },
    });

    return rows[0];
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
        riderStartName: string;
        riderEndName: string;
        riderStartTime: Date;
        status: RideStatus;
        riderStartGeoJson: string;
        riderEndGeoJson: string;
      }>
    >(Prisma.sql`
      SELECT
        rr."id", rr."rideId", rr."riderId" as "riderName", rr."riderStartName", rr."riderEndName", rr."riderStartTime", rr."status",
        ST_AsGeoJSON(rr."riderStart") as "riderStartGeoJson",
        ST_AsGeoJSON(rr."riderEnd") as "riderEndGeoJson"
      FROM "RideRequest" rr
      ${where}
      ORDER BY rr."createdAt" DESC
      LIMIT 200
    `);
  }

  async updateRequestStatus(requestId: string, status: RideStatus) {
    if (!(status === RideStatus.ACCEPTED || status === RideStatus.REJECTED)) {
      throw new BadRequestException('Only ACCEPTED or REJECTED are allowed here');
    }

    const req = await this.prisma.rideRequest.findUnique({
      where: { id: requestId },
      select: { id: true, rideId: true, status: true },
    });
    if (!req) throw new NotFoundException('Request not found');

    const updatedReq = await this.prisma.rideRequest.update({
      where: { id: requestId },
      data: { status },
      select: { id: true, rideId: true, status: true, updatedAt: true },
    });

    // Simple ride status transition for phase 1
    await this.prisma.ride.update({
      where: { id: req.rideId },
      data: { status },
      select: { id: true },
    });

    return updatedReq;
  }
}

