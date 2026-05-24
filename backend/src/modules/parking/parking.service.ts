import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ParkingSlotType, BookingStatus } from '@prisma/client';
import { ChatService } from '../chat/chat.service';

@Injectable()
export class ParkingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
  ) {}

  // Automatically seed the 90 spots on startup if they don't exist
  async onModuleInit() {
    console.log('[PARKING] Initializing parking master spots...');
    try {
      await this.setupSpots();
    } catch (err) {
      console.error('[PARKING] Failed to seed parking spots:', err);
    }
  }

  async setupSpots() {
    const count = await this.prisma.parkingSpot.count();
    if (count > 0) {
      console.log(`[PARKING] Spots already initialized (${count} spots found).`);
      return { message: 'Spots already initialized', count };
    }

    const spotsData: any[] = [];
    for (let level = 1; level <= 5; level++) {
      // Left spots (3 vertical stacked spots)
      for (let r = 1; r <= 3; r++) {
        spotsData.push({
          spotName: `L${level}-LEFT-${r}`,
          level,
          section: 'LEFT',
          row: r,
          col: 1,
        });
      }
      // Middle spots (4 columns x 3 rows grid)
      for (let r = 1; r <= 3; r++) {
        for (let c = 1; c <= 4; c++) {
          spotsData.push({
            spotName: `L${level}-MID-${r}-${c}`,
            level,
            section: 'MIDDLE',
            row: r,
            col: c,
          });
        }
      }
      // Right spots (3 vertical stacked spots)
      for (let r = 1; r <= 3; r++) {
        spotsData.push({
          spotName: `L${level}-RIGHT-${r}`,
          level,
          section: 'RIGHT',
          row: r,
          col: 1,
        });
      }
    }

    await this.prisma.parkingSpot.createMany({ data: spotsData });
    console.log(`[PARKING] Successfully seeded ${spotsData.length} master parking spots.`);
    return { message: 'Successfully seeded 90 spots', count: spotsData.length };
  }

  // Register a spot under an owner
  async registerSpot(userId: string, spotName: string) {
    const spot = await this.prisma.parkingSpot.findUnique({
      where: { spotName },
    });

    if (!spot) {
      throw new NotFoundException('Spot does not exist in the master grid.');
    }

    if (spot.ownerId) {
      throw new BadRequestException('This spot is already registered by an owner.');
    }

    // Assign owner and auto-approve in development environment for immediate testing
    return this.prisma.parkingSpot.update({
      where: { spotName },
      data: {
        ownerId: userId,
        approved: true,
      },
    });
  }

  // Fetch all spots registered by the logged-in owner
  async getMySpots(userId: string) {
    return this.prisma.parkingSpot.findMany({
      where: { ownerId: userId },
      include: {
        availabilities: true,
      },
      orderBy: { spotName: 'asc' },
    });
  }

  // Set availability for an owned spot
  async addAvailability(
    userId: string,
    spotId: string,
    dto: {
      date: string;
      slotType: ParkingSlotType;
      startTime: string;
      endTime: string;
      price: number;
    },
  ) {
    const spot = await this.prisma.parkingSpot.findUnique({
      where: { id: spotId },
    });

    if (!spot || spot.ownerId !== userId) {
      throw new BadRequestException('You do not own this spot or it does not exist.');
    }

    if (!spot.approved) {
      throw new BadRequestException('This spot is still awaiting admin approval.');
    }

    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);

    // Double check overlap
    const overlap = await this.prisma.parkingAvailability.findFirst({
      where: {
        spotId,
        date: dto.date,
        slotType: dto.slotType,
        startTime: { lt: end },
        endTime: { gt: start },
      },
    });

    if (overlap) {
      throw new BadRequestException('This spot already has overlapping availability defined.');
    }

    return this.prisma.parkingAvailability.create({
      data: {
        spotId,
        date: dto.date,
        slotType: dto.slotType,
        startTime: start,
        endTime: end,
        price: dto.price,
      },
    });
  }

  // Fetch all booking requests made to the owner's spots
  async getMySpotRequests(userId: string) {
    // Delete expired pending requests
    await this.prisma.parkingBooking.deleteMany({
      where: {
        status: BookingStatus.REQUESTED,
        endTime: { lt: new Date() },
      },
    });

    return this.prisma.parkingBooking.findMany({
      where: {
        spot: { ownerId: userId },
      },
      include: {
        spot: true,
        user: {
          select: { id: true, name: true, email: true, phoneNumber: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Accept or reject a booking request
  async updateBookingStatus(userId: string, bookingId: string, status: BookingStatus) {
    const booking = await this.prisma.parkingBooking.findUnique({
      where: { id: bookingId },
      include: { spot: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking request not found.');
    }

    if (booking.spot.ownerId !== userId) {
      throw new BadRequestException('You are not the owner of this parking spot.');
    }

    const updatedBooking = await this.prisma.parkingBooking.update({
      where: { id: bookingId },
      data: { status },
    });

    if (status === BookingStatus.ACCEPTED) {
      // Mark corresponding availability as booked
      if (booking.availabilityId) {
        await this.prisma.parkingAvailability.update({
          where: { id: booking.availabilityId },
          data: { isBooked: true },
        });
      }
    } else if (status === BookingStatus.REJECTED || status === BookingStatus.CANCELLED) {
      // Free up if was previously booked
      if (booking.availabilityId) {
        await this.prisma.parkingAvailability.update({
          where: { id: booking.availabilityId },
          data: { isBooked: false },
        });
      }
    }

    // Notify the visitor who made the booking request
    this.chatService.notifyUserWs(booking.userId, 'parking_booking_status_updated', {
      id: updatedBooking.id,
      spotId: updatedBooking.spotId,
      spotName: booking.spot.spotName,
      status: updatedBooking.status,
    });

    return updatedBooking;
  }

  // Fetch the current grid state of all 90 spots with their availability and bookings
  async getParkingGridState(date: string, slotType: ParkingSlotType) {
    // Delete expired pending requests
    await this.prisma.parkingBooking.deleteMany({
      where: {
        status: BookingStatus.REQUESTED,
        endTime: { lt: new Date() },
      },
    });

    const spots = await this.prisma.parkingSpot.findMany({
      include: {
        owner: {
          select: { name: true, email: true, phoneNumber: true },
        },
        availabilities: true,
        bookings: {
          include: {
            user: {
              select: { id: true, name: true, email: true },
            },
          },
        },
      },
      orderBy: { spotName: 'asc' },
    });

    const now = new Date();
    return spots.map((s) => ({
      ...s,
      bookings: s.bookings.map((b) => {
        if (b.status === BookingStatus.ACCEPTED && b.endTime < now) {
          return { ...b, status: 'EXPIRED' as any };
        }
        return b;
      }),
    }));
  }

  // Request a booking for a spot
  async requestBooking(
    userId: string,
    dto: {
      spotId: string;
      availabilityId?: string;
      date: string;
      slotType: ParkingSlotType;
      startTime: string;
      endTime: string;
      price: number;
    },
  ) {
    // If an availabilityId is supplied, check that it exists, matches, and is not already booked
    if (dto.availabilityId) {
      const avail = await this.prisma.parkingAvailability.findUnique({
        where: { id: dto.availabilityId },
        include: { spot: true },
      });

      if (!avail) {
        throw new NotFoundException('Selected availability slot was not found.');
      }

      if (avail.isBooked) {
        throw new BadRequestException('This slot has already been reserved.');
      }
    }

    // Create the booking request (starts in REQUESTED status)
    const booking = await this.prisma.parkingBooking.create({
      data: {
        spotId: dto.spotId,
        availabilityId: dto.availabilityId || null,
        userId,
        date: dto.date,
        slotType: dto.slotType,
        startTime: new Date(dto.startTime),
        endTime: new Date(dto.endTime),
        price: dto.price,
        status: BookingStatus.REQUESTED,
      },
    });

    // Notify the spot owner in real-time
    const spot = await this.prisma.parkingSpot.findUnique({
      where: { id: dto.spotId },
      select: { ownerId: true, spotName: true },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });

    if (spot && spot.ownerId) {
      this.chatService.notifyUserWs(spot.ownerId, 'new_parking_booking_request', {
        id: booking.id,
        spotId: booking.spotId,
        spotName: spot.spotName,
        visitorName: user?.name || 'A visitor',
        date: booking.date,
        status: booking.status,
      });
    }

    return booking;
  }

  // Fetch all bookings/tickets placed by the logged-in passenger
  async getMyBookings(userId: string) {
    // Delete expired pending requests
    await this.prisma.parkingBooking.deleteMany({
      where: {
        userId,
        status: BookingStatus.REQUESTED,
        endTime: { lt: new Date() },
      },
    });

    const bookings = await this.prisma.parkingBooking.findMany({
      where: { userId },
      include: {
        spot: {
          include: {
            owner: {
              select: { name: true, email: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    return bookings.map((bk) => {
      if (bk.status === BookingStatus.ACCEPTED && bk.endTime < now) {
        return { ...bk, status: 'EXPIRED' as any };
      }
      return bk;
    });
  }
}
