import { Controller, Get, Post, Body, Param, Request, UseGuards, Query } from '@nestjs/common';
import { PrismaClient, RideStatus } from '@prisma/client';
import { FirebaseAuthGuard } from './modules/auth/firebase-auth.guard';
import { MatchmakingService } from './modules/matchmaking/matchmaking.service';
import { RequestRideDto } from './modules/matchmaking/dto/request-ride.dto';
import { broadcastToChat, notifyUserWs } from './chat.ws';

const prisma = new PrismaClient();
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';

@Controller()
@UseGuards(FirebaseAuthGuard)
export class AliasController {
  constructor(private readonly mm: MatchmakingService) {}

  @Get('sustainability/me')
  async getSustainability(@Request() req: any) {
    const userId = req.user.id;
    // Calculate dynamically from the user's rides
    const ridesAsDriver = await prisma.ride.findMany({ where: { driverId: userId } });
    const requestsAsRider = await prisma.rideRequest.findMany({ 
      where: { riderId: userId, status: RideStatus.ACCEPTED },
      include: { ride: true }
    });

    const rides_count = ridesAsDriver.length + requestsAsRider.length;
    // Assume 2.5kg CO2 and $15 saved per ride on average
    const co2_saved_kg = rides_count * 2.5;
    const money_saved = rides_count * 15.0;
    const trees_equivalent = co2_saved_kg / 21; // roughly 21kg per tree

    // Filter this month
    const now = new Date();
    const thisMonthDriver = ridesAsDriver.filter(r => r.createdAt.getMonth() === now.getMonth() && r.createdAt.getFullYear() === now.getFullYear());
    const thisMonthRider = requestsAsRider.filter(r => r.createdAt.getMonth() === now.getMonth() && r.createdAt.getFullYear() === now.getFullYear());
    
    const thisMonthCount = thisMonthDriver.length + thisMonthRider.length;

    return {
      money_saved,
      co2_saved_kg,
      rides_count,
      trees_equivalent,
      this_month: {
        money_saved: thisMonthCount * 15.0,
        co2_saved_kg: thisMonthCount * 2.5,
        rides_count: thisMonthCount
      }
    };
  }

