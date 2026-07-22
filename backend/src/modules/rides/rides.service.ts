import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Prisma, RideStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lineStringWkt, pointWkt } from '../../common/utils/geo';
import { PublishRideDto } from './dto/publish-ride.dto';
import { CreateRecurringRideDto } from './dto/create-recurring-ride.dto';
import { ChatService } from '../chat/chat.service';
import { generateDeterministicId } from '../../common/utils/id';

const getDeterministicChatId = (user1: string, user2: string) => {
  const sorted = [user1, user2].sort();
  return `chat_${sorted[0]}_${sorted[1]}`;
};

function computeOtpRoleAndCode(params: {
  userId: string;
  hostDriverId: string;
  riderId: string;
  vehicleType: string;
  isInvitation: boolean;
  requestOtp?: string | null;
}) {
  const { userId, hostDriverId, riderId, vehicleType, isInvitation, requestOtp } = params;
  const { getUserStaticOtp } = require('../matchmaking/matchmaking.service');

  const isCab = vehicleType === 'CAB';
  const acceptorUserId = !isCab
    ? hostDriverId
    : (isInvitation ? riderId : hostDriverId);

  const can_enter_otp = userId === acceptorUserId;
  let my_display_otp = '----';

  if (!can_enter_otp) {
    if (userId === riderId) {
      my_display_otp = requestOtp || getUserStaticOtp(riderId);
    } else {
      my_display_otp = getUserStaticOtp(hostDriverId);
    }
  }

  return { can_enter_otp, my_display_otp };
}

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

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

    this.logger.log(`Publishing ride: Driver=${driverId}, From=${dto.startPlaceName}, To=${dto.endPlaceName}, StartTime=${startTime.toISOString()}`);
    const id = generateDeterministicId('ride', [driverId, dto.startPlaceName, dto.endPlaceName, startTime.toISOString()]);

    const overlappingDriverRides = await this.prisma.ride.findFirst({
      where: {
        driverId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED, RideStatus.STARTED] },
        startTime: {
          gte: new Date(startTime.getTime() - 5 * 60 * 1000),
          lte: new Date(startTime.getTime() + 5 * 60 * 1000),
        },
        id: { not: id }
      }
    });

    if (overlappingDriverRides) {
      throw new BadRequestException('You already have an active ride scheduled within 5 minutes of this start time.');
    }

    const overlappingRiderRequests = await this.prisma.rideRequest.findFirst({
      where: {
        riderId: driverId,
        status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED, RideStatus.STARTED] },
        ride: {
          startTime: {
            gte: new Date(startTime.getTime() - 5 * 60 * 1000),
            lte: new Date(startTime.getTime() + 5 * 60 * 1000),
          },
          id: { not: id }
        }
      }
    });

    if (overlappingRiderRequests) {
      throw new BadRequestException('You already have an active ride request scheduled within 5 minutes of this start time.');
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
    radius: number = 50000,
  ) {
    const conditions: Prisma.Sql[] = [];
    if (status) {
      conditions.push(Prisma.sql`r."status" = ${status}::"RideStatus"`);
    } else {
      conditions.push(Prisma.sql`r."status" IN ('OPEN'::"RideStatus", 'REQUESTED'::"RideStatus")`);
    }

    // Only show carpool rides (CAR) offered by others in Rides Near You.
    conditions.push(Prisma.sql`r."vehicleType" = 'CAR'`);
    conditions.push(Prisma.sql`r."role" = 'OFFERED'`);

    if (driverId) conditions.push(Prisma.sql`r."driverId" = ${driverId}`);
    
    if (excludeDriverId) {
      conditions.push(Prisma.sql`r."driverId" != ${excludeDriverId}`);
      // Exclude rides for which THIS specific user has a pending or accepted request (sent OR received)
      conditions.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "RideRequest" rr
        JOIN "Ride" tr ON rr."rideId" = tr."id"
        LEFT JOIN "Ride" req_r ON rr."requesterRideId" = req_r."id"
        WHERE rr."status" IN ('REQUESTED'::"RideStatus", 'ACCEPTED'::"RideStatus")
          AND (
            ( (rr."rideId" = r."id" OR rr."requesterRideId" = r."id") AND (rr."riderId" = ${excludeDriverId} OR tr."driverId" = ${excludeDriverId} OR req_r."driverId" = ${excludeDriverId}) )
            OR
            ( (tr."driverId" = ${excludeDriverId} OR req_r."driverId" = ${excludeDriverId}) AND (rr."riderId" = r."driverId" OR tr."driverId" = r."driverId" OR req_r."driverId" = r."driverId") )
          )
      )`);
    }

    // Vacancy check: Exclude rides that have any accepted ride requests
    conditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "RideRequest" rr
      WHERE (rr."rideId" = r."id" OR rr."requesterRideId" = r."id")
        AND rr."status" = 'ACCEPTED'::"RideStatus"
    )`);
    
    // Only list rides that have not passed their start time (expires on next calendar day in Asia/Kolkata timezone)
    conditions.push(Prisma.sql`((r."startTime" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date + 1) AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC' > NOW()`);

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

    const isPastRide = (() => {
      const tzOffset = 5.5 * 60 * 60 * 1000;
      const nowKolkata = new Date(Date.now() + tzOffset);
      const rideKolkata = new Date(ride.startTime.getTime() + tzOffset);
      
      const nowYear = nowKolkata.getUTCFullYear();
      const nowMonth = nowKolkata.getUTCMonth();
      const nowDate = nowKolkata.getUTCDate();
      
      const rideYear = rideKolkata.getUTCFullYear();
      const rideMonth = rideKolkata.getUTCMonth();
      const rideDate = rideKolkata.getUTCDate();
      
      if (nowYear > rideYear) return true;
      if (nowYear < rideYear) return false;
      if (nowMonth > rideMonth) return true;
      if (nowMonth < rideMonth) return false;
      return nowDate > rideDate;
    })();
    // Raw SQL so we can include rider geometry for map rendering
    const passengerRows = await (isPastRide
      ? this.prisma.$queryRaw<
          Array<{
            request_id: string;
            rider_id: string;
            rider_name: string;
            rider_avatar: string | null;
            rider_rating?: number | null;
            rider_gender?: string | null;
            status: string;
            otp: string | null;
            otp_verified: boolean | null;
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
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."id" ELSE u."id" END as "rider_id",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."name" ELSE u."name" END as "rider_name",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."profilePic" ELSE u."profilePic" END as "rider_avatar",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."rating" ELSE u."rating" END as "rider_rating",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."gender" ELSE u."gender" END as "rider_gender",
            rr."status"::text,
            rr."otp" as "otp",
            rr."otpVerified" as "otp_verified",
            rr."fareCents",
            rr."seats",
            rr."riderStartName",
            rr."riderEndName",
            ST_AsGeoJSON(rr."riderStart") as "riderStartGeoJson",
            ST_AsGeoJSON(rr."riderEnd")   as "riderEndGeoJson"
          FROM "RideRequest" rr
          JOIN "User" u ON rr."riderId" = u."id"
          JOIN "Ride" host_ride ON rr."rideId" = host_ride."id"
          JOIN "User" host_driver ON host_ride."driverId" = host_driver."id"
          WHERE (rr."rideId" = ${id} OR rr."requesterRideId" = ${id})
            AND rr."status"::text IN ('ACCEPTED', 'STARTED', 'COMPLETED')
        `)
      : this.prisma.$queryRaw<
          Array<{
            request_id: string;
            rider_id: string;
            rider_name: string;
            rider_avatar: string | null;
            rider_rating?: number | null;
            rider_gender?: string | null;
            status: string;
            otp: string | null;
            otp_verified: boolean | null;
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
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."id" ELSE u."id" END as "rider_id",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."name" ELSE u."name" END as "rider_name",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."profilePic" ELSE u."profilePic" END as "rider_avatar",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."rating" ELSE u."rating" END as "rider_rating",
            CASE WHEN rr."requesterRideId" = ${id} THEN host_driver."gender" ELSE u."gender" END as "rider_gender",
            rr."status"::text,
            rr."otp" as "otp",
            rr."otpVerified" as "otp_verified",
            rr."fareCents",
            rr."seats",
            rr."riderStartName",
            rr."riderEndName",
            ST_AsGeoJSON(rr."riderStart") as "riderStartGeoJson",
            ST_AsGeoJSON(rr."riderEnd")   as "riderEndGeoJson"
          FROM "RideRequest" rr
          JOIN "User" u ON rr."riderId" = u."id"
          JOIN "Ride" host_ride ON rr."rideId" = host_ride."id"
          JOIN "User" host_driver ON host_ride."driverId" = host_driver."id"
          WHERE (rr."rideId" = ${id} OR rr."requesterRideId" = ${id})
            AND rr."status"::text IN ('REQUESTED', 'ACCEPTED', 'STARTED', 'COMPLETED')
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

    const { getUserStaticOtp } = require('../matchmaking/matchmaking.service');
    (ride as any).passengers = passengerRows.map(rr => ({
      request_id: rr.request_id,
      rider_id: rr.rider_id,
      rider_name: rr.rider_name || 'Passenger',
      rider_avatar: rr.rider_avatar || null,
      rider_rating: rr.rider_rating ?? 5.0,
      rider_gender: rr.rider_gender || null,
      status: rr.status,
      otp_verified: rr.otp_verified || false,
      chat_id: getDeterministicChatId(ride.driverId, rr.rider_id),
      fareCents: rr.fareCents,
      seats: rr.seats,
      riderStartName: rr.riderStartName,
      riderEndName: rr.riderEndName,
      riderStartGeoJson: rr.riderStartGeoJson || null,
      riderEndGeoJson: rr.riderEndGeoJson || null,
      my_review_rating: passengerReviewMap.get(rr.rider_id) || null,
      otp: rr.otp || getUserStaticOtp(rr.rider_id),
    }));

    let my_review_rating: number | null = null;
    if (userId) {
      const myRequest = await this.prisma.rideRequest.findFirst({
        where: {
          OR: [
            { rideId: id, riderId: userId },
            { requesterRideId: id, riderId: userId },
            { rideId: id, ride: { driverId: userId } },
            { requesterRideId: id, requesterRide: { driverId: userId } }
          ],
          status: { in: ['ACCEPTED', 'STARTED', 'COMPLETED', 'REQUESTED'] }
        },
        include: {
          rider: true,
          ride: { include: { driver: true } },
          requesterRide: { include: { driver: true } }
        }
      });
      if (myRequest) {
        (ride as any).my_request_id = myRequest.id;
        (ride as any).my_request_status = myRequest.status;
        (ride as any).my_request_is_invitation = (myRequest.riderId === userId) ? (myRequest.isInvitation || false) : false;
        (ride as any).my_request_otp_verified = myRequest.otpVerified || false;
        (ride as any).my_chat_id = getDeterministicChatId(ride.driverId, userId);
        (ride as any).my_fare_cents = myRequest.fareCents;
        (ride as any).my_request_otp = myRequest.otp || getUserStaticOtp(userId);

        let peerUser: any = null;
        if (myRequest.riderId && myRequest.riderId !== userId) {
          peerUser = myRequest.rider;
        } else if (myRequest.ride && myRequest.ride.driverId !== userId) {
          peerUser = myRequest.ride.driver;
        } else if (myRequest.requesterRide && myRequest.requesterRide.driverId !== userId) {
          peerUser = myRequest.requesterRide.driver;
        }
        if (peerUser) {
          (ride as any).peer_id = peerUser.id;
          (ride as any).peer_name = peerUser.name;
          (ride as any).peer_avatar = peerUser.profilePic;
          (ride as any).peer_rating = peerUser.rating ?? 5.0;
          (ride as any).peer_gender = peerUser.gender;
        }
      }

      if (userId !== ride.driverId) {
        const review = await this.prisma.review.findFirst({
          where: {
            fromUserId: userId,
            toUserId: ride.driverId,
            rideId: id
          }
        });
        my_review_rating = review ? review.rating : null;
      }
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

    const activeReq = (ride as any).my_request_id ? await this.prisma.rideRequest.findUnique({
      where: { id: (ride as any).my_request_id },
      include: { ride: true }
    }) : null;

    const hostDriverId = activeReq ? activeReq.ride.driverId : ride.driverId;
    const riderId = activeReq ? activeReq.riderId : ((ride as any).passengers?.[0]?.rider_id || '');
    const isInvitation = activeReq ? Boolean(activeReq.isInvitation) : false;
    const requestOtp = activeReq ? activeReq.otp : ((ride as any).passengers?.[0]?.otp || null);

    const otpRoleInfo = computeOtpRoleAndCode({
      userId: userId || '',
      hostDriverId,
      riderId,
      vehicleType: ride.vehicleType,
      isInvitation,
      requestOtp
    });

    let peerUserId: string | null = null;
    if (userId) {
      if (userId === hostDriverId) {
        const firstPass = (ride as any).passengers?.[0];
        peerUserId = firstPass ? firstPass.rider_id : null;
      } else {
        peerUserId = hostDriverId;
      }
    }
    const peer_otp = peerUserId ? getUserStaticOtp(peerUserId) : null;

    return {
      ...ride,
      distance_km,
      co2_saved_kg,
      my_review_rating,
      estimatedFare,
      my_otp: otpRoleInfo.my_display_otp,
      peer_otp,
      can_enter_otp: otpRoleInfo.can_enter_otp,
      my_display_otp: otpRoleInfo.my_display_otp,
    };
  }

  async setRideStatus(id: string, status: RideStatus, userId?: string) {
    const startTime = Date.now();
    const ride = await this.prisma.ride.findUnique({
      where: { id }
    });
    if (!ride) throw new NotFoundException('Ride not found');

    if (userId && ride.driverId !== userId) {
      this.logger.warn(`User ${userId} attempted to set status of ride ${id} owned by ${ride.driverId}`);
    }

    const updated = await this.prisma.ride.update({
      where: { id },
      data: { status },
      select: { id: true, status: true, updatedAt: true },
    });

    this.logger.log(`[RIDE STATUS] Ride ${id} status changed from ${ride.status} to ${status} by user ${userId || 'system'} (+${Date.now() - startTime}ms)`);

    if (status === RideStatus.CANCELLED || status === RideStatus.WITHDRAWN) {
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
        where: {
          OR: [
            { rideId: id },
            { requesterRideId: id }
          ],
          status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] }
        },
        include: { ride: true, requesterRide: true }
      });

      if (activeRequests.length > 0) {
        await this.prisma.rideRequest.updateMany({
          where: {
            OR: [
              { rideId: id },
              { requesterRideId: id }
            ],
            status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] }
          },
          data: { status: RideStatus.CANCELLED }
        });

        for (const req of activeRequests) {
          const linkedRideIds = [req.rideId, req.requesterRideId].filter((rid): rid is string => Boolean(rid));
          if (linkedRideIds.length > 0) {
            await this.prisma.ride.updateMany({
              where: { id: { in: linkedRideIds } },
              data: { status: RideStatus.CANCELLED }
            }).catch(e => console.error('Failed to update linked rides status on setRideStatus CANCELLED:', e));
          }

          if (req.buddyRequestId) {
            await this.prisma.buddyRequest.update({
              where: { id: req.buddyRequestId },
              data: { status: 'CANCELLED' }
            }).catch(() => {});
          }

          try {
            const targetUser = req.riderId === ride.driverId
              ? (req.ride?.driverId && req.ride.driverId !== ride.driverId ? req.ride.driverId : req.riderId)
              : req.riderId;
            await this.chatService.sendNotificationToUser(
              targetUser,
              'Ride Cancelled',
              'The ride has been cancelled.',
              'ride_cancelled',
              { rideId: id, requestId: req.id }
            );
          } catch (e) {
            console.error('Failed to send cancellation notification:', e);
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
        requests: {
          include: {
            rider: true,
            ride: { include: { driver: true } },
            requesterRide: { include: { driver: true } }
          }
        },
        requestsSent: {
          include: {
            rider: true,
            ride: { include: { driver: true } },
            requesterRide: { include: { driver: true } }
          }
        }
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
      const allReqs = [...(r.requests || []), ...(r.requestsSent || [])];
      for (const rr of allReqs) {
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

    // Populate upcoming and past strictly from the unified Ride table (where driverId = userId)
    driverRides.forEach(r => {
      const mapped = this.mapDriverRide(r, userId, reviewMap);
      const isPast = (() => {
        const tzOffset = 5.5 * 60 * 60 * 1000;
        const nowKolkata = new Date(Date.now() + tzOffset);
        const rideKolkata = new Date(r.startTime.getTime() + tzOffset);
        
        const nowYear = nowKolkata.getUTCFullYear();
        const nowMonth = nowKolkata.getUTCMonth();
        const nowDate = nowKolkata.getUTCDate();
        
        const rideYear = rideKolkata.getUTCFullYear();
        const rideMonth = rideKolkata.getUTCMonth();
        const rideDate = rideKolkata.getUTCDate();
        
        if (nowYear > rideYear) return true;
        if (nowYear < rideYear) return false;
        if (nowMonth > rideMonth) return true;
        if (nowMonth < rideMonth) return false;
        return nowDate > rideDate;
      })();
      if (r.status === 'CANCELLED' || r.status === 'COMPLETED' || isPast) {
        past.push(mapped);
      } else {
        upcoming.push(mapped);

        // Populate pending invitations for Requests tab
        r.requests.forEach(rr => {
          if (rr.status === 'REQUESTED' && rr.isInvitation === true) {
            (rr as any).ride = r;
            const mappedInvitation = this.mapReceivedRequest(rr, userId, reviewMap);
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

    // Populate pending outgoing and incoming requests for Requests tab
    riderRequests.forEach(rr => {
      const mapped = this.mapRiderRequest(rr, userId, reviewMap);
      const rideStartTime = rr.riderStartTime || rr.ride.startTime;
      const isPastStartTime = (() => {
        const tzOffset = 5.5 * 60 * 60 * 1000;
        const nowKolkata = new Date(Date.now() + tzOffset);
        const rideKolkata = new Date(rideStartTime.getTime() + tzOffset);
        
        const nowYear = nowKolkata.getUTCFullYear();
        const nowMonth = nowKolkata.getUTCMonth();
        const nowDate = nowKolkata.getUTCDate();
        
        const rideYear = rideKolkata.getUTCFullYear();
        const rideMonth = rideKolkata.getUTCMonth();
        const rideDate = rideKolkata.getUTCDate();
        
        if (nowYear > rideYear) return true;
        if (nowYear < rideYear) return false;
        if (nowMonth > rideMonth) return true;
        if (nowMonth < rideMonth) return false;
        return nowDate > rideDate;
      })();
      if (rr.status === 'REQUESTED' && !isPastStartTime && rr.ride.status !== 'CANCELLED') {
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
      }
    });

    receivedRequests.forEach(rr => {
      const isDriver = rr.ride.driverId === userId;
      const mapped = isDriver
        ? this.mapReceivedRequest(rr, userId, reviewMap)
        : this.mapRiderRequest(rr, userId, reviewMap);

      const rideStartTime = rr.riderStartTime || rr.ride.startTime;
      const isPastStartTime = (() => {
        const tzOffset = 5.5 * 60 * 60 * 1000;
        const nowKolkata = new Date(Date.now() + tzOffset);
        const rideKolkata = new Date(rideStartTime.getTime() + tzOffset);
        
        const nowYear = nowKolkata.getUTCFullYear();
        const nowMonth = nowKolkata.getUTCMonth();
        const nowDate = nowKolkata.getUTCDate();
        
        const rideYear = rideKolkata.getUTCFullYear();
        const rideMonth = rideKolkata.getUTCMonth();
        const rideDate = rideKolkata.getUTCDate();
        
        if (nowYear > rideYear) return true;
        if (nowYear < rideYear) return false;
        if (nowMonth > rideMonth) return true;
        if (nowMonth < rideMonth) return false;
        return nowDate > rideDate;
      })();
      if (rr.status === 'REQUESTED' && !isPastStartTime && rr.ride.status !== 'CANCELLED') {
        if (!requested.some(item => item.request_id === rr.id)) {
          requested.push({
            ...mapped,
            section: 'received',
            requestType: rr.ride.vehicleType === 'CAB' ? 'received_cab_share' : 'received_ride_join'
          });
        }
      }
    });

    // Deduplicate arrays by ride ID
    const seenUpcomingIds = new Set<string>();
    const uniqueUpcoming = upcoming.filter(item => {
      if (seenUpcomingIds.has(item.id)) return false;
      seenUpcomingIds.add(item.id);
      return true;
    });

    uniqueUpcoming.sort((a, b) => new Date(a.departure_time).getTime() - new Date(b.departure_time).getTime());
    past.sort((a, b) => new Date(b.departure_time).getTime() - new Date(a.departure_time).getTime());

    const totalUpcoming = uniqueUpcoming.length;
    const totalPast = past.length;
    const totalRequested = requested.length;

    let paginatedUpcoming = uniqueUpcoming;
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

  private mapDriverRide(r: any, userId: string, reviewMap?: Map<string, number>) {
    const isSeeking = r.role === 'SEEKING';
    const allRequests = [
      ...(r.requests || []),
      ...(r.requestsSent || [])
    ];
    const acceptedRequests = allRequests.filter((rr: any) =>
      rr.status === 'ACCEPTED' || rr.status === 'STARTED' || rr.status === 'COMPLETED'
    );
    const isConfirmed = acceptedRequests.length > 0;
    const acceptedReq = acceptedRequests[0];

    let peerUser: any = null;
    if (isConfirmed && acceptedReq) {
      if (acceptedReq.riderId && acceptedReq.riderId !== userId) {
        peerUser = acceptedReq.rider;
      } else if (acceptedReq.ride && acceptedReq.ride.driverId !== userId) {
        peerUser = acceptedReq.ride.driver;
      } else if (acceptedReq.requesterRide && acceptedReq.requesterRide.driverId !== userId) {
        peerUser = acceptedReq.requesterRide.driver;
      }
    }

    const chat_id = isConfirmed && peerUser ? getDeterministicChatId(userId, peerUser.id) : null;
    const peer_id = isConfirmed && peerUser ? peerUser.id : null;
    const peer_name = isConfirmed && peerUser ? peerUser.name : null;
    const peer_avatar = isConfirmed && peerUser ? peerUser.profilePic : null;
    const peer_rating = isConfirmed && peerUser ? (peerUser.rating ?? 5.0) : null;

    const isCab = r.vehicleType === 'CAB';
    const rawPrice = isConfirmed && acceptedReq ? (acceptedReq.fareCents ? acceptedReq.fareCents / 100 : r.chargeCents / 100) : r.chargeCents / 100;
    const price_per_seat = (isSeeking || isCab) ? null : rawPrice;

    const hostDriverId = r.driverId;
    const riderId = acceptedReq ? acceptedReq.riderId : (r.passengers?.[0]?.rider_id || '');
    const isInvitation = acceptedReq ? Boolean(acceptedReq.isInvitation) : false;
    const requestOtp = acceptedReq ? acceptedReq.otp : (r.passengers?.[0]?.otp || null);

    const otpRoleInfo = computeOtpRoleAndCode({
      userId,
      hostDriverId,
      riderId,
      vehicleType: r.vehicleType,
      isInvitation,
      requestOtp
    });

    return {
      id: r.id,
      request_id: acceptedReq?.id || r.requests?.[0]?.id || null,
      request_status: acceptedReq?.status || null,
      role: isSeeking ? 'rider' : 'driver',
      ride_role: isSeeking ? 'SEEKING' : 'OFFERED',
      isConfirmed,
      driver_id: r.driverId,
      driver_name: isConfirmed || r.driverId === userId ? (r.driver?.name || 'Driver') : null,
      driver_avatar: isConfirmed || r.driverId === userId ? (r.driver?.profilePic || null) : null,
      driver_gender: isConfirmed || r.driverId === userId ? (r.driver?.gender || null) : null,
      driver_rating: isConfirmed || r.driverId === userId ? (r.driver?.rating ?? 5.0) : null,
      origin: r.startPlaceName,
      destination: r.endPlaceName,
      departure_time: r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat,
      status: r.status,
      vehicle_type: r.vehicleType,
      passengers: isConfirmed ? acceptedRequests.map((rr: any) => {
        const passengerUser = (rr.riderId !== userId ? rr.rider : null) || (rr.ride?.driverId !== userId ? rr.ride?.driver : null) || (rr.requesterRide?.driverId !== userId ? rr.requesterRide?.driver : null);
        return {
          request_id: rr.id,
          rider_id: passengerUser?.id || rr.riderId,
          rider_name: passengerUser?.name || 'Passenger',
          rider_avatar: passengerUser?.profilePic || null,
          rider_rating: passengerUser?.rating ?? 5.0,
          status: rr.status,
          chat_id: getDeterministicChatId(userId, passengerUser?.id || rr.riderId),
          seats: rr.seats,
          my_review_rating: reviewMap ? (reviewMap.get(`${r.id}:${passengerUser?.id || rr.riderId}`) || null) : null,
          otp: rr.otp,
          otp_verified: rr.otpVerified || false,
          actual_fare: rr.actualFare,
          rider_share: rr.riderShare,
          driver_share: rr.driverShare,
        };
      }) : [],
      chat_id,
      peer_id,
      peer_name,
      peer_avatar,
      peer_rating,
      can_enter_otp: otpRoleInfo.can_enter_otp,
      my_display_otp: otpRoleInfo.my_display_otp,
      otp: otpRoleInfo.my_display_otp,
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
        return existingRide;
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
                  r."routeLine"::geometry,
                  LEAST(
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)),
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${endWkt}), 4326))
                  ),
                  GREATEST(
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${startWkt}), 4326)),
                    ST_LineLocatePoint(r."routeLine"::geometry, ST_SetSRID(ST_GeomFromText(${endWkt}), 4326))
                  )
                )::geography
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

    const riderStartTime = body.riderStartTime ? new Date(body.riderStartTime) : ride.startTime;
    const startName = body.riderStartName || ride.startPlaceName;
    const endName = body.riderEndName || ride.endPlaceName;

    // Auto-post / ensure a seeking Ride entry for the passenger in the Ride table
    let existingRiderRide = await this.prisma.ride.findFirst({
      where: {
        driverId: userId,
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
      riderRideId = generateDeterministicId('ride', [userId, startName, endName, riderStartTime.toISOString()]);
      await this.prisma.ride.create({
        data: {
          id: riderRideId,
          driverId: userId,
          role: 'SEEKING',
          seatsAvailable: 1,
          chargeCents: calculatedFareCents,
          startTime: riderStartTime,
          endTime: new Date(riderStartTime.getTime() + 60 * 60 * 1000),
          startPlaceName: startName,
          endPlaceName: endName,
          status: RideStatus.OPEN,
          vehicleType: ride.vehicleType || 'CAR',
        }
      });
      if (body.riderStartCoords && body.riderEndCoords) {
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "Ride"
          SET "startPoint" = ST_SetSRID(ST_MakePoint(${body.riderStartCoords[0]}, ${body.riderStartCoords[1]}), 4326),
              "endPoint" = ST_SetSRID(ST_MakePoint(${body.riderEndCoords[0]}, ${body.riderEndCoords[1]}), 4326)
          WHERE id = ${riderRideId}
        `);
      }
    }

    const requestId = await this.prisma.rideRequest.create({
      data: {
        id: randomUUID(),
        rideId: ride.id,
        requesterRideId: riderRideId,
        riderId: userId,
        riderStartName: startName,
        riderEndName: endName,
        riderStartTime: riderStartTime,
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
      const fareAmt = Math.round((calculatedFareCents || 1000) / 100);
      const payloadData = {
        id: requestId.id,
        rideId: ride.id,
        riderName: requestId.rider.name,
        riderStartName: requestId.riderStartName,
        riderEndName: requestId.riderEndName,
        riderStartTime: requestId.riderStartTime,
        status: requestId.status,
        fareCents: calculatedFareCents,
        fareAmount: fareAmt,
        peerRole: 'SEEKER',
        peerUser: {
          id: requestId.rider.id,
          name: requestId.rider.name,
          profilePic: requestId.rider.profilePic,
          rating: requestId.rider.rating
        }
      };
      await this.chatService.sendNotificationToUser(
        ride.driverId,
        'New Booking Request',
        `${requestId.rider.name} requested to join your ride. Earnings: ₹${fareAmt}`,
        'new_ride_request',
        payloadData
      );
    } catch (e) {
      console.error('Failed to send notification to driver:', ride.driverId, e);
    }

    return { ok: true, chat_id: getDeterministicChatId(ride.driverId, userId) };
  }

  private mapRiderRequest(rr: any, userId: string, reviewMap?: Map<string, number>) {
    const r = rr.ride;
    const isConfirmed = rr.status === 'ACCEPTED' || rr.status === 'STARTED' || rr.status === 'COMPLETED';
    const isSeekingMatch = r.role === 'SEEKING' || r.vehicleType === 'CAB';

    // Target user (host driver) details for sent requests in Requests tab
    const driver_name = r.driver?.name || 'Driver';
    const driver_avatar = r.driver?.profilePic || null;
    const driver_rating = r.driver?.rating ?? 5.0;
    const peer_id = r.driverId;
    const peer_name = driver_name;
    const peer_avatar = driver_avatar;
    const peer_rating = driver_rating;

    // Price protection: Cab share & seeking matches have NO price info
    const rawPrice = rr.fareCents ? rr.fareCents / 100 : r.chargeCents / 100;
    const price_per_seat = isSeekingMatch ? null : rawPrice;

    const hostDriverId = r.driverId;
    const riderId = rr.riderId;
    const isInvitation = Boolean(rr.isInvitation);
    const requestOtp = rr.otp;

    const otpRoleInfo = computeOtpRoleAndCode({
      userId,
      hostDriverId,
      riderId,
      vehicleType: r.vehicleType,
      isInvitation,
      requestOtp
    });

    return {
      id: r.id,
      request_id: rr.id,
      role: 'rider',
      ride_role: r.role || 'OFFERED',
      isConfirmed,
      request_status: rr.status,
      driver_id: r.driverId,
      driver_name,
      driver_avatar,
      driver_gender: isConfirmed ? (r.driver?.gender || null) : null,
      driver_rating,
      origin: rr.riderStartName || r.startPlaceName,
      destination: rr.riderEndName || r.endPlaceName,
      departure_time: rr.riderStartTime?.toISOString() || r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat,
      status: r.status,
      vehicle_type: r.vehicleType,
      chat_id: getDeterministicChatId(r.driverId, rr.riderId),
      peer_id,
      peer_name,
      peer_avatar,
      peer_rating,
      is_invitation: rr.isInvitation || false,
      my_review_rating: reviewMap ? (reviewMap.get(`${r.id}:${r.driverId}`) || null) : null,
      otp: otpRoleInfo.my_display_otp,
      otp_verified: rr.otpVerified || false,
      actual_fare: rr.actualFare,
      rider_share: rr.riderShare,
      driver_share: rr.driverShare,
      buddyRequestId: rr.buddyRequestId,
      can_enter_otp: otpRoleInfo.can_enter_otp,
      my_display_otp: otpRoleInfo.my_display_otp,
    };
  }

  private mapReceivedRequest(rr: any, userId: string, reviewMap?: Map<string, number>) {
    const r = rr.ride;
    const isConfirmed = rr.status === 'ACCEPTED' || rr.status === 'STARTED' || rr.status === 'COMPLETED';
    const isSeekingMatch = r.role === 'SEEKING' || r.vehicleType === 'CAB';

    // Requester/Peer details shown in Requests tab so user knows who requested
    const peer_id = rr.riderId;
    const peer_name = rr.rider?.name || 'Passenger';
    const peer_avatar = rr.rider?.profilePic || null;
    const peer_rating = rr.rider?.rating ?? 5.0;

    // Price protection: Seeking matches & Cab share have NO price info
    const rawPrice = rr.fareCents ? rr.fareCents / 100 : r.chargeCents / 100;
    const price_per_seat = isSeekingMatch ? null : rawPrice;

    const hostDriverId = r.driverId;
    const riderId = rr.riderId;
    const isInvitation = Boolean(rr.isInvitation);
    const requestOtp = rr.otp;

    const otpRoleInfo = computeOtpRoleAndCode({
      userId,
      hostDriverId,
      riderId,
      vehicleType: r.vehicleType,
      isInvitation,
      requestOtp
    });

    return {
      id: r.id,
      request_id: rr.id,
      role: 'driver',
      ride_role: r.role || 'OFFERED',
      isConfirmed,
      rider_id: rr.riderId,
      request_status: rr.status,
      driver_id: r.driverId,
      driver_name: isConfirmed ? (r.driver?.name || 'Driver') : null,
      driver_avatar: isConfirmed ? (r.driver?.profilePic || null) : null,
      driver_gender: isConfirmed ? (r.driver?.gender || null) : null,
      driver_rating: isConfirmed ? (r.driver?.rating ?? 5.0) : null,
      origin: rr.riderStartName || r.startPlaceName,
      destination: rr.riderEndName || r.endPlaceName,
      departure_time: rr.riderStartTime?.toISOString() || r.startTime.toISOString(),
      seats_available: r.seatsAvailable,
      price_per_seat,
      status: r.status,
      vehicle_type: r.vehicleType,
      chat_id: getDeterministicChatId(r.driverId, rr.riderId),
      peer_id,
      peer_name,
      peer_avatar,
      peer_rating,
      is_invitation: rr.isInvitation || false,
      my_review_rating: reviewMap ? (reviewMap.get(`${r.id}:${rr.riderId}`) || null) : null,
      otp: otpRoleInfo.my_display_otp,
      otp_verified: rr.otpVerified || false,
      actual_fare: rr.actualFare,
      rider_share: rr.riderShare,
      driver_share: rr.driverShare,
      buddyRequestId: rr.buddyRequestId,
      can_enter_otp: otpRoleInfo.can_enter_otp,
      my_display_otp: otpRoleInfo.my_display_otp,
    };
  }

  async createRecurringSchedule(dto: CreateRecurringRideDto, driverId: string) {
    const startWkt = pointWkt(dto.start);
    const endWkt = pointWkt(dto.end);
    const routeWkt = lineStringWkt(dto.route);

    const userVehicle = await this.prisma.vehicle.findUnique({
      where: { userId: driverId }
    });

    const vehicleType = dto.vehicleType || userVehicle?.type || 'CAR';
    const vehicleCapacity = dto.vehicleCapacity || userVehicle?.capacity || 5;
    const fuelType = dto.fuelType || userVehicle?.fuelType || 'Petrol';
    const vehicleNumber = dto.vehicleNumber || userVehicle?.vehicleNumber || '';

    const id = randomUUID();

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "RecurringRideSchedule" (
        "id", "updatedAt", "driverId", "seatsAvailable", "chargeCents",
        "daysOfWeek", "timeOfDay", "durationMinutes", "startDate", "endDate",
        "startPlaceName", "endPlaceName", "vehicleType", "vehicleCapacity", "fuelType", "vehicleNumber",
        "startPoint", "endPoint", "routeLine"
      ) VALUES (
        ${id}, NOW(), ${driverId}, ${dto.seatsAvailable}, ${dto.chargeCents},
        ${dto.daysOfWeek}, ${dto.timeOfDay}, ${dto.durationMinutes || 60}, ${new Date(dto.startDate)}, ${dto.endDate ? new Date(dto.endDate) : null},
        ${dto.startPlaceName}, ${dto.endPlaceName}, ${vehicleType}, ${vehicleCapacity}, ${fuelType}, ${vehicleNumber},
        ST_SetSRID(ST_GeomFromText(${startWkt}), 4326),
        ST_SetSRID(ST_GeomFromText(${endWkt}), 4326),
        ST_SetSRID(ST_GeomFromText(${routeWkt}), 4326)
      )
    `);

    const result = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT 
        "id", "driverId", "seatsAvailable", "chargeCents", "daysOfWeek", "timeOfDay", "durationMinutes", "startDate", "endDate",
        "startPlaceName", "endPlaceName", "vehicleType", "vehicleCapacity", "fuelType", "vehicleNumber",
        ST_AsGeoJSON("startPoint") as "startPointGeoJson",
        ST_AsGeoJSON("endPoint") as "endPointGeoJson",
        ST_AsGeoJSON("routeLine") as "routeGeoJson"
      FROM "RecurringRideSchedule"
      WHERE id = ${id}
    `);

    return result[0];
  }

  async getRecurringSchedules(driverId: string) {
    return this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT 
        "id", "driverId", "seatsAvailable", "chargeCents", "daysOfWeek", "timeOfDay", "durationMinutes", "startDate", "endDate",
        "startPlaceName", "endPlaceName", "vehicleType", "vehicleCapacity", "fuelType", "vehicleNumber",
        ST_AsGeoJSON("startPoint") as "startPointGeoJson",
        ST_AsGeoJSON("endPoint") as "endPointGeoJson",
        ST_AsGeoJSON("routeLine") as "routeGeoJson"
      FROM "RecurringRideSchedule"
      WHERE "driverId" = ${driverId}
      ORDER BY "createdAt" DESC
    `);
  }

  async updateRecurringSchedule(id: string, driverId: string, updates: { daysOfWeek?: number[]; timeOfDay?: string; seatsAvailable?: number; chargeCents?: number; isActive?: boolean }) {
    const existing = await this.prisma.recurringRideSchedule.findFirst({
      where: { id, driverId }
    });
    if (!existing) {
      throw new NotFoundException('Recurring schedule not found or access denied');
    }

    const dataToUpdate: any = {};
    if (updates.daysOfWeek) dataToUpdate.daysOfWeek = updates.daysOfWeek;
    if (updates.timeOfDay) dataToUpdate.timeOfDay = updates.timeOfDay;
    if (updates.seatsAvailable !== undefined) dataToUpdate.seatsAvailable = updates.seatsAvailable;
    if (updates.chargeCents !== undefined) dataToUpdate.chargeCents = updates.chargeCents;

    if (updates.isActive !== undefined) {
      if (updates.isActive) {
        dataToUpdate.endDate = null;
      } else {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        dataToUpdate.endDate = yesterday;
      }
    }

    const updated = await this.prisma.recurringRideSchedule.update({
      where: { id },
      data: dataToUpdate
    });

    if (updates.isActive) {
      await this.materializeRecurringRides(1).catch(() => {});
    }

    return updated;
  }

  async deleteRecurringSchedule(id: string, driverId: string) {
    const existing = await this.prisma.recurringRideSchedule.findFirst({
      where: { id, driverId }
    });
    if (!existing) {
      throw new NotFoundException('Recurring schedule not found or access denied');
    }
    return this.prisma.recurringRideSchedule.delete({
      where: { id }
    });
  }

  async materializeRecurringRides(daysAhead: number = 7) {
    const schedules = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT 
        "id", "driverId", "seatsAvailable", "chargeCents", "daysOfWeek", "timeOfDay", "durationMinutes", "startDate", "endDate",
        "startPlaceName", "endPlaceName", "vehicleType", "vehicleCapacity", "fuelType", "vehicleNumber",
        ST_AsText("startPoint") as "startPointWkt",
        ST_AsText("endPoint") as "endPointWkt",
        ST_AsText("routeLine") as "routeLineWkt"
      FROM "RecurringRideSchedule"
    `);

    const createdRides: string[] = [];
    const now = new Date();

    for (let i = 0; i < daysAhead; i++) {
      const targetDate = new Date();
      targetDate.setDate(now.getDate() + i);
      const targetDayOfWeek = targetDate.getDay(); // 0-6

      for (const schedule of schedules) {
        // Check if schedule is active
        const startDate = new Date(schedule.startDate);
        const endDate = schedule.endDate ? new Date(schedule.endDate) : null;
        if (targetDate < startDate || (endDate && targetDate > endDate)) {
          continue;
        }

        // Check if daysOfWeek matches
        if (!schedule.daysOfWeek.includes(targetDayOfWeek)) {
          continue;
        }

        // Parse timeOfDay "HH:MM"
        const [hoursStr, minutesStr] = schedule.timeOfDay.split(':');
        const hours = parseInt(hoursStr, 10);
        const minutes = parseInt(minutesStr, 10);

        // Construct start and end times in local time (+05:30)
        const year = targetDate.getFullYear();
        const month = String(targetDate.getMonth() + 1).padStart(2, '0');
        const day = String(targetDate.getDate()).padStart(2, '0');
        
        const startTime = new Date(`${year}-${month}-${day}T${schedule.timeOfDay}:00+05:30`);
        const endTime = new Date(startTime.getTime() + schedule.durationMinutes * 60 * 1000);

        // Deterministic ID to avoid duplicates
        const rideId = generateDeterministicId('ride', [
          schedule.driverId,
          schedule.startPlaceName,
          schedule.endPlaceName,
          startTime.toISOString()
        ]);

        // Check if ride already exists
        const existingRide = await this.prisma.ride.findUnique({
          where: { id: rideId }
        });

        if (!existingRide) {
          await this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO "Ride" (
              "id", "updatedAt", "driverId", "seatsAvailable", "chargeCents", "startTime", "endTime",
              "startPlaceName", "endPlaceName", "status", "vehicleType", "vehicleCapacity", "fuelType", "vehicleNumber",
              "startPoint", "endPoint", "routeLine"
            ) VALUES (
              ${rideId}, NOW(), ${schedule.driverId}, ${schedule.seatsAvailable}, ${schedule.chargeCents}, ${startTime}, ${endTime},
              ${schedule.startPlaceName}, ${schedule.endPlaceName}, 'OPEN'::"RideStatus", ${schedule.vehicleType}, ${schedule.vehicleCapacity}, ${schedule.fuelType}, ${schedule.vehicleNumber},
              ST_SetSRID(ST_GeomFromText(${schedule.startPointWkt}), 4326),
              ST_SetSRID(ST_GeomFromText(${schedule.endPointWkt}), 4326),
              ST_SetSRID(ST_GeomFromText(${schedule.routeLineWkt}), 4326)
            )
          `);
          createdRides.push(rideId);
        }
      }
    }

    return {
      message: `Successfully materialized recurring rides for the next ${daysAhead} days.`,
      createdCount: createdRides.length,
      rideIds: createdRides
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyRecurringRideCron() {
    this.logger.log('Running nightly recurring ride materialization cron job...');
    const result = await this.materializeRecurringRides(1);
    this.logger.log(`Nightly cron finished: ${result.createdCount} rides materialized.`);
  }
}
