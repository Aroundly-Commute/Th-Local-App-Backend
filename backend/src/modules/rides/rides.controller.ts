import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, Request } from '@nestjs/common';
import { PublishRideDto } from './dto/publish-ride.dto';
import { RidesService } from './rides.service';
import { RideStatus } from '@prisma/client';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Controller('rides')
@UseGuards(FirebaseAuthGuard)
export class RidesController {
  constructor(private readonly rides: RidesService) {}

  @Post()
  async publish(@Request() req, @Body() dto: PublishRideDto) {
    return this.rides.publishRide(dto, req.user.id);
  }

  @Get()
  async list(@Request() req, @Query('status') status?: RideStatus) {
    return this.rides.listRides(status, undefined, req.user.id);
  }

  @Get(':id')
  async get(@Request() req, @Param('id') id: string) {
    return this.rides.getRide(id, req.user.id);
  }

  @Patch(':id/status')
  async setStatus(@Param('id') id: string, @Body() body: { status: RideStatus }) {
    return this.rides.setRideStatus(id, body.status);
  }
}
