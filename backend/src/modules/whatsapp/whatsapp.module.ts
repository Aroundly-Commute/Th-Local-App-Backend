import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppBotService } from './whatsapp-bot.service';
import { GeocodingService } from './geocoding.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MatchmakingModule } from '../matchmaking/matchmaking.module';
import { RidesModule } from '../rides/rides.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => MatchmakingModule),
    forwardRef(() => RidesModule),
  ],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WhatsAppBotService, GeocodingService],
  exports: [WhatsAppService, WhatsAppBotService, GeocodingService],
})
export class WhatsAppModule {}
