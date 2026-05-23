import { Module } from '@nestjs/common';
import { MatchmakingController } from './matchmaking.controller';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingGateway } from './matchmaking.gateway';
import { PrismaModule } from '../prisma/prisma.module';
import { ChatModule } from '../chat/chat.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, ChatModule, AuthModule],
  controllers: [MatchmakingController],
  providers: [MatchmakingService, MatchmakingGateway],
  exports: [MatchmakingService],
})
export class MatchmakingModule {}
