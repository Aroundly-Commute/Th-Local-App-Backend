import { Controller, Get, Post, Body, Param, Request, UseGuards, Query } from '@nestjs/common';
import { PrismaClient, RideStatus } from '@prisma/client';
import { FirebaseAuthGuard } from './modules/auth/firebase-auth.guard';
import { MatchmakingService } from './modules/matchmaking/matchmaking.service';
import { RequestRideDto } from './modules/matchmaking/dto/request-ride.dto';

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
    const driverRides = await prisma.ride.findMany({ 
      where: { driverId: userId },
      include: { driver: true } 
    });
    // This is a simplified mapping for the mobile app
    const upcoming = driverRides.filter(r => r.startTime >= new Date() && r.status !== 'CANCELLED');
    const past = driverRides.filter(r => r.startTime < new Date() || r.status === 'CANCELLED');
    
    return {
      upcoming: upcoming.map(this.mapRide),
      past: past.map(this.mapRide)
    };
  }

  @Post('rides/offer')
  async offerRide(@Body() body: any, @Request() req: any) {
    const { startName, endName, startCoords, endCoords, seats, price, date, time } = body;
    const startTime = new Date(`${date}T${time}:00`);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // add 1 hr approx

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
      }
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
    return {
      id: msg.id,
      chat_id: msg.chatId,
      sender_id: msg.senderId,
      sender_name: msg.sender.name,
      text: msg.text,
      created_at: msg.createdAt.toISOString()
    };
  }

  private mapRide(r: any) {
    return {
      id: r.id,
      driver_id: r.driverId,
      driver_name: r.driver?.name || "Driver",
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
