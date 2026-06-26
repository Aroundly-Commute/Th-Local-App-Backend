import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { RidesModule } from './modules/rides/rides.module';
import { MatchmakingModule } from './modules/matchmaking/matchmaking.module';
import { StorageModule } from './modules/storage/storage.module';
import { ParkingModule } from './modules/parking/parking.module';
import { LocationsModule } from './modules/locations/locations.module';
import { SustainabilityModule } from './modules/sustainability/sustainability.module';
import { ChatModule } from './modules/chat/chat.module';
import { SavedPlacesModule } from './modules/saved-places/saved-places.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    RidesModule,
    MatchmakingModule,
    StorageModule,
    ParkingModule,
    LocationsModule,
    SustainabilityModule,
    ChatModule,
    SavedPlacesModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
