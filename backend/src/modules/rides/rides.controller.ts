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
  async setStatus(@Param('id') id: string, @Body() body: { status: RideStatus }) {
    return this.rides.setRideStatus(id, body.status);
  }

  @Post(':id/book')
  async bookRide(@Param('id') id: string, @Body() body: any, @Request() req: any) {
    return this.rides.bookRide(id, req.user.id, body);
  }
}
