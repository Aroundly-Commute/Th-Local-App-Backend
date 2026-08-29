import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { GeocodingService } from './geocoding.service';
import { MatchmakingService } from '../matchmaking/matchmaking.service';
import { RidesService } from '../rides/rides.service';
import { RideStatus } from '@prisma/client';

export enum BotStep {
  IDLE = 'IDLE',
  // Search Flow
  SEARCH_ORIGIN = 'SEARCH_ORIGIN',
  SEARCH_DEST = 'SEARCH_DEST',
  SEARCH_TIME = 'SEARCH_TIME',
  // Offer Ride Flow
  OFFER_ORIGIN = 'OFFER_ORIGIN',
  OFFER_DEST = 'OFFER_DEST',
  OFFER_TIME = 'OFFER_TIME',
  OFFER_SEATS = 'OFFER_SEATS',
  OFFER_PRICE = 'OFFER_PRICE',
}

@Injectable()
export class WhatsAppBotService {
  private readonly logger = new Logger(WhatsAppBotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly waService: WhatsAppService,
    private readonly geocoding: GeocodingService,
    private readonly matchmaking: MatchmakingService,
    private readonly ridesService: RidesService,
  ) {}

  /**
   * Get or create a Prisma User associated with this WhatsApp phone number
   */
  async getOrCreateUser(phoneNumber: string, profileName?: string) {
    const cleanPhone = this.waService.sanitizePhoneNumber(phoneNumber);
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phoneNumber: cleanPhone },
          { phoneNumber: `+${cleanPhone}` },
        ],
      },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phoneNumber: cleanPhone,
          name: profileName || 'WhatsApp User',
          firebaseUid: `wa_${cleanPhone}_${Date.now()}`,
          role: 'passenger',
        },
      });
      this.logger.log(`Created new user from WhatsApp: ${user.id} (${cleanPhone})`);
    }

    return user;
  }

  /**
   * Get current session or create default IDLE session
   */
  async getSession(phoneNumber: string, userId: string) {
    const cleanPhone = this.waService.sanitizePhoneNumber(phoneNumber);
    let session = await this.prisma.whatsAppSession.findUnique({
      where: { phoneNumber: cleanPhone },
    });

    if (!session) {
      session = await this.prisma.whatsAppSession.create({
        data: {
          phoneNumber: cleanPhone,
          userId,
          step: BotStep.IDLE,
          payload: {},
        },
      });
    }

    return session;
  }

  /**
   * Update session state and payload
   */
  async updateSession(phoneNumber: string, step: BotStep, payload: any = {}) {
    const cleanPhone = this.waService.sanitizePhoneNumber(phoneNumber);
    return this.prisma.whatsAppSession.upsert({
      where: { phoneNumber: cleanPhone },
      update: { step, payload, updatedAt: new Date() },
      create: { phoneNumber: cleanPhone, step, payload },
    });
  }

  /**
   * Reset session to IDLE
   */
  async resetSession(phoneNumber: string) {
    return this.updateSession(phoneNumber, BotStep.IDLE, {});
  }

  /**
   * Main Router for incoming WhatsApp messages
   */
  async processIncomingMessage(incoming: {
    from: string;
    name?: string;
    type: string;
    text?: string;
    location?: { latitude: number; longitude: number; name?: string; address?: string };
    buttonReplyId?: string;
    listReplyId?: string;
  }) {
    const from = incoming.from;
    const user = await this.getOrCreateUser(from, incoming.name);
    const session = await this.getSession(from, user.id);
    const text = (incoming.text || '').trim();
    const actionId = incoming.buttonReplyId || incoming.listReplyId || '';

    this.logger.log(
      `[WhatsApp] From: ${from} (${user.name}) | Step: ${session.step} | Type: ${incoming.type} | Text: "${text}" | Action: "${actionId}"`
    );

    // Global Commands (reset to menu if user types menu / cancel / hi)
    const lowerText = text.toLowerCase();
    if (['hi', 'hello', 'hey', 'menu', 'start', 'help', 'cancel', 'exit'].includes(lowerText) && !actionId) {
      await this.resetSession(from);
      return this.sendMainMenu(from, user.name);
    }

    // Handle Quick Action Buttons
    if (actionId === 'ACTION_FIND_RIDE') {
      await this.updateSession(from, BotStep.SEARCH_ORIGIN, {});
      return this.waService.sendLocationPrompt(
        from,
        `📍 *Where are you starting from?*\n\nType your pickup location or send a WhatsApp location pin.`
      );
    }

    if (actionId === 'ACTION_OFFER_RIDE') {
      await this.updateSession(from, BotStep.OFFER_ORIGIN, {});
      return this.waService.sendLocationPrompt(
        from,
        `🚗 *Offer a Ride*\n\nWhere will you start driving from? (Type pickup address or send location pin)`
      );
    }

    if (actionId === 'ACTION_MY_RIDES') {
      return this.handleMyRides(from, user.id);
    }

    if (actionId.startsWith('BOOK_RIDE_')) {
      const rideId = actionId.replace('BOOK_RIDE_', '');
      return this.handleBookRideSelection(from, user.id, rideId, session.payload);
    }

    if (actionId === 'TIME_NOW') {
      return this.handleSearchTimeInput(from, user.id, session.payload, new Date());
    }

    // Dispatch by State Machine Step
    switch (session.step as BotStep) {
      case BotStep.SEARCH_ORIGIN:
        return this.handleSearchOrigin(from, incoming, session.payload);

      case BotStep.SEARCH_DEST:
        return this.handleSearchDest(from, incoming, session.payload);

      case BotStep.SEARCH_TIME:
        return this.handleSearchTime(from, user.id, text, session.payload);

      case BotStep.OFFER_ORIGIN:
        return this.handleOfferOrigin(from, incoming, session.payload);

      case BotStep.OFFER_DEST:
        return this.handleOfferDest(from, incoming, session.payload);

      case BotStep.OFFER_TIME:
        return this.handleOfferTime(from, text, session.payload);

      case BotStep.OFFER_SEATS:
        return this.handleOfferSeats(from, text, session.payload);

      case BotStep.OFFER_PRICE:
        return this.handleOfferPrice(from, user.id, text, session.payload);

      default:
        await this.resetSession(from);
        return this.sendMainMenu(from, user.name);
    }
  }

  /**
   * Send Main Interactive Menu
   */
  async sendMainMenu(to: string, userName?: string) {
    const welcome = userName ? `Hello *${userName}*! 👋` : 'Hello! 👋';
    const message = `${welcome}\n\nWelcome to *The34 Carpool & Ride Share*.\nFind or share rides with verified commuters instantly.\n\nWhat would you like to do?`;
    
    return this.waService.sendButtons(
      to,
      message,
      [
        { id: 'ACTION_FIND_RIDE', title: '🔍 Find a Ride' },
        { id: 'ACTION_OFFER_RIDE', title: '🚗 Offer a Ride' },
        { id: 'ACTION_MY_RIDES', title: '📋 My Bookings' },
      ],
      '🚗 The34 Ride Sharing'
    );
  }

  // ==========================================
  // RIDER SEARCH FLOW
  // ==========================================

  private async handleSearchOrigin(to: string, incoming: any, draftPayload: any) {
    let startPoint: { lat: number; lng: number; name: string } | null = null;

    if (incoming.location) {
      const reverseName = await this.geocoding.reverseGeocode(incoming.location.latitude, incoming.location.longitude);
      startPoint = {
        lat: incoming.location.latitude,
        lng: incoming.location.longitude,
        name: incoming.location.name || reverseName,
      };
    } else if (incoming.text) {
      const geo = await this.geocoding.geocode(incoming.text);
      if (geo) {
        startPoint = { lat: geo.lat, lng: geo.lng, name: geo.formattedAddress };
      }
    }

    if (!startPoint) {
      return this.waService.sendText(
        to,
        `⚠️ Could not find that pickup location. Please type a specific area/landmark (e.g. "Koramangala 5th Block, Bengaluru") or send a Location pin.`
      );
    }

    const payload = { ...draftPayload, start: startPoint };
    await this.updateSession(to, BotStep.SEARCH_DEST, payload);

    return this.waService.sendLocationPrompt(
      to,
      `✅ *Pickup:* ${startPoint.name}\n\n🏁 *Where is your destination?*\n(Type destination address or send a location pin)`
    );
  }

  private async handleSearchDest(to: string, incoming: any, draftPayload: any) {
    let endPoint: { lat: number; lng: number; name: string } | null = null;

    if (incoming.location) {
      const reverseName = await this.geocoding.reverseGeocode(incoming.location.latitude, incoming.location.longitude);
      endPoint = {
        lat: incoming.location.latitude,
        lng: incoming.location.longitude,
        name: incoming.location.name || reverseName,
      };
    } else if (incoming.text) {
      const geo = await this.geocoding.geocode(incoming.text);
      if (geo) {
        endPoint = { lat: geo.lat, lng: geo.lng, name: geo.formattedAddress };
      }
    }

    if (!endPoint) {
      return this.waService.sendText(
        to,
        `⚠️ Could not find that destination location. Please type a more specific address or send a Location pin.`
      );
    }

    const payload = { ...draftPayload, end: endPoint };
    await this.updateSession(to, BotStep.SEARCH_TIME, payload);

    return this.waService.sendButtons(
      to,
      `✅ *From:* ${draftPayload.start.name}\n✅ *To:* ${endPoint.name}\n\n🕒 *When do you want to travel?*\nTap *Leaving Now* or type a time (e.g. *6:30 PM* or *Tomorrow 9 AM*):`,
      [
        { id: 'TIME_NOW', title: '⚡ Leaving Now' },
        { id: 'ACTION_FIND_RIDE', title: '🔄 Change Route' },
      ]
    );
  }

  private async handleSearchTime(to: string, userId: string, text: string, payload: any) {
    // Parse time text (basic relative parser or default to now)
    const departureTime = new Date();
    // If text contains time like "7 pm" or "19:00", we can parse or default to next 30 mins
    return this.handleSearchTimeInput(to, userId, payload, departureTime);
  }

  private async handleSearchTimeInput(to: string, userId: string, payload: any, departureTime: Date) {
    await this.waService.sendText(to, `🔍 Searching active rides matching your route... ⏳`);

    try {
      const searchDto = {
        start: { lat: payload.start.lat, lng: payload.start.lng },
        end: { lat: payload.end.lat, lng: payload.end.lng },
        startTime: departureTime.toISOString(),
        seats: 1,
        startRadiusMeters: 5000,
        endRadiusMeters: 5000,
        timeWindowMinutes: 90,
      };

      const results = await this.matchmaking.search(searchDto as any, userId);
      const offeredRides = (results as any)?.offeredRides || [];

      if (!offeredRides || offeredRides.length === 0) {
        await this.resetSession(to);
        return this.waService.sendButtons(
          to,
          `😔 No direct carpool rides found right now from *${payload.start.name}* to *${payload.end.name}*.\n\nWould you like to post a ride request so drivers can see you, or search again?`,
          [
            { id: 'ACTION_FIND_RIDE', title: '🔍 Search Again' },
            { id: 'ACTION_OFFER_RIDE', title: '🚗 Offer Ride' },
          ]
        );
      }

      // Format WhatsApp List Picker (top 5 rides)
      const listRows = offeredRides.slice(0, 5).map((ride: any) => {
        const fare = ride.fareAmount ? `₹${ride.fareAmount}` : `₹${Math.round(ride.chargeCents / 100)}`;
        const driver = ride.driverName || 'Verified Driver';
        const timeStr = new Date(ride.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const seats = `${ride.seatsAvailable} seat${ride.seatsAvailable > 1 ? 's' : ''}`;

        return {
          id: `BOOK_RIDE_${ride.id}`,
          title: `${driver} (${fare})`,
          description: `🕒 ${timeStr} | ${ride.vehicleType || 'Car'} | ${seats} left`,
        };
      });

      // Save search context in session for booking
      await this.updateSession(to, BotStep.IDLE, { ...payload, departureTime: departureTime.toISOString() });

      return this.waService.sendList(
        to,
        `Found *${offeredRides.length} matching ride(s)* for you! 🚗\n\nTap below to view details and select a ride:`,
        '👉 Choose Ride',
        [
          {
            title: 'Available Rides',
            rows: listRows,
          },
        ],
        '🚗 Available Carpools'
      );
    } catch (err: any) {
      this.logger.error(`Error during WhatsApp ride search: ${err?.message}`);
      await this.resetSession(to);
      return this.waService.sendText(
        to,
        `⚠️ Sorry, an error occurred while searching for rides. Please type *menu* to try again.`
      );
    }
  }

  private async handleBookRideSelection(to: string, userId: string, rideId: string, searchPayload: any) {
    await this.waService.sendText(to, `⏳ Sending your ride request to the driver...`);

    try {
      const ride = await this.prisma.ride.findUnique({
        where: { id: rideId },
        include: { driver: true },
      });

      if (!ride) {
        return this.waService.sendText(to, `⚠️ This ride is no longer available. Please search again.`);
      }

      const riderStartName = searchPayload?.start?.name || ride.startPlaceName;
      const riderEndName = searchPayload?.end?.name || ride.endPlaceName;
      const riderStart = searchPayload?.start ? { lat: searchPayload.start.lat, lng: searchPayload.start.lng } : { lat: 12.9716, lng: 77.5946 };
      const riderEnd = searchPayload?.end ? { lat: searchPayload.end.lat, lng: searchPayload.end.lng } : { lat: 12.9352, lng: 77.6245 };

      const requestDto = {
        rideId: ride.id,
        riderStart,
        riderEnd,
        riderStartName,
        riderEndName,
        riderStartTime: ride.startTime.toISOString(),
        seats: 1,
        fareCents: ride.chargeCents,
      };

      const createdRequest = await this.matchmaking.requestRide(requestDto as any, userId);

      await this.resetSession(to);

      const driverName = ride.driver?.name || 'Driver';
      const fareRs = Math.round(ride.chargeCents / 100);

      return this.waService.sendButtons(
        to,
        `🎉 *Ride Requested Successfully!*\n\n` +
          `👤 *Driver:* ${driverName}\n` +
          `🚗 *Vehicle:* ${ride.vehicleType} (${ride.vehicleNumber || 'Registered'})\n` +
          `💰 *Estimated Fare:* ₹${fareRs}\n` +
          `📍 *From:* ${riderStartName}\n` +
          `🏁 *To:* ${riderEndName}\n\n` +
          `We have notified ${driverName} on their app. Once accepted, you'll receive a confirmation with OTP here! 🚀`,
        [
          { id: 'ACTION_MY_RIDES', title: '📋 View Status' },
          { id: 'ACTION_FIND_RIDE', title: '🔍 Search More' },
        ]
      );
    } catch (err: any) {
      this.logger.error(`Failed to book ride from WhatsApp: ${err?.message}`);
      return this.waService.sendText(
        to,
        `⚠️ Could not complete booking: ${err?.message || 'Something went wrong.'}\nType *menu* to return.`
      );
    }
  }

  // ==========================================
  // DRIVER OFFER RIDE FLOW
  // ==========================================

  private async handleOfferOrigin(to: string, incoming: any, draftPayload: any) {
    let startPoint: { lat: number; lng: number; name: string } | null = null;

    if (incoming.location) {
      const name = await this.geocoding.reverseGeocode(incoming.location.latitude, incoming.location.longitude);
      startPoint = { lat: incoming.location.latitude, lng: incoming.location.longitude, name };
    } else if (incoming.text) {
      const geo = await this.geocoding.geocode(incoming.text);
      if (geo) startPoint = { lat: geo.lat, lng: geo.lng, name: geo.formattedAddress };
    }

    if (!startPoint) {
      return this.waService.sendText(to, `⚠️ Please specify your starting location (or send a location pin).`);
    }

    await this.updateSession(to, BotStep.OFFER_DEST, { ...draftPayload, start: startPoint });
    return this.waService.sendLocationPrompt(
      to,
      `✅ *Start:* ${startPoint.name}\n\n🏁 *Where are you driving to?* (Type destination address or send pin)`
    );
  }

  private async handleOfferDest(to: string, incoming: any, draftPayload: any) {
    let endPoint: { lat: number; lng: number; name: string } | null = null;

    if (incoming.location) {
      const name = await this.geocoding.reverseGeocode(incoming.location.latitude, incoming.location.longitude);
      endPoint = { lat: incoming.location.latitude, lng: incoming.location.longitude, name };
    } else if (incoming.text) {
      const geo = await this.geocoding.geocode(incoming.text);
      if (geo) endPoint = { lat: geo.lat, lng: geo.lng, name: geo.formattedAddress };
    }

    if (!endPoint) {
      return this.waService.sendText(to, `⚠️ Please specify your destination address.`);
    }

    await this.updateSession(to, BotStep.OFFER_TIME, { ...draftPayload, end: endPoint });
    return this.waService.sendText(
      to,
      `✅ *From:* ${draftPayload.start.name}\n✅ *To:* ${endPoint.name}\n\n🕒 *What time are you leaving?*\n(e.g., reply with *Now*, *6:30 PM*, or *Tomorrow 8:00 AM*)`
    );
  }

  private async handleOfferTime(to: string, text: string, draftPayload: any) {
    const startTime = new Date();
    // Default 1 hour later for endTime
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    await this.updateSession(to, BotStep.OFFER_SEATS, {
      ...draftPayload,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    });

    return this.waService.sendButtons(
      to,
      `💺 *How many empty seats do you have available?*`,
      [
        { id: 'SEATS_1', title: '1 Seat' },
        { id: 'SEATS_2', title: '2 Seats' },
        { id: 'SEATS_3', title: '3 Seats' },
      ]
    );
  }

  private async handleOfferSeats(to: string, text: string, draftPayload: any) {
    let seats = 1;
    if (text.includes('2') || text === 'SEATS_2') seats = 2;
    if (text.includes('3') || text === 'SEATS_3') seats = 3;
    if (text.includes('4')) seats = 4;

    await this.updateSession(to, BotStep.OFFER_PRICE, { ...draftPayload, seatsAvailable: seats });

    return this.waService.sendText(
      to,
      `💰 *How much would you like to charge per seat in INR?* (e.g. *150* or *50*)`
    );
  }

  private async handleOfferPrice(to: string, driverId: string, text: string, draftPayload: any) {
    const cleanPrice = parseInt(text.replace(/[^0-9]/g, ''), 10) || 100;
    const chargeCents = cleanPrice * 100;

    await this.waService.sendText(to, `⏳ Publishing your ride...`);

    try {
      const publishDto = {
        start: { lat: draftPayload.start.lat, lng: draftPayload.start.lng },
        end: { lat: draftPayload.end.lat, lng: draftPayload.end.lng },
        startPlaceName: draftPayload.start.name,
        endPlaceName: draftPayload.end.name,
        startTime: draftPayload.startTime,
        endTime: draftPayload.endTime,
        seatsAvailable: draftPayload.seatsAvailable || 1,
        chargeCents,
        vehicleType: 'CAR',
        fuelType: 'Petrol',
        role: 'OFFERED',
        route: [
          { lat: draftPayload.start.lat, lng: draftPayload.start.lng },
          { lat: draftPayload.end.lat, lng: draftPayload.end.lng },
        ],
      };

      const published = await this.ridesService.publishRide(publishDto as any, driverId);

      await this.resetSession(to);

      return this.waService.sendButtons(
        to,
        `🚗 *Your Ride is Live!*\n\n` +
          `📍 *From:* ${draftPayload.start.name}\n` +
          `🏁 *To:* ${draftPayload.end.name}\n` +
          `💺 *Seats:* ${draftPayload.seatsAvailable}\n` +
          `💰 *Fare:* ₹${cleanPrice} / seat\n\n` +
          `Riders on the *Mobile App*, *Web*, and *WhatsApp* can now find and request your ride. You'll receive an instant notification when someone books! 🔔`,
        [
          { id: 'ACTION_MY_RIDES', title: '📋 My Rides' },
          { id: 'ACTION_FIND_RIDE', title: '🔍 Find Ride' },
        ]
      );
    } catch (err: any) {
      this.logger.error(`Failed to publish ride from WhatsApp: ${err?.message}`);
      await this.resetSession(to);
      return this.waService.sendText(
        to,
        `⚠️ Failed to publish ride: ${err?.message || 'Please check your inputs'}.\nType *menu* to restart.`
      );
    }
  }

  // ==========================================
  // MY RIDES & STATUS
  // ==========================================

  private async handleMyRides(to: string, userId: string) {
    const activeRequests = await this.prisma.rideRequest.findMany({
      where: {
        riderId: userId,
        status: { in: [RideStatus.REQUESTED, RideStatus.ACCEPTED, RideStatus.STARTED] },
      },
      include: {
        ride: {
          include: { driver: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    const activePublishedRides = await this.prisma.ride.findMany({
      where: {
        driverId: userId,
        status: { in: [RideStatus.OPEN, RideStatus.REQUESTED, RideStatus.ACCEPTED, RideStatus.STARTED] },
      },
      include: {
        requests: {
          include: { rider: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    if (activeRequests.length === 0 && activePublishedRides.length === 0) {
      return this.waService.sendButtons(
        to,
        `You don't have any active rides or bookings right now.`,
        [
          { id: 'ACTION_FIND_RIDE', title: '🔍 Find a Ride' },
          { id: 'ACTION_OFFER_RIDE', title: '🚗 Offer a Ride' },
        ]
      );
    }

    let msg = `📋 *Your Active Rides:*\n\n`;

    if (activeRequests.length > 0) {
      msg += `*Rider Bookings:*\n`;
      activeRequests.forEach((req, idx) => {
        const statusEmoji = req.status === RideStatus.ACCEPTED ? '✅ Confirmed' : req.status === RideStatus.STARTED ? '🚗 In Progress' : '⏳ Pending';
        const otpText = req.otp ? ` | *OTP:* ${req.otp}` : '';
        msg += `${idx + 1}. *${req.riderStartName}* ➡️ *${req.riderEndName}*\n`;
        msg += `   Status: ${statusEmoji}${otpText}\n`;
        msg += `   Driver: ${req.ride?.driver?.name || 'Assigned Driver'}\n\n`;
      });
    }

    if (activePublishedRides.length > 0) {
      msg += `*Rides You Are Driving:*\n`;
      activePublishedRides.forEach((ride, idx) => {
        msg += `${idx + 1}. *${ride.startPlaceName}* ➡️ *${ride.endPlaceName}*\n`;
        msg += `   Seats left: ${ride.seatsAvailable} | Status: ${ride.status}\n`;
        msg += `   Requests: ${ride.requests.length} rider(s)\n\n`;
      });
    }

    return this.waService.sendButtons(
      to,
      msg,
      [
        { id: 'ACTION_FIND_RIDE', title: '🔍 New Ride' },
        { id: 'ACTION_OFFER_RIDE', title: '🚗 Offer Ride' },
      ]
    );
  }
}
