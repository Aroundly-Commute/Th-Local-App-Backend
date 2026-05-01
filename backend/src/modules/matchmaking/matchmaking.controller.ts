import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards, Request } from '@nestjs/common';
import { MatchmakingService } from './matchmaking.service';
import { SearchMatchesDto } from './dto/search-matches.dto';
import { RequestRideDto } from './dto/request-ride.dto';
import { RideStatus } from '@prisma/client';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Controller('matchmaking')
@UseGuards(FirebaseAuthGuard)
export class MatchmakingController {
  constructor(private readonly mm: MatchmakingService) {}

  @Post('search')
  async search(@Request() req, @Body() dto: SearchMatchesDto) {
    return this.mm.search(dto, req.user.id);
  }

  @Post('request')
  async requestRide(@Request() req, @Body() dto: RequestRideDto) {
    return this.mm.requestRide(dto, req.user.id);
  }

  @Get('requests')
  async listRequests(@Request() req, @Query('rideId') rideId?: string) {
    return this.mm.listRequests(rideId, req.user.id);
  }

  @Patch('requests/:id')
  async updateRequest(@Param('id') id: string, @Body() body: { status: RideStatus }) {
    return this.mm.updateRequestStatus(id, body.status);
  }
}

