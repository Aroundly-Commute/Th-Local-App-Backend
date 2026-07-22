import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, Request } from '@nestjs/common';
import { PublishRideDto } from './dto/publish-ride.dto';
import { CreateRecurringRideDto } from './dto/create-recurring-ride.dto';
import { RidesService } from './rides.service';
import { RideStatus } from '@prisma/client';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Controller('rides')
@UseGuards(FirebaseAuthGuard)
export class RidesController {
  constructor(private readonly rides: RidesService) {}

  @Post()
  async publish(@Request() req: any, @Body() dto: PublishRideDto) {
    return this.rides.publishRide(dto, req.user.id);
  }

  @Get()
  async list(
    @Request() req: any,
    @Query('status') status?: RideStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('latitude') latitude?: string,
    @Query('longitude') longitude?: string,
    @Query('radius') radius?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : undefined;
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const latNum = latitude ? parseFloat(latitude) : undefined;
    const lngNum = longitude ? parseFloat(longitude) : undefined;
    const radNum = radius ? parseFloat(radius) : undefined;
    return this.rides.listRides(status, undefined, req.user.id, pageNum, limitNum, latNum, lngNum, radNum);
  }

  @Get('my')
  async getMyRides(
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : undefined;
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    return this.rides.getMyRides(req.user.id, pageNum, limitNum);
  }

  @Post('offer')
  async offerRide(@Body() body: any, @Request() req: any) {
    return this.rides.offerRide(body, req.user.id);
  }

  @Get(':id')
  async get(@Request() req: any, @Param('id') id: string) {
    return this.rides.getRide(id, req.user.id);
  }

  @Patch(':id/status')
  async setStatus(@Param('id') id: string, @Body() body: { status: RideStatus }, @Request() req: any) {
    return this.rides.setRideStatus(id, body.status, req.user.id);
  }

  @Post(':id/book')
  async bookRide(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.rides.bookRide(id, req.user.id, body);
  }

  @Post('recurring')
  async createRecurringSchedule(@Request() req: any, @Body() dto: CreateRecurringRideDto) {
    return this.rides.createRecurringSchedule(dto, req.user.id);
  }

  @Get('recurring')
  async getRecurringSchedules(@Request() req: any) {
    return this.rides.getRecurringSchedules(req.user.id);
  }

  @Patch('recurring/:id')
  async updateRecurringSchedule(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: { daysOfWeek?: number[]; timeOfDay?: string; seatsAvailable?: number; chargeCents?: number; isActive?: boolean }
  ) {
    return this.rides.updateRecurringSchedule(id, req.user.id, body);
  }

  @Delete('recurring/:id')
  async deleteRecurringSchedule(@Request() req: any, @Param('id') id: string) {
    return this.rides.deleteRecurringSchedule(id, req.user.id);
  }

  @Get('recurring/materialize')
  async materializeRecurringRidesGet(@Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : undefined;
    return this.rides.materializeRecurringRides(daysNum);
  }

  @Post('recurring/materialize')
  async materializeRecurringRidesPost(@Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : undefined;
    return this.rides.materializeRecurringRides(daysNum);
  }
}
