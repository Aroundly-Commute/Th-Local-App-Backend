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

  @Get('requests/received')
  async listReceivedRequests(@Request() req: any) {
    return this.mm.listReceivedRequests(req.user.id);
  }

  @Patch('requests/:id')
  async updateRequest(
    @Param('id') id: string,
    @Body() body: { status: RideStatus },
    @Request() req: any,
  ) {
    return this.mm.updateRequestStatus(id, body.status, req.user.id);
  }

  @Patch('requests/:id/start')
  async startRideRequest(
    @Param('id') id: string,
    @Body() body: { otp: string },
    @Request() req: any,
  ) {
    return this.mm.startRideRequest(id, body.otp, req.user.id);
  }

  @Patch('requests/:id/complete')
  async completeRideRequest(
    @Param('id') id: string,
    @Body() body: { actualFare?: number },
    @Request() req: any,
  ) {
    return this.mm.completeRideRequest(id, body.actualFare, req.user.id);
  }

  @Patch('buddies/:id')
  async updateBuddyRequest(
    @Param('id') id: string,
    @Body() body: { status: string },
    @Request() req: any,
  ) {
    return this.mm.updateBuddyRequestStatus(id, body.status, req.user.id);
  }

  @Post('buddies')
  async createBuddyRequest(@Request() req: any, @Body() body: any) {
    return this.mm.createBuddyRequest(body, req.user.id);
  }

  @Post('buddies/request')
  async requestBuddyMatch(@Request() req: any, @Body() body: { buddyRequestId: string }) {
    return this.mm.requestBuddyMatch(body.buddyRequestId, req.user.id);
  }

  @Post('invite')
  async invitePassenger(@Request() req: any, @Body() body: { rideId: string; buddyRequestId: string }) {
    return this.mm.inviteBuddy(body, req.user.id);
  }

  @Get('buddies/:id')
  async getBuddyRequest(@Param('id') id: string) {
    return this.mm.getBuddyRequest(id);
  }

  @Get('buddies')
  async listBuddyRequests(
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : undefined;
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    return this.mm.listBuddyRequests(req.user.id, pageNum, limitNum);
  }
}

