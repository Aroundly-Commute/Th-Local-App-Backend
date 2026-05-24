import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, RideStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lineStringWkt, pointWkt } from '../../common/utils/geo';
import { PublishRideDto } from './dto/publish-ride.dto';
import { ChatService } from '../chat/chat.service';

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

  async listRides(status?: RideStatus, driverId?: string, excludeDriverId?: string) {
    const conditions: Prisma.Sql[] = [];
    if (status) conditions.push(Prisma.sql`r."status" = ${status}::"RideStatus"`);
    if (driverId) conditions.push(Prisma.sql`r."driverId" = ${driverId}`);
    if (excludeDriverId) conditions.push(Prisma.sql`r."driverId" != ${excludeDriverId}`);
    
    // Only list rides that have not passed their start time
    conditions.push(Prisma.sql`r."startTime" >= NOW()`);

    const where = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    return this.prisma.$queryRaw<
      Array<{
        id: string;
        driverName: string;
        driverAvatar: string | null;
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
        r."id", u."name" as "driverName", u."profilePic" as "driverAvatar",
        r."seatsAvailable", r."chargeCents", r."startTime", r."endTime",
        r."startPlaceName", r."endPlaceName", r."status",
        ST_AsGeoJSON(r."startPoint") as "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") as "endPointGeoJson"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      ${where}
      ORDER BY r."startTime" ASC
      LIMIT 200
    `);
  }

  async getRide(id: string, userId?: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        driverId: string;
        driverName: string;
        driverAvatar: string | null;
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
        r."id", r."driverId", u."name" as "driverName", u."profilePic" as "driverAvatar",
        r."seatsAvailable", r."chargeCents", r."startTime", r."endTime",
        r."startPlaceName", r."endPlaceName", r."status",
        ST_AsGeoJSON(r."startPoint") as "startPointGeoJson",
        ST_AsGeoJSON(r."endPoint") as "endPointGeoJson",
        ST_AsGeoJSON(r."routeLine") as "routeGeoJson"
      FROM "Ride" r
      JOIN "User" u ON r."driverId" = u."id"
      WHERE r."id" = ${id}
      LIMIT 1
    `);
    if (!rows[0]) throw new NotFoundException('Ride not found');
    const ride = rows[0];

    const requests = await this.prisma.rideRequest.findMany({
      where: { rideId: id, status: { in: ['REQUESTED', 'ACCEPTED'] as any } },
      include: { rider: true }
    });
    (ride as any).passengers = requests.map(rr => ({
      request_id: rr.id,
      rider_id: rr.riderId,
      rider_name: (rr.rider as any)?.name || 'Passenger',
      rider_avatar: (rr.rider as any)?.profilePic || null,
      status: rr.status,
      chat_id: `chat_${rr.id}`,
    }));

    if (userId && userId !== ride.driverId) {
      const myRequest = await this.prisma.rideRequest.findFirst({
        where: { rideId: id, riderId: userId }
      });
      if (myRequest) {
        (ride as any).my_request_id = myRequest.id;
        (ride as any).my_request_status = myRequest.status;
        (ride as any).my_chat_id = `chat_${myRequest.id}`;
      }
    }

    return ride;
  }

  async setRideStatus(id: string, status: RideStatus) {
    const updated = await this.prisma.ride.update({
      where: { id },
      data: { status },
      select: { id: true, status: true, updatedAt: true },
    });
    return updated;
  }

  async getMyRides(userId: string) {
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

    const upcoming: any[] = [];
    const past: any[] = [];
    const requested: any[] = [];

    driverRides.forEach(r => {
      const mapped = this.mapDriverRide(r, userId);
      if (r.status === 'CANCELLED' || r.startTime < new Date()) {
        past.push(mapped);
      } else {
        upcoming.push(mapped);
      }
    });

    riderRequests.forEach(rr => {
      const mapped = this.mapRiderRequest(rr);
      const rideStartTime = rr.riderStartTime || rr.ride.startTime;
      if (rr.status === 'ACCEPTED') {
        if (rideStartTime >= new Date() && rr.ride.status !== 'CANCELLED') {
          upcoming.push(mapped);
        } else {
          past.push(mapped);
        }
      } else if (rr.status === 'REQUESTED') {
        if (rideStartTime >= new Date() && rr.ride.status !== 'CANCELLED') {
          requested.push(mapped);
        } else {
          past.push(mapped);
        }
      } else if (rr.status === 'REJECTED' || rr.status === 'CANCELLED') {
        past.push(mapped);
      }
    });

    upcoming.sort((a, b) => new Date(a.departure_time).getTime() - new Date(b.departure_time).getTime());
    past.sort((a, b) => new Date(b.departure_time).getTime() - new Date(a.departure_time).getTime());

    return { upcoming, past, requested };
  }

  async offerRide(body: any, userId: string) {
    const { startName, endName, startCoords, endCoords, seats, price, date, time } = body;
    const startTime = new Date(`${date}T${time}:00+05:30`);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // add 1 hr approx

    console.log(`[OfferRide Service] Local Time: ${date} ${time} | Calculated UTC: ${startTime.toISOString()}`);

    const overlappingDriver = await this.prisma.ride.findFirst({
       where: {
         driverId: userId,
         status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         startTime: { lt: endTime },
         endTime: { gt: startTime }
       }
    });
    if (overlappingDriver) throw new BadRequestException('You already have a published ride during this time window.');

    const overlappingRider = await this.prisma.rideRequest.findFirst({
       where: {
         riderId: userId,
         status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         ride: {
           startTime: { lt: endTime },
           endTime: { gt: startTime }
         }
       }
    });
    if (overlappingRider) throw new BadRequestException('You already have a requested ride during this time window.');

    const ride = await this.prisma.ride.create({
      data: {
        driverId: userId,
        seatsAvailable: seats || 3,
        chargeCents: (price || 10) * 100,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        startPlaceName: startName,
        endPlaceName: endName,
        status: RideStatus.OPEN,
      }
    });

    if (startCoords && startCoords.length === 2 && endCoords && endCoords.length === 2) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Ride"
        SET "startPoint" = ST_SetSRID(ST_MakePoint(${startCoords[0]}, ${startCoords[1]}), 4326),
            "endPoint" = ST_SetSRID(ST_MakePoint(${endCoords[0]}, ${endCoords[1]}), 4326),
            "routeLine" = ST_SetSRID(ST_MakeLine(ST_MakePoint(${startCoords[0]}, ${startCoords[1]}), ST_MakePoint(${endCoords[0]}, ${endCoords[1]})), 4326)
        WHERE id = ${ride.id}
      `);
    }

    return ride;
  }

  async bookRide(id: string, userId: string) {
    const ride = await this.prisma.ride.findUnique({ where: { id } });
    if (!ride) throw new NotFoundException('Ride not found');

    if (ride.driverId === userId) {
      throw new BadRequestException('Cannot book your own ride');
    }

    const overlappingDriver = await this.prisma.ride.findFirst({
       where: {
         driverId: userId,
         status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         startTime: { lt: ride.endTime },
         endTime: { gt: ride.startTime }
       }
    });
    if (overlappingDriver) throw new BadRequestException('You have a published ride overlapping with this time window.');

    const overlappingRider = await this.prisma.rideRequest.findFirst({
       where: {
         riderId: userId,
         status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         ride: {
           startTime: { lt: ride.endTime },
           endTime: { gt: ride.startTime }
         }
       }
    });
    if (overlappingRider) throw new BadRequestException('You already have a requested ride overlapping with this time window.');

    const requestId = await this.prisma.rideRequest.create({
      data: {
        rideId: id,
        riderId: userId,
        riderStartName: ride.startPlaceName,
        riderEndName: ride.endPlaceName,
        riderStartTime: ride.startTime,
        status: RideStatus.REQUESTED
      },
      include: {
        rider: true,
      }
    });

    this.chatService.notifyUserWs(ride.driverId, 'new_ride_request', {
      id: requestId.id,
      rideId: ride.id,
      riderName: requestId.rider.name,
      riderStartName: requestId.riderStartName,
      riderEndName: requestId.riderEndName,
      riderStartTime: requestId.riderStartTime,
      status: requestId.status
    });

    return { ok: true, chat_id: `chat_${requestId.id}` };
  }

  private mapDriverRide(r: any, userId: string) {
    const acceptedPassengers = (r.requests || []).filter((rr: any) =>
      rr.status === 'ACCEPTED' || rr.status === 'REQUESTED'
    );
    const firstPassenger = acceptedPassengers[0];
    const chat_id = firstPassenger ? `chat_${firstPassenger.id}` : null;
    const peer_name = firstPassenger ? firstPassenger.rider?.name : null;

    return {
      id: r.id,
      role: 'driver',
      driver_id: r.driverId,
      driver_name: r.driver?.name || 'Driver',
      driver_avatar: r.driver?.profilePic || null,
      driver_rating: 5.0,
      origin: r.startPlaceName,
      destination: r.endPlaceName,
      departure_time: r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat: r.chargeCents / 100,
      status: r.status,
      passengers: acceptedPassengers.map((rr: any) => ({
        request_id: rr.id,
        rider_id: rr.riderId,
        rider_name: rr.rider?.name || 'Passenger',
        rider_avatar: rr.rider?.profilePic || null,
        status: rr.status,
        chat_id: `chat_${rr.id}`,
      })),
      chat_id,
      peer_name,
    };
  }

  private mapRiderRequest(rr: any) {
    const r = rr.ride;
    return {
      id: r.id,
      request_id: rr.id,
      role: 'rider',
      request_status: rr.status,
      driver_id: r.driverId,
      driver_name: r.driver?.name || 'Driver',
      driver_avatar: r.driver?.profilePic || null,
      driver_rating: 5.0,
      origin: rr.riderStartName || r.startPlaceName,
      destination: rr.riderEndName || r.endPlaceName,
      departure_time: rr.riderStartTime?.toISOString() || r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat: r.chargeCents / 100,
      status: r.status,
      chat_id: `chat_${rr.id}`,
      peer_name: r.driver?.name || 'Driver',
    };
  }
}
