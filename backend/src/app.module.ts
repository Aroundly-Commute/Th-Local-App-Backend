import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RidesModule } from './modules/rides/rides.module';
import { MatchmakingModule } from './modules/matchmaking/matchmaking.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { AuthController } from './modules/auth/auth.controller';
import { AliasController } from './alias.controller';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { StorageModule } from './modules/storage/storage.module';
import { ParkingModule } from './modules/parking/parking.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RidesModule,
    MatchmakingModule,
    MarketplaceModule,
    StorageModule,
    ParkingModule,
  ],
  controllers: [AuthController, AliasController, AppController],
})
export class AppModule {}
