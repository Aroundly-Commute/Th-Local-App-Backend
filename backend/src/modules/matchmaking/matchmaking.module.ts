import { Module } from '@nestjs/common';
import { MatchmakingController } from './matchmaking.controller';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingGateway } from './matchmaking.gateway';

@Module({
  controllers: [MatchmakingController],
  providers: [MatchmakingService, MatchmakingGateway],
})
export class MatchmakingModule {}