  @Get('locations/suggest')
  async suggestLocations(@Query('q') q: string) {
    if (!MAPBOX_TOKEN || !q || q.length < 3) return [];
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${MAPBOX_TOKEN}&limit=5&types=place,address,poi&country=in&proximity=77.3910,28.5355`;
      const response = await fetch(url);
      const data = await response.json();
      const features = data.features || [];
      return features.map((f: any) => ({
        id: f.id,
        place_name: f.place_name,
        center: f.center,
      }));
    } catch (e) {
      return [];
    }
  }

  @Get('rides/my')
  async getMyRides(@Request() req: any) {
    const userId = req.user.id;

    // 1. Rides user is DRIVING
    const driverRides = await prisma.ride.findMany({ 
      where: { driverId: userId },
      include: { 
        driver: true,
        requests: { include: { rider: true } }
      } 
    });

    // 2. Ride requests user made as RIDER (all statuses)
    const riderRequests = await prisma.rideRequest.findMany({
      where: { riderId: userId },
      include: { ride: { include: { driver: true } } }
    });

    const upcoming: any[] = [];
    const past: any[] = [];
    const requested: any[] = [];

    // Process driver rides
    driverRides.forEach(r => {
      const mapped = this.mapDriverRide(r, userId);
      if (r.status === 'CANCELLED' || r.startTime < new Date()) {
        past.push(mapped);
      } else {
        upcoming.push(mapped);
      }
    });

    // Process rider requests
    riderRequests.forEach(rr => {
      const mapped = this.mapRiderRequest(rr);
      if (rr.status === 'ACCEPTED') {
        if (rr.ride.startTime >= new Date() && rr.ride.status !== 'CANCELLED') {
          upcoming.push(mapped);
        } else {
          past.push(mapped);
        }
      } else if (rr.status === 'REQUESTED') {
        requested.push(mapped);
      } else if (rr.status === 'REJECTED' || rr.status === 'CANCELLED') {
        past.push(mapped);
      }
    });

    upcoming.sort((a, b) => new Date(a.departure_time).getTime() - new Date(b.departure_time).getTime());
    past.sort((a, b) => new Date(b.departure_time).getTime() - new Date(a.departure_time).getTime());

    return { upcoming, past, requested };
  }

  @Post('rides/offer')
  async offerRide(@Body() body: any, @Request() req: any) {
    const { startName, endName, startCoords, endCoords, seats, price, date, time } = body;
    const startTime = new Date(`${date}T${time}:00`);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // add 1 hr approx

    const overlappingDriver = await prisma.ride.findFirst({
       where: {
         driverId: req.user.id,
         status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         startTime: { lt: endTime },
         endTime: { gt: startTime }
       }
    });
    if (overlappingDriver) throw new Error('You already have a published ride during this time window.');

    const overlappingRider = await prisma.rideRequest.findFirst({
       where: {
         riderId: req.user.id,
         status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         ride: {
           startTime: { lt: endTime },
           endTime: { gt: startTime }
         }
       }
    });
    if (overlappingRider) throw new Error('You already have a requested ride during this time window.');

    const ride = await prisma.ride.create({
      data: {
        driverId: req.user.id,
        seatsAvailable: seats || 3,
        chargeCents: (price || 10) * 100,
        startTime,
        endTime,
        startPlaceName: startName,
        endPlaceName: endName,
        status: RideStatus.OPEN,
      }
    });

    if (startCoords && startCoords.length === 2 && endCoords && endCoords.length === 2) {
      const { Prisma } = require('@prisma/client');
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "Ride"
        SET "startPoint" = ST_SetSRID(ST_MakePoint(${startCoords[0]}, ${startCoords[1]}), 4326),
            "endPoint" = ST_SetSRID(ST_MakePoint(${endCoords[0]}, ${endCoords[1]}), 4326)
        WHERE id = ${ride.id}
      `);
    }

    return ride;
  }

  @Post('rides/:id/book')
  async bookRide(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    // The mobile app doesn't send coordinates for booking currently, just seats: 1
    // Carpool requires start/end coordinates. We will fetch the ride's start/end as a fallback.
    const ride = await prisma.ride.findUnique({ where: { id } });
    if (!ride) throw new Error('Ride not found');

    if (ride.driverId === req.user.id) {
        throw new Error('Cannot book your own ride');
    }

    const overlappingDriver = await prisma.ride.findFirst({
       where: {
         driverId: req.user.id,
         status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         startTime: { lt: ride.endTime },
         endTime: { gt: ride.startTime }
       }
    });
    if (overlappingDriver) throw new Error('You have a published ride overlapping with this time window.');

    const overlappingRider = await prisma.rideRequest.findFirst({
       where: {
         riderId: req.user.id,
         status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED] },
         ride: {
           startTime: { lt: ride.endTime },
           endTime: { gt: ride.startTime }
         }
       }
    });
    if (overlappingRider) throw new Error('You already have a requested ride overlapping with this time window.');

    // Extract lat/lng from PostGIS is hard here without raw query. 
    // We will just do a dummy request or simple insert to make the app happy.
    const requestId = await prisma.rideRequest.create({
      data: {
        rideId: id,
        riderId: req.user.id,
        riderStartName: ride.startPlaceName,
        riderEndName: ride.endPlaceName,
        riderStartTime: ride.startTime,
        status: RideStatus.REQUESTED
      },
      include: {
        rider: true,
      }
    });

    notifyUserWs(ride.driverId, 'new_ride_request', {
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

  // ========== Chats ==========
  @Get('chats')
  async listChats(@Request() req: any) {
    const userId = req.user.id;
    // Find unique chatIds where user participated
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: userId },
          { chatId: { contains: userId } } // Simplified logic
        ]
      },
      orderBy: { createdAt: 'desc' },
      distinct: ['chatId'],
      include: { sender: true }
    });

    return messages.map(m => ({
      chat_id: m.chatId,
      last_message: m.text,
      last_time: m.createdAt.toISOString(),
      other_user: {
        id: m.senderId === userId ? "other" : m.senderId,
        name: m.senderId === userId ? "Someone" : m.sender.name,
      },
      ride_route: "Ride Chat"
    }));
  }

  @Get('chats/:chat_id/messages')
  async getMessages(@Param('chat_id') chatId: string) {
    const msgs = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
      include: { sender: true }
    });
    return msgs.map(m => ({
      id: m.id,
      chat_id: m.chatId,
      sender_id: m.senderId,
      sender_name: m.sender.name,
      text: m.text,
      created_at: m.createdAt.toISOString()
    }));
  }

  @Post('chats/:chat_id/messages')
  async postMessage(@Param('chat_id') chatId: string, @Body() body: any, @Request() req: any) {
    const msg = await prisma.message.create({
      data: {
        chatId,
        senderId: req.user.id,
        text: body.text
      },
      include: { sender: true }
    });
    
    const responseData = {
      id: msg.id,
      chat_id: msg.chatId,
      sender_id: msg.senderId,
      sender_name: msg.sender.name,
      text: msg.text,
      created_at: msg.createdAt.toISOString()
    };
    
    broadcastToChat(chatId, responseData);
    
    return responseData;
  }

  // Map a ride where current user is the DRIVER
  private mapDriverRide(r: any, userId: string) {
    // Find accepted/requested passengers
    const acceptedPassengers = (r.requests || []).filter((rr: any) =>
      rr.status === 'ACCEPTED' || rr.status === 'REQUESTED'
    );
    const firstPassenger = acceptedPassengers[0];
    // chat_id uses the request id so each rider<->driver pair has a unique chat
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

  // Map a ride request where current user is the RIDER
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

  // Legacy mapRide (kept for backward compat)
  private mapRide(r: any) {
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
      status: r.status
    };
  }
}
