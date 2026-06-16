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

    const userVehicle = await this.prisma.vehicle.findUnique({
      where: { userId: driverId }
    });

    const vehicleType = dto.vehicleType || userVehicle?.type || 'CAR';
    const vehicleCapacity = dto.vehicleCapacity || userVehicle?.capacity || 5;
    const fuelType = dto.fuelType || userVehicle?.fuelType || 'Petrol';
    const vehicleNumber = dto.vehicleNumber || userVehicle?.vehicleNumber || '';

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

  async listRides(status?: RideStatus, driverId?: string, excludeDriverId?: string, page?: number, limit?: number) {
    const conditions: Prisma.Sql[] = [];
    if (status) conditions.push(Prisma.sql`r."status" = ${status}::"RideStatus"`);
    if (driverId) conditions.push(Prisma.sql`r."driverId" = ${driverId}`);
    if (excludeDriverId) conditions.push(Prisma.sql`r."driverId" != ${excludeDriverId}`);
    
    // Only list rides that have not passed their start time
    conditions.push(Prisma.sql`r."startTime" >= NOW()`);

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
      ${limitClause}
      ${offsetClause}
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
        ST_AsGeoJSON(r."routeLine") as "routeGeoJson",
        r."vehicleType", r."vehicleCapacity", r."fuelType", r."vehicleNumber"
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
      fareCents: rr.fareCents,
      seats: rr.seats,
    }));

    if (userId && userId !== ride.driverId) {
      const myRequest = await this.prisma.rideRequest.findFirst({
        where: { rideId: id, riderId: userId }
      });
      if (myRequest) {
        (ride as any).my_request_id = myRequest.id;
        (ride as any).my_request_status = myRequest.status;
        (ride as any).my_chat_id = `chat_${myRequest.id}`;
        (ride as any).my_fare_cents = myRequest.fareCents;
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

    if (status === RideStatus.CANCELLED) {
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

    buddyRequests.forEach(br => {
      const mapped = {
        id: br.id,
        isBuddyRequest: true,
        role: 'rider',
        request_status: br.status,
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
        requested.push(mapped);
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

    const userVehicle = await this.prisma.vehicle.findUnique({
      where: { userId }
    });

    const vehicleType = userVehicle?.type || 'CAR';
    const vehicleCapacity = userVehicle?.capacity || 5;
    const fuelType = userVehicle?.fuelType || 'Petrol';
    const vehicleNumber = userVehicle?.vehicleNumber || '';

    const ride = await this.prisma.ride.create({
      data: {
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
      const distanceMeters = distanceRow[0]?.distance || 0;
      
      const { calculateFare } = require('../../common/utils/pricing');
      const fareInfo = calculateFare({
        distanceMeters,
        deviationMeters: 0,
        startPlaceName: startName,
        endPlaceName: endName,
        vehicleType,
        vehicleCapacity,
        fuelType
      });

      await this.prisma.ride.update({
        where: { id: ride.id },
        data: {
          chargeCents: fareInfo.finalFare * 100
        }
      });
    }

    return ride;
  }

  async bookRide(id: string, userId: string, body?: any) {
    const ride = await this.prisma.ride.findUnique({ where: { id } });
    if (!ride) throw new NotFoundException('Ride not found');

    if (ride.driverId === userId) {
      throw new BadRequestException('Cannot book your own ride');
    }

    const { riderStartName, riderEndName, riderStartCoords, riderEndCoords, riderStartTime, seats } = body || {};
    const requestedSeats = Number(seats) || 1;
    if (requestedSeats <= 0) {
      throw new BadRequestException('Invalid seats count');
    }
    if (ride.seatsAvailable < requestedSeats) {
      throw new BadRequestException(`Not enough available seats. Only ${ride.seatsAvailable} remaining.`);
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

    let distanceMeters = 0;
    let deviationMeters = 0;

    if (riderStartCoords && riderStartCoords.length === 2 && riderEndCoords && riderEndCoords.length === 2) {
      const wktStart = `POINT(${riderStartCoords[0]} ${riderStartCoords[1]})`;
      const wktEnd = `POINT(${riderEndCoords[0]} ${riderEndCoords[1]})`;
      
      const geoResult = await this.prisma.$queryRaw<
        Array<{ distance: number; deviation: number }>
      >(Prisma.sql`
        SELECT 
          ST_Distance(ST_SetSRID(ST_GeomFromText(${wktStart}), 4326)::geography, ST_SetSRID(ST_GeomFromText(${wktEnd}), 4326)::geography) as distance,
          (ST_Distance("routeLine"::geography, ST_SetSRID(ST_GeomFromText(${wktStart}), 4326)::geography) + 
           ST_Distance("routeLine"::geography, ST_SetSRID(ST_GeomFromText(${wktEnd}), 4326)::geography)) as deviation
        FROM "Ride"
        WHERE id = ${id}
      `);

      distanceMeters = geoResult[0]?.distance || 0;
      deviationMeters = geoResult[0]?.deviation || 0;
    } else {
      // Fallback: use full route distance from the ride
      const geoResult = await this.prisma.$queryRaw<
        Array<{ distance: number }>
      >(Prisma.sql`
        SELECT ST_Distance("startPoint"::geography, "endPoint"::geography) as distance
        FROM "Ride"
        WHERE id = ${id}
      `);
      distanceMeters = geoResult[0]?.distance || 0;
      deviationMeters = 0;
    }

    const { calculateFare } = require('../../common/utils/pricing');
    const fareInfo = calculateFare({
      distanceMeters,
      deviationMeters,
      startPlaceName: riderStartName || ride.startPlaceName,
      endPlaceName: riderEndName || ride.endPlaceName,
      vehicleType: (ride as any).vehicleType || 'CAR',
      vehicleCapacity: (ride as any).vehicleCapacity || 5,
      fuelType: (ride as any).fuelType || 'Petrol'
    });

    const calculatedFareCents = fareInfo.finalFare * 100;

    const requestId = await this.prisma.rideRequest.create({
      data: {
        rideId: id,
        riderId: userId,
        riderStartName: riderStartName || ride.startPlaceName,
        riderEndName: riderEndName || ride.endPlaceName,
        riderStartTime: riderStartTime ? new Date(riderStartTime) : ride.startTime,
        status: RideStatus.REQUESTED,
        fareCents: calculatedFareCents,
        seats: requestedSeats
      },
      include: {
        rider: true,
      }
    });

    if (riderStartCoords && riderStartCoords.length === 2 && riderEndCoords && riderEndCoords.length === 2) {
      const wktStart = `POINT(${riderStartCoords[0]} ${riderStartCoords[1]})`;
      const wktEnd = `POINT(${riderEndCoords[0]} ${riderEndCoords[1]})`;
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "RideRequest"
        SET "riderStart" = ST_SetSRID(ST_GeomFromText(${wktStart}), 4326),
            "riderEnd" = ST_SetSRID(ST_GeomFromText(${wktEnd}), 4326)
        WHERE id = ${requestId.id}
      `);
    }

    // Mark ride requested (simple phase-1 state machine)
    await this.prisma.ride.update({
      where: { id },
      data: { status: RideStatus.REQUESTED }
    });

    await this.chatService.sendNotificationToUser(
      ride.driverId,
      'New Ride Booking Request',
      `You have a new ride booking request from ${requestId.rider.name}.`,
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
        seats: rr.seats,
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
