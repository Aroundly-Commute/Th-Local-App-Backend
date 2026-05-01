import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, RideStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lineStringWkt, pointWkt } from '../../common/utils/geo';
import { PublishRideDto } from './dto/publish-ride.dto';

@Injectable()
export class RidesService {
  constructor(private readonly prisma: PrismaService) {}

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

    const overlappingDriverRides = await this.prisma.ride.findFirst({
      where: {
        driverId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
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
        }
      }
    });

    if (overlappingRiderRequests) {
      throw new BadRequestException('You already have a requested ride during this time window.');
    }

    const id = randomUUID();
    const now = new Date();

    // Insert via raw SQL because PostGIS geometry is Unsupported in Prisma.
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
        ("id", "updatedAt", "driverId","seatsAvailable","chargeCents","startTime","endTime","startPlaceName","endPlaceName","status","startPoint","endPoint","routeLine")
      VALUES
        (${id}, ${now}, ${driverId}, ${dto.seatsAvailable}, ${dto.chargeCents}, ${startTime}, ${endTime}, ${dto.startPlaceName}, ${dto.endPlaceName}, ${RideStatus.OPEN}::"RideStatus",
         ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
         ST_SetSRID(ST_GeomFromText(${endWkt}), 4326),
         ST_SetSRID(ST_GeomFromText(${routeWkt}), 4326)
        )
      RETURNING
        "id","createdAt","updatedAt","driverId","seatsAvailable","chargeCents","startTime","endTime","startPlaceName","endPlaceName","status",
        ST_AsGeoJSON("startPoint") as "startPointGeoJson",
        ST_AsGeoJSON("endPoint") as "endPointGeoJson",
        ST_AsGeoJSON("routeLine") as "routeGeoJson"
    `);

    return rows[0];
  }

  async listRides(status?: RideStatus, driverId?: string) {
    const conditions: Prisma.Sql[] = [];
    if (status) conditions.push(Prisma.sql`"status" = ${status}::"RideStatus"`);
    if (driverId) conditions.push(Prisma.sql`"driverId" = ${driverId}`);
    const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    return this.prisma.$queryRaw<
      Array<{
        id: string;
        driverName: string;
        seatsAvailable: number;
        chargeCents: number;
        startTime: Date;
        endTime: Date;
        startPlaceName: string;
        endPlaceName: string;
        status: RideStatus;
        startPointGeoJson: string;
        endPointGeoJson: string;
      }>
    >(Prisma.sql`
      SELECT
        "id","driverId" as "driverName","seatsAvailable","chargeCents","startTime","endTime","startPlaceName","endPlaceName","status",
        ST_AsGeoJSON("startPoint") as "startPointGeoJson",
        ST_AsGeoJSON("endPoint") as "endPointGeoJson"
      FROM "Ride"
      ${where}
      ORDER BY "startTime" ASC
      LIMIT 200
    `);
  }

  async getRide(id: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        driverName: string;
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
      SELECT
        "id","driverId" as "driverName","seatsAvailable","chargeCents","startTime","endTime","startPlaceName","endPlaceName","status",
        ST_AsGeoJSON("startPoint") as "startPointGeoJson",
        ST_AsGeoJSON("endPoint") as "endPointGeoJson",
        ST_AsGeoJSON("routeLine") as "routeGeoJson"
      FROM "Ride"
      WHERE "id" = ${id}
      LIMIT 1
    `);
    if (!rows[0]) throw new NotFoundException('Ride not found');
    return rows[0];
  }

  async setRideStatus(id: string, status: RideStatus) {
    const updated = await this.prisma.ride.update({
      where: { id },
      data: { status },
      select: { id: true, status: true, updatedAt: true },
    });
    return updated;
  }
}

