import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, Request } from '@nestjs/common';
import { ParkingService } from './parking.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { ParkingSlotType, BookingStatus } from '@prisma/client';

@Controller('parking')
@UseGuards(FirebaseAuthGuard)
export class ParkingController {
  constructor(private readonly parkingService: ParkingService) {}

  // Trigger manual initialization of master spots (or let the auto-seeder do it)
  @Post('setup-spots')
  async setupSpots() {
    return this.parkingService.setupSpots();
  }

  // Register an owner spot
  @Post('register')
  async registerSpot(@Request() req, @Body() body: { spotName: string }) {
    return this.parkingService.registerSpot(req.user.id, body.spotName);
  }

  // Get all spots registered by the owner
  @Get('my-spots')
  async getMySpots(@Request() req) {
    return this.parkingService.getMySpots(req.user.id);
  }

  // Set availability for a registered owner spot
  @Post('my-spots/:id/availability')
  async addAvailability(
    @Request() req,
    @Param('id') spotId: string,
    @Body()
    body: {
      date: string;
      slotType: ParkingSlotType;
      startTime: string;
      endTime: string;
      price: number;
    },
  ) {
    return this.parkingService.addAvailability(req.user.id, spotId, body);
  }

  // Get booking requests made to the owner's spots
  @Get('my-spots/requests')
  async getMySpotRequests(@Request() req) {
    return this.parkingService.getMySpotRequests(req.user.id);
  }

  // Accept or reject a booking request
  @Patch('bookings/:id/status')
  async updateBookingStatus(
    @Request() req,
    @Param('id') bookingId: string,
    @Body() body: { status: BookingStatus },
  ) {
    return this.parkingService.updateBookingStatus(req.user.id, bookingId, body.status);
  }

  // Query live grid state with availabilities and bookings
  @Get('grid-state')
  async getParkingGridState(
    @Query('date') date: string,
    @Query('slotType') slotType: ParkingSlotType,
  ) {
    return this.parkingService.getParkingGridState(date, slotType);
  }

  // Request a booking for a slot
  @Post('bookings')
  async requestBooking(
    @Request() req,
    @Body()
    body: {
      spotId: string;
      availabilityId?: string;
      date: string;
      slotType: ParkingSlotType;
      startTime: string;
      endTime: string;
      price: number;
    },
  ) {
    return this.parkingService.requestBooking(req.user.id, body);
  }

  // Get bookings made by the passenger/current booker
  @Get('my-bookings')
  async getMyBookings(@Request() req) {
    return this.parkingService.getMyBookings(req.user.id);
  }

  // Update a parking spot's default prices
  @Patch('my-spots/:id/prices')
  async updateSpotPrices(
    @Request() req,
    @Param('id') spotId: string,
    @Body()
    body: {
      priceHourly: number;
      priceDaily: number;
      priceWeekly: number;
      priceMonthly: number;
    },
  ) {
    return this.parkingService.updateSpotPrices(req.user.id, spotId, body);
  }

  // Get ticket by ID for scanning / deep link viewing
  @Get('ticket/:id')
  async getTicketById(@Param('id') id: string) {
    return this.parkingService.getTicketById(id);
  }
}

